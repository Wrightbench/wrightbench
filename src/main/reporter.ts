import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { wrightbenchDir } from './settings'

/**
 * Custom Playwright reporter loaded via `--reporter=<path>` (CLI runs) or
 * `PW_TEST_REPORTER=<path>` (embedded UI Mode test server). It runs inside
 * the Playwright process (any Playwright version), so it is plain CJS with
 * no imports from our code.
 *
 * Two transports, selected by environment:
 *  - default: prefixed `WBEVT ` NDJSON on stdout, parsed by runner.ts.
 *  - UI session: when WRIGHTBENCH_UI_EVENTS_FILE + WRIGHTBENCH_UI_SESSION_ID are
 *    set, events append to that NDJSON file instead. UI Mode's test server
 *    replaces process.stdout.write to mirror output into its own web UI, so
 *    stdout is neither private nor reliable there — the file is both.
 *    Each line carries a protocol version + session id; uisession.ts tails
 *    and validates it. Never both transports at once: WBEVT lines on stdout
 *    would render as garbage in UI Mode's output pane.
 */
const REPORTER_SOURCE = `'use strict'
const fs = require('fs')
const path = require('path')

const UI_FILE = process.env.WRIGHTBENCH_UI_EVENTS_FILE
const UI_SID = process.env.WRIGHTBENCH_UI_SESSION_ID
const INLINE_DIR = process.env.WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR
const uiSession = !!(UI_FILE && UI_SID && path.isAbsolute(UI_FILE))
let uiSeq = 0
let uiWriteFailures = 0

function emit(obj) {
  if (uiSession) {
    if (uiWriteFailures >= 3) return
    try {
      // one appendFileSync per event: the reader only parses complete
      // newline-terminated lines, so a torn write can only lose the tail
      fs.appendFileSync(UI_FILE, JSON.stringify(Object.assign({ v: 2, sid: UI_SID, seq: uiSeq++ }, obj)) + '\\n')
    } catch (err) {
      uiWriteFailures += 1
    }
    return
  }
  process.stdout.write('WBEVT ' + JSON.stringify(obj) + '\\n')
}

class WrightbenchReporter {
  constructor() {
    this.rootDir = process.cwd()
    this.stepSeq = 0
    this.stepIds = new WeakMap()
  }

  decl(test) {
    let project = ''
    if (test.parent) {
      const p = test.parent.project()
      if (p) project = p.name || ''
    }
    const describes = []
    let suite = test.parent
    while (suite) {
      if (suite.type === 'describe' && suite.title) describes.unshift(String(suite.title))
      suite = suite.parent
    }
    // Relative to rootDir (the common ancestor of all testDirs), matching
    // the "test --list" tree paths — NOT the owning project's testDir, which
    // diverges per project when configs override testDir (and would break
    // history lookups keyed by file).
    return {
      file: path.relative(this.rootDir, test.location.file),
      line: test.location.line,
      column: test.location.column,
      title: test.title,
      titlePath: describes.concat([test.title]),
      project
    }
  }

  attempt(test, result) {
    const decl = this.decl(test)
    const retry = Number.isFinite(result && result.retry) ? result.retry : 0
    const workerIndex = Number.isFinite(result && result.workerIndex) ? result.workerIndex : null
    const parallelIndex = Number.isFinite(result && result.parallelIndex) ? result.parallelIndex : null
    const stable = test && test.id ? String(test.id) : decl.file + ':' + decl.line + ':' + decl.title
    return Object.assign({}, decl, {
      attemptId: stable + '|' + decl.project + '|r' + retry + '|w' + (workerIndex === null ? 'x' : workerIndex),
      retry,
      workerIndex,
      parallelIndex
    })
  }

  stepId(step) {
    if (step && step.id) return String(step.id)
    let id = this.stepIds.get(step)
    if (!id) {
      id = 'step-' + (++this.stepSeq)
      this.stepIds.set(step, id)
    }
    return id
  }

  onBegin(config, suite) {
    this.rootDir = config.rootDir || this.rootDir
    const tests = suite.allTests()
    emit({
      type: 'begin',
      total: tests.length,
      workers: config.workers,
      scheduled: tests.map((t) => this.decl(t))
    })
  }

  onTestBegin(test, result) {
    const start = result && result.startTime instanceof Date ? result.startTime.getTime() : Date.now()
    emit(Object.assign({ type: 'test-begin', startedAt: start }, this.attempt(test, result)))
  }

  formatError(test, error) {
    if (!error || !error.message) return undefined
    // display form: no ANSI, no call-log tail, plus a source location line
    let text = String(error.message).replace(/\\u001b\\[[0-9;]*m/g, '')
    const callLog = text.indexOf('\\nCall log:')
    if (callLog !== -1) text = text.slice(0, callLog)
    text = text.replace(/\\s+$/, '')
    let loc = error.location
    if (!loc && typeof error.stack === 'string') {
      const m = error.stack.match(/ at (?:.* \\()?([^()\\n]+):(\\d+):(\\d+)\\)?/)
      if (m) loc = { file: m[1], line: Number(m[2]), column: Number(m[3]) }
    }
    if (loc && loc.file) {
      // rootDir-relative, matching decl() file paths
      text += '\\n\\n  at ' + path.relative(this.rootDir, loc.file) + ':' + loc.line + ':' + loc.column
    }
    return text.slice(0, 2000)
  }

  onStepBegin(test, result, step) {
    const startedAt = step && step.startTime instanceof Date ? step.startTime.getTime() : Date.now()
    emit(Object.assign({
      type: 'step-begin',
      stepId: this.stepId(step),
      parentStepId: step && step.parent ? this.stepId(step.parent) : null,
      stepTitle: String((step && step.title) || '').slice(0, 1000),
      category: String((step && step.category) || '').slice(0, 100),
      startedAt
    }, this.attempt(test, result)))
  }

  onStepEnd(test, result, step) {
    emit(Object.assign({
      type: 'step-end',
      stepId: this.stepId(step),
      duration: Math.max(0, Number((step && step.duration) || 0)),
      error: this.formatError(test, step && step.error)
    }, this.attempt(test, result)))
  }

  stdio(stream, chunk, test, result) {
    let text
    try {
      text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    } catch {
      return
    }
    if (!text) return
    const payload = { type: 'stdio', stream, text: text.slice(0, 8192), timestamp: Date.now() }
    emit(test && result ? Object.assign(payload, this.attempt(test, result)) : payload)
  }

  onStdOut(chunk, test, result) {
    this.stdio('stdout', chunk, test, result)
  }

  onStdErr(chunk, test, result) {
    this.stdio('stderr', chunk, test, result)
  }

  materializeAttachment(attachment, attemptId, index) {
    if (attachment.path) return attachment.path
    if (!attachment.body || !INLINE_DIR || !path.isAbsolute(INLINE_DIR)) return null
    try {
      const dir = path.join(INLINE_DIR, attemptId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120))
      fs.mkdirSync(dir, { recursive: true })
      const ext = attachment.contentType === 'application/json' ? '.json' :
        attachment.contentType === 'text/plain' ? '.txt' : '.bin'
      const file = path.join(dir, String(index + 1).padStart(2, '0') + '-' +
        String(attachment.name || 'attachment').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) + ext)
      fs.writeFileSync(file, attachment.body)
      return file
    } catch {
      return null
    }
  }

  onTestEnd(test, result) {
    const attempt = this.attempt(test, result)
    const attachments = []
    for (const a of (result.attachments || []).slice(0, 50)) {
      const file = this.materializeAttachment(a, attempt.attemptId, attachments.length)
      if (file) attachments.push({ name: a.name || '', contentType: a.contentType || '', path: file })
    }
    const annotations = (test.annotations || []).slice(0, 50).map((a) => ({
      type: String(a.type || '').slice(0, 200),
      description: a.description == null ? null : String(a.description).slice(0, 1000)
    }))
    emit(
      Object.assign(
        {
          type: 'test-end',
          status: result.status,
          outcome: test.outcome(),
          duration: result.duration,
          finishedAt: Date.now(),
          error: this.formatError(test, result.error),
          annotations: annotations.length > 0 ? annotations : undefined,
          attachments: attachments.length > 0 ? attachments : undefined
        },
        attempt
      )
    )
  }

  onEnd(result) {
    emit({ type: 'end', status: result.status })
  }

  onError(error) {
    emit({ type: 'error', message: String((error && error.message) || error).slice(0, 2000) })
  }

  printsToStdio() {
    return false
  }
}

module.exports = WrightbenchReporter
`

let written = false

/** Write the reporter next to our other state and return its absolute path. */
export function reporterPath(): string {
  const file = join(wrightbenchDir(), 'reporter.cjs')
  // users delete ~/.wrightbench to "reset" — re-verify the file each time
  if (!written || !existsSync(file)) {
    mkdirSync(wrightbenchDir(), { recursive: true })
    writeFileSync(file, REPORTER_SOURCE)
    written = true
  }
  return file
}

/** the generated CJS source, exposed so tests can exercise both transports */
export function reporterSource(): string {
  return REPORTER_SOURCE
}

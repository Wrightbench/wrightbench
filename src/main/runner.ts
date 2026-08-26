import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import type { HarnessTarget, RunConfig, RunEvent, RunEventPayload } from '@shared/ipc'
import { aggregate, recordDeclEvent, type RecordedDecl } from './aggregate'
import {
  appendLogRecord,
  beginAttemptRecord,
  beginStepRecord,
  createRun,
  finishAttemptRecord,
  finishRunRecord,
  finishStepRecord,
  setRunStorage
} from './db'
import { beginCliExecution } from './execution'
import { killTree, spawnEnv, trackedSpawn } from './proc'
import { reporterPath } from './reporter'
import {
  archiveAttemptAttachments,
  createRunStorage,
  registerRunReport,
  type RunStorageLayout
} from './artifacts'
import {
  createRuntimeCaptureConfig,
  traceModeForCapture,
  type RuntimeCaptureConfig
} from './capture'
import { loadSettings } from './settings'
import { resolveTargetContext, splitTargetArgs, targetRunLocation } from './targets/context'
import { sanitizeCliProcessEnv } from './pwadapter'

type EventSink = (payload: RunEventPayload) => void

interface ActiveRun {
  runId: string
  /** null while the slot is reserved but the child not yet spawned */
  child: ChildProcess | null
  sawEnd: boolean
  stopRequested: boolean
}

/** one run per project folder at a time */
const runs = new Map<string, ActiveRun>()

const EVENT_PREFIX = 'WBEVT '

function gitLine(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: spawnEnv() })
    let out = ''
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 && out.trim() !== '' ? out.trim() : null)
    })
  })
}

/** short current commit, shared with the UI Mode session recorder */
export function gitShortHash(cwd: string): Promise<string | null> {
  return gitLine(cwd, ['rev-parse', '--short', 'HEAD'])
}

/** first line of the commit message, for the "first failed on <hash>" note */
export function gitCommitSubject(cwd: string, hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return Promise.resolve(null)
  return gitLine(cwd, ['log', '-1', '--format=%s', hash])
}

export async function startRun(
  config: RunConfig,
  target: HarnessTarget,
  env: Record<string, string>,
  send: EventSink
): Promise<{
  runId: string
  historyRunId: number | null
  runNumber: number
  commitHash: string | null
}> {
  const resolved = resolveTargetContext(config.path, target)
  if (!resolved.ok) {
    const message =
      resolved.code === 'outside-workspace'
        ? 'The selected test configuration resolves outside this workspace'
        : resolved.code === 'pnp'
          ? 'Yarn Plug’n’Play test configurations are not supported yet'
          : 'Playwright is not installed for the selected test configuration'
    throw new Error(message)
  }
  const targetContext = resolved.context

  if (runs.has(config.path)) {
    throw new Error('a run is already in progress for this project')
  }

  // reserve the slot BEFORE any await — a second start during gitShortHash
  // must not slip past the guard
  const runId = randomUUID()
  const active: ActiveRun = { runId, child: null, sawEnd: false, stopRequested: false }
  runs.set(config.path, active)

  let releaseExecution: () => void
  try {
    // This reserves the project before the first await, rejects an active UI
    // run, and stops an idle UI Mode server before Playwright is spawned.
    releaseExecution = await beginCliExecution(config.path)
  } catch (err) {
    runs.delete(config.path)
    throw err
  }

  const settings = loadSettings()
  // The HTML reporter is retained as immutable evidence for the contextual
  // run inspector; our reporter supplies the live structured event stream.
  let args: string[]
  let customArgs: string[]
  let runtimeCaptureConfig: RuntimeCaptureConfig | null = null
  try {
    const split = splitTargetArgs(target.extraArgs)
    args = [targetContext.playwright.cliPath, 'test', ...split.options]
    customArgs = split.customArgs
    args.push(`--reporter=html,${reporterPath()}`)
    runtimeCaptureConfig = createRuntimeCaptureConfig(config.path, settings.captureMode, {
      cwd: targetContext.cwd,
      packageDir: targetContext.packageDir,
      configPath: targetContext.configPath
    })
    if (runtimeCaptureConfig) args.push(`--config=${runtimeCaptureConfig.path}`)
    else if (targetContext.configPath) args.push(`--config=${targetContext.configPath}`)
    const traceMode = traceModeForCapture(settings.captureMode, !!config.location)
    args.push(`--trace=${traceMode}`)
    const location = targetRunLocation(targetContext, config.location)
    if (location) args.push(location)
    if (config.lastFailed) args.push('--last-failed')
    if (config.project) args.push(`--project=${config.project}`)
    if (config.grep) args.push('--grep', config.grep)
    if (config.workers) args.push(`--workers=${config.workers}`)
  } catch (err) {
    runtimeCaptureConfig?.cleanup()
    runs.delete(config.path)
    releaseExecution()
    throw err
  }

  const startedAt = Date.now()
  let commitHash: string | null = null
  let record: { id: number; runNumber: number } | null = null
  let storage: RunStorageLayout | null = null
  try {
    commitHash = await gitShortHash(targetContext.cwd)
    // a broken history db must never block running tests
    try {
      record = createRun(
        config.path,
        config.trigger ?? 'manual',
        commitHash,
        startedAt,
        config.project ?? 'all',
        settings.captureMode
      )
      storage = createRunStorage(config.path, record.id)
      setRunStorage(record.id, storage.root, storage.reportDir)
      args.push(`--output=${storage.outputDir}`)
    } catch (err) {
      console.error('failed to record run start:', err)
    }
  } catch (err) {
    runtimeCaptureConfig?.cleanup()
    runs.delete(config.path)
    releaseExecution()
    throw err
  }

  const runEnv = sanitizeCliProcessEnv({
    ...env,
    PLAYWRIGHT_HTML_OUTPUT_DIR: '',
    PLAYWRIGHT_HTML_OPEN: 'never',
    WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR: ''
  })
  if (storage) {
    runEnv.PLAYWRIGHT_HTML_OUTPUT_DIR = storage.reportDir
    runEnv.WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR = storage.inlineDir
  }

  let child: ChildProcess
  try {
    child = trackedSpawn('node', [...args, ...customArgs], targetContext.cwd, runEnv)
  } catch (err) {
    runtimeCaptureConfig?.cleanup()
    runs.delete(config.path)
    releaseExecution()
    throw err
  }
  active.child = child
  if (active.stopRequested) {
    // stop arrived while we were reserving — honor it immediately
    signalInterrupt(child)
  }

  const emit = (event: RunEvent): void =>
    send({
      runId,
      historyRunId: record?.id ?? null,
      runNumber: record?.runNumber ?? 0,
      path: config.path,
      event
    })

  const decls = new Map<string, RecordedDecl>()
  let endStatus: string | null = null
  let logSequence = 0
  let archiveQueue: Promise<void> = Promise.resolve()

  const recordEvent = (event: RunEvent): void => {
    if (event.type === 'end') {
      active.sawEnd = true
      endStatus = event.status
      return
    }
    if (!record) {
      recordDeclEvent(decls, event)
      return
    }
    try {
      if (event.type === 'test-begin') {
        beginAttemptRecord(record.id, event, event.startedAt)
        recordDeclEvent(decls, event)
      } else if (event.type === 'step-begin') {
        beginStepRecord(record.id, event, event)
      } else if (event.type === 'step-end') {
        finishStepRecord(record.id, event, {
          stepId: event.stepId,
          durationMs: event.duration,
          error: event.error ?? null
        })
      } else if (event.type === 'stdio') {
        appendLogRecord(
          record.id,
          event.attemptId ?? null,
          ++logSequence,
          event.stream,
          event.timestamp,
          event.text
        )
      } else if (event.type === 'test-end') {
        archiveQueue = archiveQueue
          .catch((err) => console.error('a previous attempt could not be archived:', err))
          .then(() => {
            try {
              finishAttemptRecord(record!.id, event, {
                finishedAt: event.finishedAt,
                status: event.status,
                durationMs: event.duration,
                error: event.error ?? null,
                annotations: event.annotations ?? []
              })
              const attachments =
                storage && event.attachments
                  ? archiveAttemptAttachments(storage, record!.id, event.attemptId, event.attachments)
                  : (event.attachments ?? [])
              const archivedEvent: RunEvent = { ...event, attachments }
              recordDeclEvent(decls, archivedEvent)
            } catch (err) {
              // One bad attachment must not block this attempt's aggregate or
              // the evidence/finalization of every test reported after it.
              console.error('failed to archive attempt evidence:', err)
              try {
                finishAttemptRecord(record!.id, event, {
                  finishedAt: event.finishedAt,
                  status: event.status,
                  durationMs: event.duration,
                  error: event.error ?? null,
                  annotations: event.annotations ?? []
                })
              } catch (persistError) {
                console.error('failed to finalize attempt record:', persistError)
              }
              recordDeclEvent(decls, event)
            }
          })
      } else {
        recordDeclEvent(decls, event)
      }
    } catch (err) {
      console.error('failed to persist detailed run event:', err)
      recordDeclEvent(decls, event)
    }
  }

  let stdoutBuffer = ''
  const stderrTail: string[] = []

  // stateful utf-8 decoding — Buffer.toString() would corrupt multibyte
  // characters split across pipe-chunk boundaries (unicode test titles)
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let idx = stdoutBuffer.indexOf('\n')
    while (idx !== -1) {
      const line = stdoutBuffer.slice(0, idx)
      stdoutBuffer = stdoutBuffer.slice(idx + 1)
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as RunEvent
          recordEvent(event)
          emit(event)
        } catch {
          // malformed event line — ignore
        }
      }
      idx = stdoutBuffer.indexOf('\n')
    }
  })

  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      // eslint-disable-next-line no-control-regex -- ANSI color codes must not reach the UI
      const trimmed = line.replace(/\[[0-9;]*m/g, '').trim()
      if (trimmed) {
        stderrTail.push(trimmed)
        if (stderrTail.length > 20) stderrTail.shift()
      }
    }
  })

  // 'close' always follows a spawn 'error' — it is the single owner of
  // the finished event so the renderer never sees two
  child.on('error', (err) => {
    emit({ type: 'error', message: err.message })
  })

  child.on('close', (code) => {
    runtimeCaptureConfig?.cleanup()
    if (runs.get(config.path)?.runId === runId) runs.delete(config.path)
    releaseExecution()
    void archiveQueue
      .catch((err) => console.error('failed to archive run evidence:', err))
      .then(() => {
        const results = aggregate(decls)
        const status =
          endStatus ?? (results.length === 0 ? 'error' : code === 0 ? 'passed' : 'failed')
        if (record) {
          try {
            if (storage) registerRunReport(storage, record.id)
            finishRunRecord(record.id, { finishedAt: Date.now(), status, results })
          } catch (err) {
            console.error('failed to persist run:', err)
          }
        }
        emit({
          type: 'finished',
          code,
          // surface stderr only when the process died without a proper report
          stderrTail: !active.sawEnd && code !== 0 ? stderrTail.join('\n') : undefined
        })
      })
  })

  return {
    runId,
    historyRunId: record?.id ?? null,
    runNumber: record?.runNumber ?? 0,
    commitHash
  }
}

function signalInterrupt(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGINT')
    } catch {
      child.kill('SIGINT')
    }
  } else {
    child.kill()
  }
  const escalate = setTimeout(() => killTree(child), 5_000)
  child.once('close', () => clearTimeout(escalate))
}

/** graceful stop: SIGINT (Ctrl-C) lets Playwright report `interrupted`; escalate after 5s */
export function stopRun(runId: string): boolean {
  for (const active of runs.values()) {
    if (active.runId !== runId) continue
    if (active.child === null) {
      // still reserving — the spawn path honors this immediately after
      active.stopRequested = true
      return true
    }
    signalInterrupt(active.child)
    return true
  }
  return false
}

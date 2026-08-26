import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import type { RunEvent, UiModeEvent } from '@shared/ipc'
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
import {
  archiveAttemptAttachments,
  createRunStorage,
  type RunStorageLayout
} from './artifacts'
import { parseUiEventLine } from './pwadapter'
import { gitShortHash } from './runner'
import { loadSettings, wrightbenchDir } from './settings'

/**
 * Ingestion side of the UI Mode reporter side channel: tail the session's
 * NDJSON file and turn reporter events into normal Wrightbench history rows
 * (createRun on begin, finishRunRecord on end) using the exact aggregation
 * the CLI runner uses. The file lives under ~/.wrightbench/ui-events/ — never
 * inside the user's repository.
 */

export function uiEventsDir(): string {
  return join(wrightbenchDir(), 'ui-events')
}

/** crash leftovers: session files are transient, drop anything old at startup */
export function sweepUiEventFiles(maxAgeMs = 24 * 60 * 60 * 1000): void {
  let entries: string[]
  try {
    entries = readdirSync(uiEventsDir())
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.endsWith('.ndjson') && !entry.endsWith('-attachments')) continue
    const file = join(uiEventsDir(), entry)
    try {
      if (statSync(file).mtimeMs < cutoff) {
        rmSync(file, { recursive: entry.endsWith('-attachments'), force: true })
      }
    } catch {
      // already gone
    }
  }
}

/** distinct Playwright projects a run scheduled, encoded like RunConfig.project */
function projectFilterOf(scheduled: { project: string }[]): string {
  const names = [...new Set(scheduled.map((s) => s.project).filter((p) => p !== ''))].sort()
  if (names.length === 0) return 'all'
  return names.join(',')
}

interface OpenRun {
  id: number
  runNumber: number
  startedAt: number
  total: number
  done: number
  logSequence: number
  storage: RunStorageLayout
  decls: Map<string, RecordedDecl>
}

/**
 * Serializes reporter events into history writes. Events are queued so the
 * async begin step (git hash) can never reorder against test results.
 * Failing open is the rule everywhere: a broken history db must never take
 * the embedded UI down.
 */
export class UiRunRecorder {
  private queue: Promise<void> = Promise.resolve()
  private open: OpenRun | null = null
  /** false once shutdown is queued; already-queued events still run */
  private accepting = true

  constructor(
    private readonly projectPath: string,
    private readonly sessionId: string,
    private readonly emit: (event: UiModeEvent) => void,
    private readonly git: (cwd: string) => Promise<string | null> = gitShortHash,
    private readonly gitCwd: string = projectPath
  ) {}

  handleEvent(event: RunEvent): void {
    if (!this.accepting) return
    this.queue = this.queue
      .then(() => this.apply(event))
      .catch((err) => console.error('ui-mode recorder failed:', err))
  }

  /** settle all queued events (tests + orderly shutdown) */
  flush(): Promise<void> {
    return this.queue
  }

  /**
   * Close an open run as interrupted with whatever results arrived. Called
   * when the session ends (project switch, restart, crash, app quit) — a run
   * must never stay 'running' forever; the startup orphan sweep remains the
   * final net for rows we could not reach.
   */
  finalizeInterrupted(): Promise<void> {
    if (!this.accepting) return this.queue
    this.accepting = false
    // Queue finalization BEHIND every event drained from the channel. An end
    // event wins naturally (finalizeNow then sees no open run); without an end,
    // the partial run is persisted as interrupted.
    this.queue = this.queue
      .then(() => this.finalizeNow('interrupted'))
      .catch((err) => console.error('ui-mode recorder shutdown failed:', err))
    return this.queue
  }

  private async apply(event: RunEvent): Promise<void> {
    switch (event.type) {
      case 'begin': {
        // a begin while a run is open means we lost its end — settle it first
        if (this.open) this.finalizeNow('interrupted')
        const startedAt = Date.now()
        const commitHash = await this.git(this.gitCwd)
        let record: { id: number; runNumber: number }
        try {
          record = createRun(
            this.projectPath,
            'ui-mode',
            commitHash,
            startedAt,
            projectFilterOf(event.scheduled),
            loadSettings().captureMode
          )
        } catch (err) {
          // no row — skip this run's events entirely rather than break UI Mode
          console.error('failed to record ui-mode run start:', err)
          return
        }
        const decls = new Map<string, RecordedDecl>()
        recordDeclEvent(decls, event)
        const storage = createRunStorage(this.projectPath, record.id)
        setRunStorage(record.id, storage.root, storage.reportDir)
        this.open = {
          id: record.id,
          runNumber: record.runNumber,
          startedAt,
          total: event.total,
          done: 0,
          logSequence: 0,
          storage,
          decls
        }
        this.emit({
          type: 'run-begin',
          sessionId: this.sessionId,
          runNumber: record.runNumber,
          total: event.total
        })
        return
      }
      case 'test-begin': {
        if (!this.open) return
        beginAttemptRecord(this.open.id, event, event.startedAt)
        return
      }
      case 'step-begin': {
        if (!this.open) return
        beginStepRecord(this.open.id, event, event)
        return
      }
      case 'step-end': {
        if (!this.open) return
        finishStepRecord(this.open.id, event, {
          stepId: event.stepId,
          durationMs: event.duration,
          error: event.error ?? null
        })
        return
      }
      case 'stdio': {
        if (!this.open) return
        appendLogRecord(
          this.open.id,
          event.attemptId ?? null,
          ++this.open.logSequence,
          event.stream,
          event.timestamp,
          event.text
        )
        return
      }
      case 'test-end': {
        if (!this.open) return
        finishAttemptRecord(this.open.id, event, {
          finishedAt: event.finishedAt,
          status: event.status,
          durationMs: event.duration,
          error: event.error ?? null,
          annotations: event.annotations ?? []
        })
        let archived = event.attachments ?? []
        if (event.attachments) {
          try {
            archived = archiveAttemptAttachments(
              this.open.storage,
              this.open.id,
              event.attemptId,
              event.attachments
            )
          } catch (err) {
            // Recording is observational: a bad file must never interrupt
            // Playwright UI Mode or suppress the result/progress event.
            console.error('failed to archive UI Mode attempt evidence:', err)
          }
        }
        const archivedEvent: RunEvent = { ...event, attachments: archived }
        const key = `${event.file}:${event.line}:${event.title}`
        const alreadyDone = this.open.decls.get(key)?.perProject.has(event.project) ?? false
        recordDeclEvent(this.open.decls, archivedEvent)
        // progress counts each (test, project) instance once; retries replace
        if (event.status !== 'interrupted' && !alreadyDone) this.open.done += 1
        let failed = 0
        for (const decl of this.open.decls.values()) {
          for (const result of decl.perProject.values()) {
            if (result.outcome === 'unexpected') {
              failed += 1
              break
            }
          }
        }
        this.emit({
          type: 'run-progress',
          sessionId: this.sessionId,
          runNumber: this.open.runNumber,
          done: this.open.done,
          total: this.open.total,
          failed
        })
        return
      }
      case 'end': {
        this.finalizeNow(event.status)
        return
      }
      default:
        // errors are represented by the run status and stderr evidence
        return
    }
  }

  private finalizeNow(status: string): void {
    if (!this.open) return
    const open = this.open
    this.open = null
    const results = aggregate(open.decls)
    const finishedAt = Date.now()
    try {
      finishRunRecord(open.id, { finishedAt, status, results })
    } catch (err) {
      console.error('failed to persist ui-mode run:', err)
      return
    }
    const counts = { pass: 0, fail: 0, flaky: 0, skipped: 0 }
    for (const result of results) counts[result.status] += 1
    this.emit({
      type: 'run-end',
      sessionId: this.sessionId,
      runNumber: open.runNumber,
      status,
      passed: counts.pass,
      failed: counts.fail,
      flaky: counts.flaky,
      skipped: counts.skipped,
      total: results.length,
      durationMs: finishedAt - open.startedAt
    })
  }
}

const POLL_INTERVAL_MS = 200
/** a flood of bytes with no newline is not our reporter — drop, don't grow */
const MAX_PENDING_BYTES = 2_000_000

/**
 * One session's event channel: owns the NDJSON file and tails it live
 * (fs.watch for immediacy + a slow poll as the cross-platform fallback).
 * Lines are split on raw newline bytes before utf-8 decoding, so a partial
 * append or a multibyte character across reads can never corrupt an event.
 */
export class UiSessionChannel {
  readonly file: string
  readonly attachmentsDir: string
  readonly recorder: UiRunRecorder
  private offset = 0
  private pending: Buffer = Buffer.alloc(0)
  private timer: ReturnType<typeof setInterval> | null = null
  private watcher: FSWatcher | null = null
  private stopped = false
  private stopPromise: Promise<void> | null = null
  private activeRun = false

  constructor(
    projectPath: string,
    private readonly sessionId: string,
    emit: (event: UiModeEvent) => void,
    gitCwd: string = projectPath
  ) {
    this.file = join(uiEventsDir(), `${sessionId}.ndjson`)
    this.attachmentsDir = join(uiEventsDir(), `${sessionId}-attachments`)
    this.recorder = new UiRunRecorder(projectPath, sessionId, emit, gitShortHash, gitCwd)
  }

  start(): void {
    mkdirSync(uiEventsDir(), { recursive: true })
    mkdirSync(this.attachmentsDir, { recursive: true })
    writeFileSync(this.file, '')
    this.timer = setInterval(() => this.pump(), POLL_INTERVAL_MS)
    try {
      this.watcher = watch(this.file, { persistent: false }, () => this.pump())
    } catch {
      this.watcher = null // poll alone still delivers
    }
  }

  /**
   * True as soon as a raw begin event is observed, before git/db work settles.
   * Pump synchronously so execution arbitration is not one polling interval
   * behind a reporter begin that is already present on disk.
   */
  isRunActive(): boolean {
    if (!this.stopped) {
      this.pumpBytes()
      this.parsePending(false)
    }
    return this.activeRun
  }

  /** drain what's on disk, settle queued events/open run, then remove the file */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    this.pumpBytes()
    this.parsePending(true)
    this.activeRun = false
    this.stopPromise = this.recorder.finalizeInterrupted().then(() => {
      try {
        rmSync(this.file, { force: true })
        rmSync(this.attachmentsDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup; the startup sweep prunes leftovers
      }
    })
    return this.stopPromise
  }

  private pump(): void {
    if (this.stopped) return
    this.pumpBytes()
    this.parsePending(false)
  }

  private pumpBytes(): void {
    let size: number
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    if (size <= this.offset) return
    let fd: number
    try {
      fd = openSync(this.file, 'r')
    } catch {
      return
    }
    try {
      while (this.offset < size) {
        const chunk = Buffer.alloc(Math.min(size - this.offset, 262_144))
        const read = readSync(fd, chunk, 0, chunk.length, this.offset)
        if (read <= 0) break
        this.offset += read
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, read)])
        if (this.pending.length > MAX_PENDING_BYTES) {
          this.pending = Buffer.alloc(0)
          break
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  private parsePending(isFinal: boolean): void {
    let newline = this.pending.indexOf(0x0a)
    while (newline !== -1) {
      const line = this.pending.subarray(0, newline).toString('utf8')
      this.pending = this.pending.subarray(newline + 1)
      this.dispatch(line)
      newline = this.pending.indexOf(0x0a)
    }
    if (isFinal && this.pending.length > 0) {
      // last line may lack the trailing newline on abrupt exit
      this.dispatch(this.pending.toString('utf8'))
      this.pending = Buffer.alloc(0)
    }
  }

  private dispatch(line: string): void {
    const event = parseUiEventLine(line.trim(), this.sessionId)
    if (!event) return
    if (event.type === 'begin') this.activeRun = true
    else if (event.type === 'end') this.activeRun = false
    this.recorder.handleEvent(event)
  }
}

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type {
  AttachmentRef,
  RunEvent,
  TestAttemptRef,
  TestRef,
  UiRecordingInfo
} from '@shared/ipc'

/**
 * Version adapter for the embedded Playwright test server. Everything that
 * leans on Playwright internals lives here, so a Playwright release that
 * changes them is a one-file fix:
 *
 *  - `playwright test-server` is a hidden command; its `Listening on ws://…`
 *    stdout line and `trace/uiMode.html?ws=` URL shape are parsed by
 *    servers.ts/uimode.ts (public-ish since UI Mode shipped, verified ≥1.44).
 *  - `PW_TEST_REPORTER=<file>` makes the server's per-run createReporters()
 *    append our reporter — the transparent injection channel. Verified
 *    against 1.62.x: it is consulted for real runs only, never for
 *    listTests/discovery, so history rows exist iff tests actually ran.
 *  - The reporter side-channel NDJSON protocol (v2) parsed below.
 *
 * Recording must FAIL OPEN: an unsupported version disables history capture
 * but never blocks the embedded UI itself.
 */

/** side-channel protocol version stamped on every reporter line */
export const UI_EVENTS_PROTOCOL_VERSION = 2

/**
 * Versions where reporter injection is verified/expected to work. The floor
 * is the first release whose test-server + createReporters flow matches the
 * behavior we verified on 1.62 (UI Mode's ws protocol family stabilized in
 * 1.44). A future 2.x gets recording disabled until verified.
 */
const RECORDING_MIN_MINOR = 44
const RECORDING_MAJOR = 1

export function recordingSupportForVersion(version: string | null): UiRecordingInfo {
  if (version === null) {
    return {
      supported: false,
      reason:
        'UI Mode is available, but Wrightbench history recording is off — the project’s Playwright version could not be detected.'
    }
  }
  const match = /^(\d+)\.(\d+)/.exec(version)
  const major = match ? Number(match[1]) : NaN
  const minor = match ? Number(match[2]) : NaN
  if (major === RECORDING_MAJOR && minor >= RECORDING_MIN_MINOR) {
    return { supported: true, reason: null }
  }
  return {
    supported: false,
    reason: `UI Mode is available, but Wrightbench history recording is not supported for Playwright v${version}.`
  }
}

/** installed @playwright/test version of the project (never Wrightbench's own) */
export function installedPlaywrightVersion(projectPath: string): string | null {
  for (const pkg of ['@playwright/test', 'playwright']) {
    try {
      const raw = readFileSync(
        join(projectPath, 'node_modules', pkg, 'package.json'),
        'utf8'
      )
      const version = (JSON.parse(raw) as { version?: unknown }).version
      if (typeof version === 'string' && version !== '') return version
    } catch {
      // not installed under this name
    }
  }
  return null
}

/**
 * Environment that makes the project's test server load our reporter and
 * route its events into the session file. Applied last so an env profile
 * can never redirect the channel.
 */
export function uiSessionEnv(
  reporterFile: string,
  eventsFile: string,
  sessionId: string,
  attachmentsDir: string
): Record<string, string> {
  return {
    PW_TEST_REPORTER: reporterFile,
    WRIGHTBENCH_UI_EVENTS_FILE: eventsFile,
    WRIGHTBENCH_UI_SESSION_ID: sessionId,
    WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR: attachmentsDir
  }
}

/** env names to blank on CLI runs so a profile can't fake a UI session */
export const UI_SESSION_ENV_KEYS = [
  'PW_TEST_REPORTER',
  'WRIGHTBENCH_UI_EVENTS_FILE',
  'WRIGHTBENCH_UI_SESSION_ID',
  'WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR'
] as const

/**
 * Remove UI Mode's private reporter side channel from any ordinary CLI
 * process. Script/profile environment is user-controlled and Playwright also
 * consults PW_TEST_REPORTER in list mode, so this overlay must be applied last
 * by both discovery and execution.
 */
export function sanitizeCliProcessEnv(env: Record<string, string>): Record<string, string> {
  const result = { ...env }
  for (const key of UI_SESSION_ENV_KEYS) result[key] = ''
  return result
}

// ---- side-channel wire parsing (untrusted input — cap everything) ----

const MAX_LINE_BYTES = 1_000_000
const MAX_SCHEDULED = 10_000
const MAX_ATTACHMENTS = 50
const MAX_ERROR_CHARS = 4_000
const MAX_NAME_CHARS = 1_024
const MAX_PATH_CHARS = 4_096

function capString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface RawLine {
  v?: unknown
  sid?: unknown
  type?: unknown
  [key: string]: unknown
}

function parseRef(raw: RawLine): TestRef | null {
  const file = capString(raw.file, MAX_NAME_CHARS)
  const line = finiteNumber(raw.line)
  const title = capString(raw.title, MAX_NAME_CHARS)
  const project = capString(raw.project, 256) ?? ''
  if (file === null || line === null || title === null) return null
  const column = finiteNumber(raw.column)
  const titlePath = Array.isArray(raw.titlePath)
    ? raw.titlePath
        .slice(0, 64)
        .map((part) => capString(part, MAX_NAME_CHARS))
        .filter((part): part is string => part !== null)
    : undefined
  return {
    file,
    line: Math.trunc(line),
    title,
    project,
    ...(column !== null ? { column: Math.trunc(column) } : {}),
    ...(titlePath !== undefined && titlePath.length > 0 ? { titlePath } : {})
  }
}

function parseAttempt(raw: RawLine, legacy = false): TestAttemptRef | null {
  const ref = parseRef(raw)
  const attemptId =
    capString(raw.attemptId, MAX_NAME_CHARS) ??
    (legacy && ref
      ? `legacy|${ref.file}:${ref.line}:${ref.title}|${ref.project}|r${finiteNumber(raw.retry) ?? 0}`
      : null)
  const retry = finiteNumber(raw.retry) ?? (legacy ? 0 : null)
  const workerIndex = raw.workerIndex === null ? null : finiteNumber(raw.workerIndex)
  const parallelIndex = raw.parallelIndex === null ? null : finiteNumber(raw.parallelIndex)
  if (ref === null || attemptId === null || retry === null) return null
  return {
    ...ref,
    attemptId,
    retry: Math.max(0, Math.trunc(retry)),
    workerIndex: workerIndex === null ? null : Math.trunc(workerIndex),
    parallelIndex: parallelIndex === null ? null : Math.trunc(parallelIndex)
  }
}

function parseAnnotations(raw: unknown): { type: string; description: string | null }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: { type: string; description: string | null }[] = []
  for (const entry of raw.slice(0, 50)) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const type = capString(item.type, 200)
    if (type === null) continue
    result.push({ type, description: capString(item.description, 1_000) })
  }
  return result.length > 0 ? result : undefined
}

function parseAttachments(raw: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const attachments: AttachmentRef[] = []
  for (const entry of raw.slice(0, MAX_ATTACHMENTS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const a = entry as Record<string, unknown>
    const path = capString(a.path, MAX_PATH_CHARS)
    // only absolute file paths are meaningful history artifacts
    if (path === null || !isAbsolute(path)) continue
    attachments.push({
      name: capString(a.name, 256) ?? '',
      contentType: capString(a.contentType, 256) ?? '',
      path
    })
  }
  return attachments.length > 0 ? attachments : undefined
}

/**
 * Parse + validate one NDJSON line from the reporter side channel into the
 * shared RunEvent shape. Returns null for anything malformed, oversized, or
 * not belonging to `sessionId` — the recorder simply skips those lines.
 */
export function parseUiEventLine(line: string, sessionId: string): RunEvent | null {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) return null
  let raw: RawLine
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    raw = parsed as RawLine
  } catch {
    return null
  }
  const legacy = raw.v === 1
  if ((!legacy && raw.v !== UI_EVENTS_PROTOCOL_VERSION) || raw.sid !== sessionId) return null

  switch (raw.type) {
    case 'begin': {
      const total = finiteNumber(raw.total)
      if (total === null || !Array.isArray(raw.scheduled)) return null
      const scheduled = []
      for (const entry of raw.scheduled.slice(0, MAX_SCHEDULED)) {
        if (typeof entry !== 'object' || entry === null) continue
        const ref = parseRef(entry as RawLine)
        if (ref) scheduled.push(ref)
      }
      const workers = finiteNumber(raw.workers)
      return {
        type: 'begin',
        total: Math.max(0, Math.trunc(total)),
        workers: workers ?? undefined,
        scheduled
      }
    }
    case 'test-begin': {
      const ref = parseAttempt(raw, legacy)
      const startedAt = finiteNumber(raw.startedAt) ?? (legacy ? Date.now() : null)
      return ref && startedAt !== null ? { type: 'test-begin', startedAt, ...ref } : null
    }
    case 'step-begin': {
      const ref = parseAttempt(raw, legacy)
      const stepId = capString(raw.stepId, MAX_NAME_CHARS)
      const parentStepId = raw.parentStepId === null ? null : capString(raw.parentStepId, MAX_NAME_CHARS)
      const stepTitle = capString(raw.stepTitle, MAX_NAME_CHARS)
      const category = capString(raw.category, 100)
      const startedAt = finiteNumber(raw.startedAt)
      if (!ref || stepId === null || stepTitle === null || category === null || startedAt === null) return null
      return { type: 'step-begin', stepId, parentStepId, stepTitle, category, startedAt, ...ref }
    }
    case 'step-end': {
      const ref = parseAttempt(raw, legacy)
      const stepId = capString(raw.stepId, MAX_NAME_CHARS)
      const duration = finiteNumber(raw.duration)
      if (!ref || stepId === null || duration === null) return null
      return {
        type: 'step-end',
        stepId,
        duration: Math.max(0, duration),
        error: capString(raw.error, MAX_ERROR_CHARS) ?? undefined,
        ...ref
      }
    }
    case 'stdio': {
      const stream = raw.stream
      const text = capString(raw.text, 8_192)
      const timestamp = finiteNumber(raw.timestamp)
      if ((stream !== 'stdout' && stream !== 'stderr') || text === null || timestamp === null) return null
      const attempt = parseAttempt(raw, legacy)
      return attempt
        ? { type: 'stdio', stream, text, timestamp, ...attempt }
        : { type: 'stdio', stream, text, timestamp }
    }
    case 'test-end': {
      const ref = parseAttempt(raw, legacy)
      const status = capString(raw.status, 64)
      const outcome = capString(raw.outcome, 64)
      const duration = finiteNumber(raw.duration)
      const finishedAt = finiteNumber(raw.finishedAt) ?? (legacy ? Date.now() : null)
      if (
        ref === null ||
        status === null ||
        outcome === null ||
        finishedAt === null ||
        !['expected', 'unexpected', 'flaky', 'skipped'].includes(outcome)
      ) {
        return null
      }
      return {
        type: 'test-end',
        status,
        outcome: outcome as 'expected' | 'unexpected' | 'flaky' | 'skipped',
        duration: Math.max(0, duration ?? 0),
        finishedAt,
        error: capString(raw.error, MAX_ERROR_CHARS) ?? undefined,
        annotations: parseAnnotations(raw.annotations),
        attachments: parseAttachments(raw.attachments),
        ...ref
      }
    }
    case 'end': {
      const status = capString(raw.status, 64)
      return status === null ? null : { type: 'end', status }
    }
    case 'error': {
      const message = capString(raw.message, MAX_ERROR_CHARS)
      return message === null ? null : { type: 'error', message }
    }
    default:
      return null
  }
}

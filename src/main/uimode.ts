import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type {
  CaptureMode,
  UiModeEventPayload,
  UiModeExternalSessionInfo,
  UiModeLaunchMode,
  UiModeSessionInfo,
  UiModeState,
  UiRecordingInfo
} from '@shared/ipc'
import {
  createRuntimeCaptureConfig,
  type RuntimeCaptureConfig
} from './capture'
import { assertUiModeAvailable, isCliExecutionActive } from './execution'
import { killTree, trackedSpawn } from './proc'
import {
  recordingSupportForVersion,
  UI_SESSION_ENV_KEYS,
  uiSessionEnv
} from './pwadapter'
import { reporterPath } from './reporter'
import { waitForHttp, waitForWsEndpoint } from './servers'
import { loadSettings, projectRunEnv } from './settings'
import { resolveTargetContext } from './targets/context'
import type { ResolvedUiModeRequest } from './uimoderequest'
import { UiSessionChannel } from './uisession'

/**
 * Native Playwright UI Mode integration. Embedded sessions use Playwright's
 * hidden server-only command and stay an opaque webview. The external fallback
 * uses the public `test --ui` CLI and opens only after an explicit user action.
 * Both paths use the registered target's project-local Playwright install and
 * remain Wrightbench-owned tracked processes for their entire lifetime.
 */

export interface UiModeLaunchSpec {
  command: 'node'
  args: string[]
  cwd: string
  packageDir: string
  configPath: string | null
  playwrightVersion: string | null
  /** target/install identity used to prevent stale path-only joins */
  identity: string
}

interface SessionMetadata {
  sessionId: string
  projectPath: string
  targetId: string
  configurationTargetId: string
  recipeMappedToBase: boolean
  profile: string | null
  playwrightVersion: string | null
  recording: UiRecordingInfo
  launchMode: UiModeLaunchMode
}

interface ManagedSession extends SessionMetadata {
  identity: string
  child: ChildProcess
  channel: UiSessionChannel | null
  captureConfig: RuntimeCaptureConfig | null
  /** deliberate stop in progress — close handlers must not report a crash */
  stopping: boolean
  stopPromise: Promise<void> | null
  stderrTail: string[]
}

interface EmbeddedSession extends ManagedSession {
  launchMode: 'embedded'
  ready: Promise<UiModeSessionInfo>
  info: UiModeSessionInfo | null
}

interface ExternalSession extends ManagedSession {
  launchMode: 'external'
  ready: Promise<UiModeExternalSessionInfo>
  info: UiModeExternalSessionInfo | null
}

interface Starting<T> {
  identity: string
  promise: Promise<T>
  cancelled: boolean
}

const embeddedSessions = new Map<string, EmbeddedSession>()
const externalSessions = new Map<string, ExternalSession>()
const embeddedStarting = new Map<string, Starting<UiModeSessionInfo>>()
const externalStarting = new Map<string, Starting<UiModeExternalSessionInfo>>()
const contextMutations = new Map<string, symbol>()

let sink: (payload: UiModeEventPayload) => void = () => {}

/** index.ts wires this to webContents broadcast. */
export function setUiModeEventSink(fn: (payload: UiModeEventPayload) => void): void {
  sink = fn
}

function targetContextError(code: 'outside-workspace' | 'pnp' | 'missing-playwright'): Error {
  if (code === 'outside-workspace') {
    return new Error('The selected Playwright configuration resolves outside this workspace')
  }
  if (code === 'pnp') {
    return new Error('Yarn Plug’n’Play test configurations are not supported yet')
  }
  return new Error(
    'Playwright is not installed for this configuration. Install project dependencies, then retry.'
  )
}

/**
 * Build either native UI launch from the same bounded target context used by
 * discovery/runs. Recipe argv is never forwarded: test-server accepts only
 * config/host/port and native UI Mode owns its own project/filter controls.
 */
export function resolveUiModeLaunchSpec(
  request: ResolvedUiModeRequest,
  launchMode: UiModeLaunchMode
): UiModeLaunchSpec {
  const resolved = resolveTargetContext(request.projectPath, request.target)
  if (!resolved.ok) throw targetContextError(resolved.code)
  const context = resolved.context
  const effectiveEnvIdentity = Object.entries({
    ...request.recipeEnv,
    ...projectRunEnv()
  }).sort(([left], [right]) => left.localeCompare(right))
  const args = [context.playwright.cliPath]
  if (launchMode === 'embedded') {
    args.push('test-server')
    if (context.configPath !== null) args.push(`--config=${context.configPath}`)
    args.push('--host=127.0.0.1', '--port=0')
  } else {
    args.push('test', '--ui', '--ui-host=127.0.0.1')
    if (context.configPath !== null) args.push(`--config=${context.configPath}`)
  }
  return {
    command: 'node',
    args,
    cwd: context.cwd,
    packageDir: context.packageDir,
    configPath: context.configPath,
    playwrightVersion: context.playwright.version,
    identity: JSON.stringify([
      request.targetId,
      request.target.id,
      context.cwd,
      context.configPath,
      context.playwright.cliPath,
      context.playwright.version,
      effectiveEnvIdentity
    ])
  }
}

function metadata(
  request: ResolvedUiModeRequest,
  sessionId: string,
  playwrightVersion: string | null,
  recording: UiRecordingInfo,
  launchMode: UiModeLaunchMode
): SessionMetadata {
  return {
    sessionId,
    projectPath: request.projectPath,
    targetId: request.targetId,
    configurationTargetId: request.target.id,
    recipeMappedToBase: request.targetId !== request.target.id,
    profile: request.profile,
    playwrightVersion,
    recording,
    launchMode
  }
}

function emitState(
  session: SessionMetadata,
  state: UiModeState,
  message: string | null = null,
  hosted: { url: string; port: number } | null = null
): void {
  sink({
    path: session.projectPath,
    event: {
      type: 'state',
      state,
      sessionId: session.sessionId,
      targetId: session.targetId,
      configurationTargetId: session.configurationTargetId,
      recipeMappedToBase: session.recipeMappedToBase,
      launchMode: session.launchMode,
      url: hosted?.url ?? null,
      port: hosted?.port ?? null,
      profile: session.profile,
      playwrightVersion: session.playwrightVersion,
      recording: session.recording,
      message
    }
  })
}

function redactor(values: readonly string[]): (text: string) => string {
  const secrets = [
    ...new Set(
      values.flatMap((value) => [value, ...value.split(/\r?\n/)]).filter((value) => value !== '')
    )
  ].sort((left, right) => right.length - left.length)
  return (text: string): string => {
    // eslint-disable-next-line no-control-regex -- terminal escapes must not reach renderer state
    let safe = text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    for (const value of secrets) safe = safe.split(value).join('[redacted]')
    return safe
  }
}

function prepareEnvironment(
  request: ResolvedUiModeRequest,
  sessionId: string,
  playwrightVersion: string | null,
  gitCwd: string,
  recordRuns: boolean
): {
  env: Record<string, string>
  recording: UiRecordingInfo
  channel: UiSessionChannel | null
  redact: (text: string) => string
} {
  // Recipe inline env may be required to load an env-gated config. Its CLI
  // filters/argv are intentionally absent; Wrightbench adds no profile overlay.
  const env = { ...request.recipeEnv, ...projectRunEnv() }
  // Only project/user-provided values are secrets. Internal literals such as
  // "never" and the fixed runtime PATH must remain legible in diagnostics.
  const redact = redactor(Object.values(request.recipeEnv))
  const recording = recordRuns
    ? recordingSupportForVersion(playwrightVersion)
    : {
        supported: false,
        reason: 'Runs opened in external UI Mode are not recorded in Wrightbench history.'
      }
  let channel: UiSessionChannel | null = null
  if (recordRuns && recording.supported) {
    const candidate = new UiSessionChannel(
      request.projectPath,
      sessionId,
      (event) => sink({ path: request.projectPath, event }),
      gitCwd
    )
    try {
      candidate.start()
      channel = candidate
      // Applied after recipe/runtime spreads so neither can redirect the
      // reporter or its private event channel.
      Object.assign(
        env,
        uiSessionEnv(reporterPath(), channel.file, sessionId, channel.attachmentsDir)
      )
    } catch (err) {
      void candidate.stop()
      recording.supported = false
      recording.reason = `UI Mode is available, but Wrightbench history recording could not start — ${
        err instanceof Error ? redact(err.message) : redact(String(err))
      }`
    }
  }
  if (!recording.supported) {
    // Never load our reporter (or recipe-smuggled private values) into an
    // unverified Playwright setup. Blank rather than delete: trackedSpawn
    // merges over process.env, which may itself contain one of these keys.
    for (const key of UI_SESSION_ENV_KEYS) env[key] = ''
  }
  return { env, recording, channel, redact }
}

function collectChildOutput(
  child: ChildProcess,
  stderrTail: string[],
  redact: (text: string) => string
): void {
  // Always drain stdout. The embedded endpoint parser attaches its own data
  // listener temporarily; external UI can otherwise fill a pipe over time.
  child.stdout?.on('data', () => {})
  const maxRawLine = 16_384
  const maxRetainedLines = 40
  let pending = ''
  let discardingOversizedLine = false
  const keepLine = (line: string): void => {
    const trimmed = redact(line.trim())
    if (!trimmed) return
    stderrTail.push(trimmed.slice(0, 400))
    if (stderrTail.length > maxRetainedLines) stderrTail.shift()
  }
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    const lines = `${pending}${chunk}`.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (discardingOversizedLine) {
        discardingOversizedLine = false
      } else if (line.length <= maxRawLine) {
        keepLine(line)
      }
    }
    // Project code controls stderr. Drop an unterminated oversized line rather
    // than retaining unbounded memory or surfacing an incompletely redacted one.
    if (pending.length > maxRawLine) {
      pending = ''
      discardingOversizedLine = true
    }
  })
  child.stderr?.on('end', () => {
    if (!discardingOversizedLine && pending !== '') keepLine(pending)
    pending = ''
  })
  child.on('error', (err) => {
    stderrTail.push(redact(err.message).slice(0, 400))
    if (stderrTail.length > maxRetainedLines) stderrTail.shift()
  })
}

const ERROR_HEADLINE = /^(?:(?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error:\s|Cannot (?:find|load|resolve)\b|Failed to\b|Unable to\b)/i

function isStderrBoilerplate(line: string): boolean {
  return (
    /^Node\.js v\d/i.test(line) ||
    /^node:internal\//i.test(line) ||
    /^at\s/.test(line) ||
    /^(?:Require stack:|throw\b)/i.test(line) ||
    /^(?:code|errno|path|syscall):\s/.test(line) ||
    /^[{}^]+$/.test(line)
  )
}

/**
 * Pick the product-facing reason from bounded, redacted child stderr. Node
 * prints its version last and often follows the useful `Error:` headline with
 * a long stack/object dump, so "last line wins" hides the actual failure.
 */
export function selectUiModeDiagnostic(lines: string[], fallback: string): string {
  const retained = lines.map((line) => line.trim()).filter(Boolean)
  const headline = retained.find((line) => ERROR_HEADLINE.test(line))
  if (headline) return headline
  return [...retained].reverse().find((line) => !isStderrBoilerplate(line)) ?? fallback
}

function crashMessage(session: ManagedSession, fallback: string): string {
  return selectUiModeDiagnostic(session.stderrTail, fallback)
}

function startupFailureMessage(session: ManagedSession, fallback: string): string {
  const detail = crashMessage(session, '')
  return detail !== '' && detail !== fallback ? `${fallback} — ${detail}` : fallback
}

export function validateUiModeWsEndpoint(raw: string): {
  ws: string
  /** the endpoint's path with no leading slash — the page's `ws` query value */
  wsPath: string
  port: number
} {
  if (raw.length > 4_096) {
    throw new Error('UI Mode server returned an invalid WebSocket endpoint')
  }
  let endpoint: URL
  try {
    endpoint = new URL(raw)
  } catch {
    throw new Error('UI Mode server returned an invalid WebSocket endpoint')
  }
  const port = Number(endpoint.port)
  if (
    endpoint.protocol !== 'ws:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== '' ||
    endpoint.search !== '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('UI Mode server returned a non-loopback WebSocket endpoint')
  }
  return { ws: endpoint.toString(), wsPath: endpoint.pathname.replace(/^\//, ''), port }
}

/**
 * Verify an initial UI Mode webview URL against the exact ready session URL
 * issued by this main process. A renderer-supplied arbitrary loopback origin
 * (or another path on the same server) is never sufficient.
 */
export function registeredUiModeOrigin(raw: string): string | null {
  let candidate: URL
  try {
    candidate = new URL(raw)
  } catch {
    return null
  }
  for (const session of embeddedSessions.values()) {
    if (!session.info || session.stopping) continue
    try {
      const issued = new URL(session.info.url)
      if (candidate.href === issued.href) return issued.origin
    } catch {
      // Session URLs are constructed internally, but remain fail-closed.
    }
  }
  return null
}

function waitForChildSpawn(child: ChildProcess, what: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      child.off('close', onClose)
      fn()
    }
    const onSpawn = (): void => finish(resolve)
    const onError = (err: Error): void => finish(() => reject(err))
    const onClose = (): void =>
      finish(() => reject(new Error(`${what} exited before it could start`)))
    const timer = setTimeout(() => {
      killTree(child)
      finish(() => reject(new Error(`${what} did not start in time`)))
    }, timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

function waitForChildClose(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('close', finish)
  })
}

/** Replace the selected config without disturbing the server-only UI arguments. */
function withUiModeConfig(args: readonly string[], configPath: string): string[] {
  const next = args.filter((arg) => !arg.startsWith('--config='))
  const hostIndex = next.findIndex(
    (arg) => arg.startsWith('--host=') || arg.startsWith('--ui-host=')
  )
  next.splice(hostIndex < 0 ? next.length : hostIndex, 0, `--config=${configPath}`)
  return next
}

function stopSession(session: ManagedSession): Promise<void> {
  if (session.stopPromise) return session.stopPromise
  session.stopping = true
  session.stopPromise = (async () => {
    const closed = waitForChildClose(session.child)
    killTree(session.child)
    // Wait until the reporter process can no longer append, then drain/remove
    // the event file. This prevents a killed process from recreating it.
    await closed
    try {
      await session.channel?.stop()
    } finally {
      session.captureConfig?.cleanup()
    }
  })()
  return session.stopPromise
}

async function launchEmbedded(
  request: ResolvedUiModeRequest,
  spec: UiModeLaunchSpec,
  captureMode: CaptureMode,
  identity: string
): Promise<UiModeSessionInfo> {
  assertUiModeAvailable(request.projectPath)
  const sessionId = randomUUID()
  const captureConfig = createRuntimeCaptureConfig(request.projectPath, captureMode, {
    cwd: spec.cwd,
    packageDir: spec.packageDir,
    configPath: spec.configPath
  })
  let prepared: ReturnType<typeof prepareEnvironment>
  try {
    prepared = prepareEnvironment(request, sessionId, spec.playwrightVersion, spec.cwd, true)
  } catch (err) {
    captureConfig?.cleanup()
    throw err
  }
  const meta = metadata(
    request,
    sessionId,
    spec.playwrightVersion,
    prepared.recording,
    'embedded'
  )
  emitState(meta, 'starting')

  let child: ChildProcess
  try {
    const args = captureConfig ? withUiModeConfig(spec.args, captureConfig.path) : spec.args
    child = trackedSpawn(spec.command, args, spec.cwd, prepared.env)
  } catch (err) {
    await prepared.channel?.stop()
    captureConfig?.cleanup()
    throw err
  }

  const session: EmbeddedSession = {
    ...meta,
    launchMode: 'embedded',
    identity,
    child,
    channel: prepared.channel,
    captureConfig,
    ready: null as unknown as Promise<UiModeSessionInfo>,
    info: null,
    stopping: false,
    stopPromise: null,
    stderrTail: []
  }
  collectChildOutput(child, session.stderrTail, prepared.redact)

  session.ready = (async (): Promise<UiModeSessionInfo> => {
    const rawWs = await waitForWsEndpoint(child, 'UI Mode server', 30_000)
    const { wsPath, port } = validateUiModeWsEndpoint(rawWs)
    // The `ws` query value must be the endpoint's GUID path, not the full
    // ws:// URL: uiMode.html resolves it against its own origin (1.45 does
    // literally `new URL('../' + ws, location)`), so a full URL turns into a
    // garbage path there and the page reports "UI Mode disconnected" while
    // the server is perfectly healthy. Newer bundles tolerate an absolute
    // URL, which is why this only broke on older Playwright versions.
    const url = `http://127.0.0.1:${port}/trace/uiMode.html?ws=${encodeURIComponent(wsPath)}`
    await waitForHttp(url, child, /playwright/i, 'UI Mode server', 30_000)
    if (
      session.stopping ||
      embeddedSessions.get(request.projectPath)?.sessionId !== sessionId
    ) {
      throw new Error('Starting embedded UI Mode was cancelled')
    }
    const info: UiModeSessionInfo = {
      sessionId,
      targetId: request.targetId,
      configurationTargetId: request.target.id,
      recipeMappedToBase: request.targetId !== request.target.id,
      launchMode: 'embedded',
      url,
      port,
      profile: request.profile,
      playwrightVersion: spec.playwrightVersion,
      recording: prepared.recording
    }
    session.info = info
    emitState(session, 'ready', null, { url, port })
    return info
  })()

  embeddedSessions.set(request.projectPath, session)
  child.on('close', () => {
    session.captureConfig?.cleanup()
    if (embeddedSessions.get(request.projectPath)?.sessionId !== sessionId) return
    embeddedSessions.delete(request.projectPath)
    void (session.channel?.stop() ?? Promise.resolve()).then(() => {
      if (!session.stopping) {
        emitState(session, 'crashed', crashMessage(session, 'UI Mode server exited unexpectedly'))
      }
    })
  })

  try {
    return await session.ready
  } catch (err) {
    const deliberateStop = session.stopping
    await stopSession(session)
    if (embeddedSessions.get(request.projectPath)?.sessionId === sessionId) {
      embeddedSessions.delete(request.projectPath)
    }
    if (!deliberateStop) {
      const fallback = err instanceof Error ? prepared.redact(err.message) : prepared.redact(String(err))
      const display = startupFailureMessage(session, fallback)
      emitState(session, 'crashed', display)
      throw new Error(display)
    }
    throw err
  }
}

async function launchExternal(
  request: ResolvedUiModeRequest,
  spec: UiModeLaunchSpec
): Promise<UiModeExternalSessionInfo> {
  assertUiModeAvailable(request.projectPath)
  const sessionId = randomUUID()
  const prepared = prepareEnvironment(request, sessionId, spec.playwrightVersion, spec.cwd, false)
  const meta = metadata(
    request,
    sessionId,
    spec.playwrightVersion,
    prepared.recording,
    'external'
  )
  emitState(meta, 'starting')

  let child: ChildProcess
  try {
    child = trackedSpawn(spec.command, spec.args, spec.cwd, prepared.env)
  } catch (err) {
    await prepared.channel?.stop()
    throw err
  }

  const session: ExternalSession = {
    ...meta,
    launchMode: 'external',
    identity: spec.identity,
    child,
    channel: prepared.channel,
    captureConfig: null,
    ready: null as unknown as Promise<UiModeExternalSessionInfo>,
    info: null,
    stopping: false,
    stopPromise: null,
    stderrTail: []
  }
  collectChildOutput(child, session.stderrTail, prepared.redact)
  session.ready = waitForChildSpawn(child, 'Native UI Mode').then(() => {
    if (
      session.stopping ||
      externalSessions.get(request.projectPath)?.sessionId !== sessionId
    ) {
      throw new Error('Opening native UI Mode was cancelled')
    }
    const info: UiModeExternalSessionInfo = {
      sessionId,
      targetId: request.targetId,
      configurationTargetId: request.target.id,
      recipeMappedToBase: request.targetId !== request.target.id,
      launchMode: 'external',
      profile: request.profile,
      playwrightVersion: spec.playwrightVersion,
      recording: prepared.recording
    }
    session.info = info
    emitState(session, 'external')
    return info
  })

  externalSessions.set(request.projectPath, session)
  child.on('close', (code) => {
    if (externalSessions.get(request.projectPath)?.sessionId !== sessionId) return
    externalSessions.delete(request.projectPath)
    void (session.channel?.stop() ?? Promise.resolve()).then(() => {
      if (session.stopping) return
      if (code === 0) emitState(session, 'stopped')
      else {
        emitState(
          session,
          'crashed',
          crashMessage(session, `Native UI Mode exited unexpectedly (code ${code ?? 'unknown'})`)
        )
      }
    })
  })

  try {
    return await session.ready
  } catch (err) {
    const deliberateStop = session.stopping
    await stopSession(session)
    if (externalSessions.get(request.projectPath)?.sessionId === sessionId) {
      externalSessions.delete(request.projectPath)
    }
    if (!deliberateStop) {
      const fallback = err instanceof Error ? prepared.redact(err.message) : prepared.redact(String(err))
      const display = startupFailureMessage(session, fallback)
      emitState(session, 'crashed', display)
      throw new Error(display)
    }
    throw err
  }
}

function identityMismatch(): Error {
  return new Error(
    'UI Mode is already open for another configuration or environment; restart it to switch context'
  )
}

function assertContextStable(projectPath: string): void {
  if (contextMutations.has(projectPath)) {
    throw new Error('The test configuration is changing; wait for it to finish before opening UI Mode')
  }
}

/** Start or join one target-identical embedded session. */
export function startUiMode(request: ResolvedUiModeRequest): Promise<UiModeSessionInfo> {
  assertContextStable(request.projectPath)
  assertUiModeAvailable(request.projectPath)
  if (externalSessions.has(request.projectPath) || externalStarting.has(request.projectPath)) {
    throw new Error('Native UI Mode is already open externally; stop it before embedding UI Mode')
  }
  const spec = resolveUiModeLaunchSpec(request, 'embedded')
  const captureMode = loadSettings().captureMode
  const identity = `${spec.identity}\u0000capture:${captureMode}`
  const existing = embeddedSessions.get(request.projectPath)
  if (existing && !existing.stopping) {
    if (existing.identity !== identity) throw identityMismatch()
    return existing.ready
  }
  const inFlight = embeddedStarting.get(request.projectPath)
  if (inFlight) {
    if (inFlight.identity !== identity) throw identityMismatch()
    return inFlight.promise
  }
  const promise = launchEmbedded(request, spec, captureMode, identity).finally(() => {
    if (embeddedStarting.get(request.projectPath)?.promise === promise) {
      embeddedStarting.delete(request.projectPath)
    }
  })
  embeddedStarting.set(request.projectPath, {
    identity,
    promise,
    cancelled: false
  })
  return promise
}

/** Explicit user-triggered public `playwright test --ui` fallback. */
export function openExternalUiMode(
  request: ResolvedUiModeRequest
): Promise<UiModeExternalSessionInfo> {
  assertContextStable(request.projectPath)
  assertUiModeAvailable(request.projectPath)
  const spec = resolveUiModeLaunchSpec(request, 'external')
  const existing = externalSessions.get(request.projectPath)
  if (existing && !existing.stopping) {
    if (existing.identity !== spec.identity) throw identityMismatch()
    return existing.ready
  }
  const inFlight = externalStarting.get(request.projectPath)
  if (inFlight) {
    if (inFlight.identity !== spec.identity) throw identityMismatch()
    return inFlight.promise
  }
  const entry: Starting<UiModeExternalSessionInfo> = {
    identity: spec.identity,
    promise: null as unknown as Promise<UiModeExternalSessionInfo>,
    cancelled: false
  }
  const promise = (async () => {
    // Explicit fallback replaces the unusable embedded guest; it is never
    // triggered automatically by a server/webview failure.
    await stopProjectSessions(request.projectPath, false)
    if (entry.cancelled) throw new Error('Opening native UI Mode was cancelled')
    return launchExternal(request, spec)
  })().finally(() => {
    if (externalStarting.get(request.projectPath)?.promise === promise) {
      externalStarting.delete(request.projectPath)
    }
  })
  entry.promise = promise
  externalStarting.set(request.projectPath, entry)
  return promise
}

async function stopProjectSessions(projectPath: string, broadcast: boolean): Promise<boolean> {
  const embedded = embeddedSessions.get(projectPath)
  const external = externalSessions.get(projectPath)
  const embeddedTransition = embeddedStarting.get(projectPath)
  const externalTransition = externalStarting.get(projectPath)
  const existed = !!embedded || !!external || !!embeddedTransition || !!externalTransition
  if (embeddedTransition) embeddedTransition.cancelled = true
  if (externalTransition) externalTransition.cancelled = true
  embeddedSessions.delete(projectPath)
  externalSessions.delete(projectPath)
  embeddedStarting.delete(projectPath)
  externalStarting.delete(projectPath)
  await Promise.all(
    [embedded, external]
      .filter(
        (session): session is EmbeddedSession | ExternalSession => session !== undefined
      )
      .map((session) => stopSession(session))
  )
  if (broadcast) {
    for (const session of [embedded, external]) {
      if (session) emitState(session, 'stopped')
    }
  }
  return existed
}

/** Stop embedded or external UI Mode for a project. */
export function stopUiMode(projectPath: string): Promise<boolean> {
  return stopProjectSessions(projectPath, true)
}

/** Stop the current native UI surface and start embedded with fresh context. */
export async function restartUiMode(
  request: ResolvedUiModeRequest
): Promise<UiModeSessionInfo> {
  assertContextStable(request.projectPath)
  assertUiModeAvailable(request.projectPath)
  const spec = resolveUiModeLaunchSpec(request, 'embedded')
  const captureMode = loadSettings().captureMode
  const identity = `${spec.identity}\u0000capture:${captureMode}`
  const current = embeddedSessions.get(request.projectPath) ?? externalSessions.get(request.projectPath)
  const restartMeta = metadata(
    request,
    current?.sessionId ?? randomUUID(),
    spec.playwrightVersion,
    recordingSupportForVersion(spec.playwrightVersion),
    'embedded'
  )
  emitState(restartMeta, 'restarting')
  const entry: Starting<UiModeSessionInfo> = {
    identity,
    promise: null as unknown as Promise<UiModeSessionInfo>,
    cancelled: false
  }
  const promise = (async () => {
    await stopProjectSessions(request.projectPath, false)
    if (entry.cancelled) throw new Error('Restarting embedded UI Mode was cancelled')
    return launchEmbedded(request, spec, captureMode, identity)
  })().finally(() => {
    if (embeddedStarting.get(request.projectPath)?.promise === promise) {
      embeddedStarting.delete(request.projectPath)
    }
  })
  entry.promise = promise
  embeddedStarting.set(request.projectPath, entry)
  return promise
}

/** App quit: settle open runs, kill both UI launch forms, remove session files. */
export async function stopAllUiModeSessions(): Promise<void> {
  const paths = new Set([
    ...embeddedSessions.keys(),
    ...externalSessions.keys(),
    ...embeddedStarting.keys(),
    ...externalStarting.keys()
  ])
  await Promise.all([...paths].map((path) => stopProjectSessions(path, false)))
}

async function yieldUiModeOwnership(
  projectPath: string,
  purpose: 'starting a recorded run' | 'changing the test configuration'
): Promise<void> {
  if (externalSessions.has(projectPath) || externalStarting.has(projectPath)) {
    throw new Error(`Native UI Mode is open externally; stop it before ${purpose}`)
  }
  const session = embeddedSessions.get(projectPath)
  if (!session) {
    if (embeddedStarting.has(projectPath)) {
      throw new Error(`UI Mode is still starting; stop it before ${purpose}`)
    }
    return
  }
  if (!session.recording.supported || session.channel === null) {
    throw new Error(
      `UI Mode activity cannot be observed for this Playwright version; stop UI Mode before ${purpose}`
    )
  }
  if (session.channel.isRunActive()) {
    throw new Error(`A UI Mode run is in progress; stop it before ${purpose}`)
  }
  await stopUiMode(projectPath)
}

/**
 * CLI ownership boundary. External UI and unsupported embedded UI are opaque,
 * so they retain ownership until explicitly stopped. A supported embedded
 * session may be stopped automatically only after a synchronous channel pump
 * proves no reporter run is active.
 */
export async function prepareUiModeForCliRun(projectPath: string): Promise<void> {
  if (contextMutations.has(projectPath)) {
    throw new Error('The test configuration is changing; wait for it to finish before starting a recorded run')
  }
  await yieldUiModeOwnership(projectPath, 'starting a recorded run')
}

/**
 * Reserve target/config mutation ownership before draining an idle embedded
 * session. The reservation spans the caller's actual persistence/rescan work,
 * so a concurrent start cannot launch against the old context in between.
 */
export async function beginUiModeContextChange(projectPath: string): Promise<() => void> {
  if (contextMutations.has(projectPath)) {
    throw new Error('The test configuration is already changing')
  }
  const token = Symbol(projectPath)
  contextMutations.set(projectPath, token)
  try {
    if (isCliExecutionActive(projectPath)) {
      throw new Error('Stop the recorded run before changing the test configuration')
    }
    await yieldUiModeOwnership(projectPath, 'changing the test configuration')
    if (isCliExecutionActive(projectPath)) {
      throw new Error('Stop the recorded run before changing the test configuration')
    }
  } catch (err) {
    if (contextMutations.get(projectPath) === token) contextMutations.delete(projectPath)
    throw err
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (contextMutations.get(projectPath) === token) contextMutations.delete(projectPath)
  }
}

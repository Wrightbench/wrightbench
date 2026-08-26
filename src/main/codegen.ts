import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type {
  CodegenAction,
  CodegenActionKind,
  CodegenEventPayload,
  CodegenInspectorCommand,
  CodegenInspectorEvent,
  CodegenStartConfig,
  CommandResult
} from '@shared/ipc'
import { assertSupportedPlaywright } from '@shared/playwright-compat'
import { CODEGEN_HOST_SOURCE } from './codegenhost'
import { sanitizeCliProcessEnv } from './pwadapter'
import { killTree, trackedSpawn } from './proc'
import { projectRunEnv, wrightbenchDir } from './settings'
import { resolveTargetContext } from './targets/context'
import type { ResolvedUiModeRequest } from './uimoderequest'

/**
 * Embedded Record sessions. A small Wrightbench-owned host runs under the
 * selected project's Node + Playwright installation, opens the genuine headed
 * browser, and serves that installation's exact Inspector frontend for a
 * secured Wrightbench webview. The private protocol boundary stays in
 * codegenhost.ts and fails closed for unsupported versions.
 */

type EventSink = (payload: CodegenEventPayload) => void

interface Session {
  child: ChildProcess
  lastCode: string
  /** set by stopCodegen — a kill we asked for is a clean stop, not a crash */
  stopping: boolean
  sawReady: boolean
  sentTerminal: boolean
  stderrTail: string[]
  inspectorUrl: string | null
}

const sessions = new Map<string, Session>()

const KIND_BY_METHOD: Record<string, CodegenActionKind> = {
  goto: 'goto',
  click: 'click',
  dblclick: 'click',
  fill: 'fill',
  press: 'press',
  check: 'check',
  uncheck: 'check',
  selectOption: 'select',
  setInputFiles: 'other',
  type: 'fill'
}

/** parse the generated test source into badge-able action rows */
export function parseCodegenActions(code: string): CodegenAction[] {
  const actions: CodegenAction[] = []
  for (const raw of code.split('\n')) {
    const line = raw.trim()
    const expectMatch = line.match(/^await expect\((.+)\)\.(\w+)\((.*)\);?$/)
    if (expectMatch) {
      actions.push({
        kind: 'assert',
        // display form drops the page. prefix, like the reference cards
        locator: `${expectMatch[1].replace(/^page\./, '')}/${expectMatch[2]}`,
        value: null
      })
      continue
    }
    const callMatch = line.match(/^await (page[\w.()'"\\[\]{}:, \-$/]*)\.(\w+)\((.*)\);?$/)
    if (!callMatch) continue
    const [, subject, method, args] = callMatch
    const kind = KIND_BY_METHOD[method]
    if (kind === undefined) continue
    if (kind === 'goto') {
      const url = args.match(/^'((?:[^'\\]|\\.)*)'/)
      actions.push({ kind, locator: url ? url[1] : args, value: null })
      continue
    }
    const valueMatch = args.match(/^'((?:[^'\\]|\\.)*)'/)
    actions.push({
      kind,
      locator: subject === 'page' ? `page.${method}` : subject.replace(/^page\./, ''),
      value: kind === 'fill' || kind === 'press' || kind === 'select' ? (valueMatch?.[1] ?? null) : null
    })
  }
  return actions
}

function emitState(path: string, session: Session, send: EventSink, type: 'update' | 'stopped'): void {
  send({
    path,
    event: { type, code: session.lastCode, actions: parseCodegenActions(session.lastCode) }
  })
}

const HOST_PREFIX = 'WBREC '
const MAX_HOST_LINE = 5_000_000
const INSPECTOR_METHODS = new Set<CodegenInspectorEvent['method']>([
  'modeChanged',
  'sourcesUpdated',
  'pageNavigated',
  'pauseStateChanged',
  'callLogsUpdated',
  'sourceRevealRequested',
  'elementPicked'
])

function loopbackInspectorUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== ''
    )
      return null
    return url.href
  } catch {
    return null
  }
}

function hostPath(): string {
  const dir = wrightbenchDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'record-host.cjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // first launch or stale cleanup
  }
  if (current !== CODEGEN_HOST_SOURCE) {
    writeFileSync(file, CODEGEN_HOST_SOURCE, { encoding: 'utf8', mode: 0o600 })
  }
  return file
}

function friendlyHostError(message: string, browser: CodegenStartConfig['browser']): string {
  const clean = message.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (/executable doesn't exist|browser.*not found|playwright install/i.test(clean)) {
    const label = browser === 'webkit' ? 'WebKit' : browser[0].toUpperCase() + browser.slice(1)
    return `${label} is not installed for this project. Run npx playwright install ${browser}, then retry Record.`
  }
  const first = clean
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^at\s/.test(line))
  return (first ?? 'Record session failed').slice(0, 500)
}

function finiteInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const int = Math.round(value)
  return int >= min && int <= max ? int : null
}

function validViewport(value: unknown): { width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const width = finiteInt(raw.width, 480, 7680)
  const height = finiteInt(raw.height, 320, 4320)
  return width === null || height === null ? null : { width, height }
}

function parseHostLine(
  path: string,
  session: Session,
  line: string,
  browser: CodegenStartConfig['browser'],
  send: EventSink
): void {
  if (!line.startsWith(HOST_PREFIX) || line.length > MAX_HOST_LINE) return
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(HOST_PREFIX.length))
  } catch {
    return
  }
  if (typeof raw !== 'object' || raw === null) return
  const event = raw as Record<string, unknown>
  if (event.type === 'ready') {
    const viewport = validViewport(event.viewport)
    const inspectorUrl = loopbackInspectorUrl(event.inspectorUrl)
    if (
      viewport === null ||
      inspectorUrl === null ||
      typeof event.pageUrl !== 'string' ||
      typeof event.browserVersion !== 'string'
    )
      return
    session.sawReady = true
    session.inspectorUrl = inspectorUrl
    send({
      path,
      event: {
        type: 'ready',
        inspectorUrl,
        pageUrl: event.pageUrl.slice(0, 8_192),
        browserVersion: event.browserVersion.slice(0, 100),
        viewport
      }
    })
    return
  }
  if (event.type === 'inspector' && typeof event.event === 'object' && event.event !== null) {
    const inspectorEvent = event.event as Record<string, unknown>
    if (
      typeof inspectorEvent.method !== 'string' ||
      !INSPECTOR_METHODS.has(inspectorEvent.method as CodegenInspectorEvent['method'])
    )
      return
    let paramsSize = 0
    try {
      paramsSize = JSON.stringify(inspectorEvent.params).length
    } catch {
      return
    }
    if (paramsSize > 3_000_000) return
    send({
      path,
      event: {
        type: 'inspector',
        event: {
          method: inspectorEvent.method as CodegenInspectorEvent['method'],
          params: inspectorEvent.params
        }
      }
    })
    return
  }
  if (event.type === 'code' && typeof event.code === 'string' && event.code.length <= 2_000_000) {
    if (event.code === session.lastCode) return
    session.lastCode = event.code
    emitState(path, session, send, 'update')
    return
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    // Once Wrightbench requested End session, shutdown diagnostics are not a
    // recording failure. The close event below owns the clean terminal state.
    if (session.stopping || session.sentTerminal) return
    session.sentTerminal = true
    send({ path, event: { type: 'error', message: friendlyHostError(event.message, browser) } })
  }
}

export async function startCodegen(
  request: ResolvedUiModeRequest,
  config: Pick<CodegenStartConfig, 'url' | 'browser' | 'viewport'>,
  send: EventSink
): Promise<boolean> {
  const path = request.projectPath
  // one session per project; restarting = stop + start
  await stopCodegen(path)

  const resolved = resolveTargetContext(path, request.target)
  if (!resolved.ok) {
    const message =
      resolved.code === 'outside-workspace'
        ? 'The selected Playwright configuration resolves outside this workspace.'
        : resolved.code === 'pnp'
          ? 'Yarn Plug’n’Play Record sessions are not supported yet.'
          : 'Playwright is not installed for this configuration. Install project dependencies, then retry.'
    throw new Error(message)
  }
  const context = resolved.context
  assertSupportedPlaywright(context.playwright.version)

  const env = sanitizeCliProcessEnv({
    ...request.recipeEnv,
    ...projectRunEnv()
  })
  const child = trackedSpawn(
    'node',
    [hostPath(), context.playwright.packageRoot],
    context.cwd,
    env
  )
  const session: Session = {
    child,
    lastCode: '',
    stopping: false,
    sawReady: false,
    sentTerminal: false,
    stderrTail: [],
    inspectorUrl: null
  }
  sessions.set(path, session)

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.replace(/\r/g, '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      session.stderrTail.push(trimmed.slice(0, 500))
      if (session.stderrTail.length > 12) session.stderrTail.shift()
    }
  })

  let stdoutBuffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    if (stdoutBuffer.length > MAX_HOST_LINE * 2) {
      stdoutBuffer = stdoutBuffer.slice(-MAX_HOST_LINE)
    }
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n')
      if (newline === -1) break
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      parseHostLine(path, session, line, config.browser, send)
    }
  })

  child.on('close', (code) => {
    const current = sessions.get(path)
    if (current !== session) return
    sessions.delete(path)
    if (!session.stopping && !session.sentTerminal && (!session.sawReady || code !== 0)) {
      session.sentTerminal = true
      const reason = session.stderrTail.findLast((line) => !/^at\s/.test(line))
      send({
        path,
        event: {
          type: 'error',
          message: friendlyHostError(reason ?? `Record process exited with code ${code ?? '?'}`, config.browser)
        }
      })
      return
    }
    if (!session.sentTerminal) {
      session.sentTerminal = true
      emitState(path, session, send, 'stopped')
    }
  })

  child.on('error', (error) => {
    if (session.stopping || session.sentTerminal) return
    session.sentTerminal = true
    send({ path, event: { type: 'error', message: friendlyHostError(error.message, config.browser) } })
  })

  child.stdin?.write(
    `${JSON.stringify({ type: 'start', url: config.url, browser: config.browser, viewport: config.viewport })}\n`
  )

  return true
}

/** Forward one already-validated native-Inspector command to the recorder host. */
export function sendCodegenCommand(path: string, command: CodegenInspectorCommand): boolean {
  const session = sessions.get(path)
  if (!session || !session.sawReady || session.stopping || !session.child.stdin?.writable)
    return false
  const line = JSON.stringify({ type: 'command', command })
  if (line.length > 200_000) return false
  session.child.stdin.write(`${line}\n`)
  return true
}

/** Main-process webview policy: only the live session's exact URL is embeddable. */
export function hasCodegenInspector(path: string, url: string): boolean {
  const session = sessions.get(path)
  return !!session && !session.stopping && session.sawReady && session.inspectorUrl === url
}

/** Stop the session and return the last source generated by Playwright. */
export function stopCodegen(path: string): Promise<string> {
  const session = sessions.get(path)
  if (!session) return Promise.resolve('')
  session.stopping = true
  return new Promise((resolve) => {
    const finish = (): void => {
      resolve(session.lastCode)
    }
    session.child.once('close', finish)
    session.child.stdin?.end()
    const forceTimer = setTimeout(() => killTree(session.child), 1_500)
    session.child.once('close', () => clearTimeout(forceTimer))
    // never hang an invoke if a broken browser ignores stdin + signals
    setTimeout(() => {
      session.child.off('close', finish)
      finish()
    }, 3_000)
  })
}

/** extract the recorded test body and append it as a named test to a spec */
export function saveCodegen(input: {
  path: string
  file: string
  rootDir: string | null
  testName: string
  code: string
}): CommandResult {
  const { path, file, rootDir, testName, code } = input
  const bodyMatch = code.match(
    /test\((?:'[^']*'|"[^"]*")\s*,\s*async \(\{ page \}\) => \{\n([\s\S]*?)\n\}\);?\s*$/
  )
  if (!bodyMatch) {
    return { ok: false, code: null, error: 'could not find a recorded test in the generated code' }
  }
  const safeName = testName.trim() === '' ? 'recorded test' : testName.trim().replace(/'/g, "\\'")
  const block = `\ntest('${safeName}', async ({ page }) => {\n${bodyMatch[1]}\n});\n`

  const dest = join(path, rootDir ?? '', file)
  // append-only, and never outside the project folder
  if (!dest.startsWith(path + '/')) {
    return { ok: false, code: null, error: 'destination is outside the project' }
  }
  try {
    if (existsSync(dest)) {
      const existing = readFileSync(dest, 'utf8')
      writeFileSync(dest, `${existing.replace(/\s*$/, '\n')}${block}`)
    } else {
      writeFileSync(dest, `import { test, expect } from '@playwright/test';\n${block}`)
    }
    return { ok: true, code: 0 }
  } catch (err) {
    return { ok: false, code: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** delete stale recordings from previous sessions */
export function cleanCodegenDir(): void {
  try {
    rmSync(join(wrightbenchDir(), 'codegen'), { recursive: true, force: true })
  } catch {
    // best effort
  }
}

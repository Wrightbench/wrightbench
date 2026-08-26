import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import type { CodegenInspectorCommand, CodegenInspectorEvent } from '@shared/ipc'

const COMMAND_METHODS = new Set<CodegenInspectorCommand['method']>([
  'clear',
  'fileChanged',
  'setAutoExpect',
  'setMode',
  'resume',
  'pause',
  'step',
  'highlightRequested'
])

const guestGlobal = globalThis as typeof globalThis & { location: { href: string } }
const legacyProtocol =
  new URL(guestGlobal.location.href).searchParams.get('wrightbenchProtocol') === 'legacy'

async function forwardCommand(value: unknown, methodKey: 'method' | 'event'): Promise<void> {
  if (typeof value !== 'object' || value === null) throw new Error('invalid Inspector command')
  const raw = value as { method?: unknown; event?: unknown; params?: unknown }
  const method = raw[methodKey]
  if (
    typeof method !== 'string' ||
    !COMMAND_METHODS.has(method as CodegenInspectorCommand['method'])
  ) {
    throw new Error('unsupported Inspector command')
  }
  const payload: CodegenInspectorCommand = {
    method: method as CodegenInspectorCommand['method'],
    params: raw.params
  }
  if (JSON.stringify(payload).length > 200_000) throw new Error('Inspector command is too large')
  ipcRenderer.sendToHost('wrightbench-recorder-command', payload)
}

/**
 * Playwright's recorder bundle calls this exact global. The guest remains
 * sandboxed; commands cross only to its embedder and are validated again in
 * the main process before reaching the project-local recorder backend.
 */
if (legacyProtocol) {
  contextBridge.exposeInMainWorld('dispatch', (value: unknown) => forwardCommand(value, 'event'))
} else {
  contextBridge.exposeInMainWorld('sendCommand', (value: unknown) => forwardCommand(value, 'method'))
}

const pending: CodegenInspectorEvent[] = []
let flushing = false

async function flush(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    while (pending.length > 0) {
      const event = pending.shift()
      if (!event) continue
      // Base64 keeps project-controlled URLs/source text out of executable JS.
      const encoded = Buffer.from(JSON.stringify(event), 'utf8').toString('base64')
      const delivered = await webFrame.executeJavaScript(
        legacyProtocol
          ? `(() => {
              const event = JSON.parse(atob('${encoded}'));
              const params = event.params || {};
              const handlers = {
                modeChanged: () => globalThis.playwrightSetMode?.(params.mode),
                sourcesUpdated: () => globalThis.playwrightSetSources?.(params.sources),
                pageNavigated: () => globalThis.playwrightSetPageURL?.(params.url),
                pauseStateChanged: () => globalThis.playwrightSetPaused?.(params.paused),
                callLogsUpdated: () => globalThis.playwrightUpdateLogs?.(params.callLogs),
                sourceRevealRequested: () => globalThis.playwrightSelectSource?.(params.sourceId),
                elementPicked: () => globalThis.playwrightElementPicked?.(params.elementInfo, params.userGesture)
              };
              const readiness = {
                modeChanged: 'playwrightSetMode',
                sourcesUpdated: 'playwrightSetSources',
                pageNavigated: 'playwrightSetPageURL',
                pauseStateChanged: 'playwrightSetPaused',
                callLogsUpdated: 'playwrightUpdateLogs',
                sourceRevealRequested: 'playwrightSelectSource',
                elementPicked: 'playwrightElementPicked'
              };
              const globalName = readiness[event.method];
              if (!globalName || typeof globalThis[globalName] !== 'function') return false;
              handlers[event.method]();
              return true;
            })()`
          : `(() => {
              if (typeof globalThis.dispatch !== 'function') return false;
              globalThis.dispatch(JSON.parse(atob('${encoded}')));
              return true;
            })()`,
        true
      )
      if (!delivered) {
        pending.unshift(event)
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
    }
  } finally {
    flushing = false
  }
}

ipcRenderer.on(
  'wrightbench-recorder-event',
  (_event: IpcRendererEvent, value: CodegenInspectorEvent) => {
    pending.push(value)
    if (pending.length > 200) pending.splice(0, pending.length - 200)
    void flush()
  }
)

// The embedder also listens for Electron's dom-ready event. This eager signal
// covers reloads where the guest becomes ready before that listener reattaches.
ipcRenderer.sendToHost('wrightbench-recorder-ready')

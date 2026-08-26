import { create } from 'zustand'
import { errorMessage } from '../lib/errors'
import type {
  CodegenAction,
  CodegenEvent,
  CodegenInspectorCommand,
  CodegenInspectorEvent,
  CodegenViewport
} from '@shared/ipc'

/**
 * State for a genuine Playwright recorder session. Playwright owns the headed
 * browser and Inspector UI; Wrightbench keeps only lifecycle and protocol state
 * so the exact Inspector frontend can stay mounted across destination changes.
 */

type RecordStatus = 'idle' | 'starting' | 'ready' | 'stopping' | 'crashed'
type RecordBrowser = 'chromium' | 'firefox' | 'webkit'

interface CodegenStore {
  path: string | null
  targetId: string | null
  status: RecordStatus
  /** true while the project-local recorder session owns a headed browser */
  recording: boolean
  startedAt: number | null
  url: string
  browser: RecordBrowser
  browserVersion: string | null
  viewport: CodegenViewport
  inspectorUrl: string | null
  inspectorEvents: Array<{ revision: number; event: CodegenInspectorEvent }>
  inspectorRevision: number
  inspectorMode: string
  paused: boolean
  /** retained for stop fallback and diagnostics; rendered by Playwright itself */
  actions: CodegenAction[]
  code: string
  error: string | null

  start(path: string, targetId: string | null, defaultFile?: string | null): Promise<void>
  stop(): Promise<void>
  sendCommand(command: CodegenInspectorCommand): Promise<boolean>
  setUrl(url: string): void
  /** path null = workspace teardown (final project removed) */
  resetForProject(path: string | null, defaultFile?: string | null): void
}

export const useCodegen = create<CodegenStore>((set, get) => {
  const applyEvent = (event: CodegenEvent): void => {
    if (event.type === 'error') {
      // End session is a user-requested clean stop. Ignore a terminal message
      // already queued by the host while that shutdown is in progress.
      if (get().status === 'stopping') return
      set({
        status: 'crashed',
        recording: false,
        startedAt: null,
        inspectorUrl: null,
        inspectorEvents: [],
        error: event.message
      })
      return
    }
    if (event.type === 'ready') {
      set({
        status: 'ready',
        recording: true,
        url: event.pageUrl,
        browserVersion: event.browserVersion,
        viewport: event.viewport,
        inspectorUrl: event.inspectorUrl,
        error: null
      })
      return
    }
    if (event.type === 'inspector') {
      const revision = get().inspectorRevision + 1
      const patch: Partial<CodegenStore> = {
        inspectorEvents: [...get().inspectorEvents, { revision, event: event.event }].slice(-200),
        inspectorRevision: revision
      }
      if (event.event.method === 'pageNavigated') {
        const url = (event.event.params as { url?: unknown } | null)?.url
        if (typeof url === 'string') patch.url = url
      } else if (event.event.method === 'modeChanged') {
        const mode = (event.event.params as { mode?: unknown } | null)?.mode
        if (typeof mode === 'string') patch.inspectorMode = mode
      } else if (event.event.method === 'pauseStateChanged') {
        const paused = (event.event.params as { paused?: unknown } | null)?.paused
        if (typeof paused === 'boolean') patch.paused = paused
      }
      set(patch)
      return
    }

    const patch: Partial<CodegenStore> = { code: event.code, actions: event.actions }
    if (event.type === 'stopped') {
      patch.status = 'idle'
      patch.recording = false
      patch.startedAt = null
      patch.browserVersion = null
      patch.inspectorUrl = null
      patch.inspectorEvents = []
      patch.inspectorMode = 'none'
      patch.paused = false
    }
    set(patch)
  }

  if (window.wrightbench) {
    const unsubscribe = window.wrightbench.codegen.onEvent(({ path, event }) => {
      if (path !== get().path) return
      applyEvent(event)
    })
    import.meta.hot?.dispose(unsubscribe)
  }

  return {
    path: null,
    targetId: null,
    status: 'idle',
    recording: false,
    startedAt: null,
    url: '',
    browser: 'chromium',
    browserVersion: null,
    viewport: { width: 1100, height: 700 },
    inspectorUrl: null,
    inspectorEvents: [],
    inspectorRevision: 0,
    inspectorMode: 'none',
    paused: false,
    actions: [],
    code: '',
    error: null,

    async start(path, targetId) {
      const wb = window.wrightbench
      if (!wb || get().recording || get().status === 'starting') return
      if (!targetId) {
        set({ status: 'crashed', error: 'Choose a Playwright configuration before starting Record.' })
        return
      }
      const current = get()
      set({
        path,
        targetId,
        status: 'starting',
        recording: true,
        startedAt: Date.now(),
        browserVersion: null,
        inspectorUrl: null,
        inspectorEvents: [],
        inspectorMode: 'recording',
        paused: false,
        actions: [],
        code: '',
        error: null
      })
      try {
        await wb.codegen.start({
          path,
          targetId,
          url: current.url.trim() === '' ? null : current.url.trim(),
          browser: current.browser,
          viewport: current.viewport
        })
      } catch (err) {
        set({
          status: 'crashed',
          recording: false,
          startedAt: null,
          inspectorUrl: null,
          error: errorMessage(err)
        })
      }
    },

    async stop() {
      const wb = window.wrightbench
      const { path, recording, status } = get()
      if (!wb || !path || (!recording && status !== 'starting')) return
      set({ status: 'stopping' })
      try {
        const code = await wb.codegen.stop(path)
        // The pushed stopped event normally lands first; this is the fallback.
        if (get().status === 'stopping') {
          set({
            status: 'idle',
            recording: false,
            startedAt: null,
            browserVersion: null,
            inspectorUrl: null,
            inspectorEvents: [],
            inspectorMode: 'none',
            paused: false,
            code: code !== '' ? code : get().code
          })
        }
      } catch (err) {
        set({
          status: 'crashed',
          recording: false,
          startedAt: null,
          inspectorUrl: null,
          error: errorMessage(err)
        })
      }
    },

    async sendCommand(command) {
      const wb = window.wrightbench
      const { path, status } = get()
      if (!wb || !path || status !== 'ready') return false
      try {
        return await wb.codegen.command(path, command)
      } catch (err) {
        set({ error: errorMessage(err) })
        return false
      }
    },

    setUrl(url) {
      set({ url })
    },

    resetForProject(path) {
      set({
        path,
        targetId: null,
        status: 'idle',
        recording: false,
        startedAt: null,
        url: '',
        browserVersion: null,
        inspectorUrl: null,
        inspectorEvents: [],
        inspectorRevision: 0,
        inspectorMode: 'none',
        paused: false,
        actions: [],
        code: '',
        error: null
      })
    }
  }
})

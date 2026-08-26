import { create } from 'zustand'
import { errorMessage } from '../lib/errors'
import { useHistory } from './history'
import type { UiModeEventPayload, UiRecordingInfo } from '@shared/ipc'

/**
 * Embedded Playwright UI Mode session state — deliberately separate from
 * useRun: the Tests tab's tracked runner and the UI Mode session are
 * different execution surfaces with different owners. This store owns the
 * session lifecycle (started on demand when the tab first opens) and the
 * live history-recording status fed by main's uimode:event stream.
 */

export type UiModeStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'external'
  | 'restarting'
  | 'stopped'
  | 'crashed'

export type UiModeLaunchMode = 'embedded' | 'external'

/** Contextual entry starts stopped sessions, while an explicit in-view Stop sticks. */
export function shouldAutoStartUiMode({
  active,
  wasActive,
  status,
  identityChanged,
  opaque
}: {
  active: boolean
  wasActive: boolean
  status: UiModeStatus
  identityChanged: boolean
  opaque: boolean
}): boolean {
  if (
    !active ||
    opaque ||
    status === 'starting' ||
    status === 'restarting' ||
    status === 'external'
  ) {
    return false
  }
  return status === 'idle' || identityChanged || (!wasActive && status === 'stopped')
}

/**
 * Native UI Mode normally exposes run activity through the recording side
 * channel. External sessions and unsupported embedded versions are opaque,
 * so they own execution until the user explicitly stops them.
 */
export function uiModeBlocksOtherWork(state: {
  status: UiModeStatus
  run: UiModeLiveRun | null
  recording: UiRecordingInfo
}): boolean {
  return (
    state.run !== null ||
    state.status === 'starting' ||
    state.status === 'restarting' ||
    state.status === 'external' ||
    (state.status === 'ready' && !state.recording.supported)
  )
}

export interface UiModeLiveRun {
  runNumber: number
  done: number
  total: number
  failed: number
}

export interface UiModeSavedRun {
  runNumber: number
  status: string
  passed: number
  failed: number
  flaky: number
  skipped: number
  total: number
  durationMs: number
  at: number
}

interface UiModeStore {
  /** project path this session belongs to; null before the tab is first opened */
  path: string | null
  /** exact persisted harness target the server was launched for */
  targetId: string | null
  /** actual configuration used when a recipe is mapped to its base target */
  configurationTargetId: string | null
  recipeMappedToBase: boolean
  status: UiModeStatus
  launchMode: UiModeLaunchMode | null
  sessionId: string | null
  url: string | null
  port: number | null
  profile: string | null
  playwrightVersion: string | null
  recording: UiRecordingInfo
  error: string | null
  /** in-flight run started from Playwright's own UI controls */
  run: UiModeLiveRun | null
  /** most recent completed run recorded to history in this session */
  lastSaved: UiModeSavedRun | null

  /** start (or join) the embedded session for the active harness target */
  open(config: { path: string; targetId: string; profile: string | null }): Promise<void>
  restart(): Promise<void>
  /** supported public-CLI fallback when the private embedded server cannot start */
  openExternal(): Promise<void>
  /** explicitly stop an external or embedded UI Mode session */
  stop(): Promise<void>
  /** an idle server for another config must not survive a target change */
  handleTargetSwitch(path: string, nextTargetId: string | null): void
  /** project switched or torn down: stop the previous session, clear to idle */
  handleProjectSwitch(previous: string | null, next: string | null): void
}

function api(): NonNullable<typeof window.wrightbench> | null {
  return window.wrightbench ?? null
}

const NO_RECORDING: UiRecordingInfo = { supported: false, reason: null }

export const useUiMode = create<UiModeStore>((set, get) => {
  // Every renderer-initiated transition owns a generation. A terminal main
  // event invalidates the pending invoke so its later response cannot revive
  // a process that already stopped or crashed.
  let operationGeneration = 0

  if (window.wrightbench) {
    const unsubscribe = window.wrightbench.uimode.onEvent(({ path, event }: UiModeEventPayload) => {
      const state = get()
      if (path !== state.path) return
      if (event.type === 'state') {
        // A workspace path may contain several configs/recipes. Never let a
        // trailing event from the previous target replace the new surface.
        if (
          event.targetId !== null &&
          state.targetId !== null &&
          event.targetId !== state.targetId
        ) {
          return
        }
        // ignore trailing lifecycle noise from a session we already replaced
        const stale =
          event.sessionId !== null &&
          state.sessionId !== null &&
          event.sessionId !== state.sessionId
        if (stale) return
        if (event.state === 'ready' || event.state === 'external') {
          set({
            status: event.state,
            targetId: event.targetId ?? state.targetId,
            configurationTargetId: event.configurationTargetId,
            recipeMappedToBase: event.recipeMappedToBase,
            launchMode: event.launchMode,
            sessionId: event.sessionId,
            url: event.url,
            port: event.port,
            profile: event.profile,
            playwrightVersion: event.playwrightVersion,
            recording: event.recording,
            error: null
          })
        } else if (event.state === 'crashed') {
          operationGeneration += 1
          set({
            status: 'crashed',
            launchMode: null,
            url: null,
            port: null,
            run: null,
            error: event.message
          })
        } else if (event.state === 'stopped') {
          operationGeneration += 1
          set({
            status: 'stopped',
            launchMode: null,
            url: null,
            port: null,
            run: null,
            error: null
          })
        } else if (event.state === 'restarting') {
          set({ status: 'restarting', launchMode: null, run: null, error: null })
        }
        return
      }
      if (event.sessionId !== state.sessionId) return
      if (event.type === 'run-begin') {
        set({ run: { runNumber: event.runNumber, done: 0, total: event.total, failed: 0 } })
      } else if (event.type === 'run-progress') {
        set({
          run: {
            runNumber: event.runNumber,
            done: event.done,
            total: event.total,
            failed: event.failed
          }
        })
      } else if (event.type === 'run-end') {
        set({
          run: null,
          lastSaved: {
            runNumber: event.runNumber,
            status: event.status,
            passed: event.passed,
            failed: event.failed,
            flaky: event.flaky,
            skipped: event.skipped,
            total: event.total,
            durationMs: event.durationMs,
            at: Date.now()
          }
        })
        // global History (and analytics) must be current without re-entering it
        void useHistory.getState().refresh(path)
      }
    })
    import.meta.hot?.dispose(unsubscribe)
  }

  return {
    path: null,
    targetId: null,
    configurationTargetId: null,
    recipeMappedToBase: false,
    status: 'idle',
    launchMode: null,
    sessionId: null,
    url: null,
    port: null,
    profile: null,
    playwrightVersion: null,
    recording: NO_RECORDING,
    error: null,
    run: null,
    lastSaved: null,

    async open({ path, targetId }) {
      const wb = api()
      if (!wb) return
      const state = get()
      const live =
        state.status === 'starting' ||
        state.status === 'ready' ||
        state.status === 'external' ||
        state.status === 'restarting'
      const sameTarget = state.path === path && state.targetId === targetId
      if (sameTarget && live) return
      // Opaque sessions may be executing even when no live reporter row is
      // visible. They can only be replaced by the explicit Stop action.
      if (live && uiModeBlocksOtherWork(state)) return
      const operation = ++operationGeneration
      set({
        path,
        targetId,
        configurationTargetId: null,
        recipeMappedToBase: false,
        status: 'starting',
        launchMode: null,
        sessionId: null,
        url: null,
        port: null,
        error: null,
        run: null,
        lastSaved: sameTarget ? state.lastSaved : null,
        recording: sameTarget ? state.recording : NO_RECORDING
      })
      const profile = null
      set({ profile })
      if (
        operation !== operationGeneration ||
        get().path !== path ||
        get().targetId !== targetId
      ) {
        return
      }
      try {
        const info = await wb.uimode.start({ path, targetId, profile })
        const current = get()
        if (
          operation !== operationGeneration ||
          current.path !== path ||
          current.targetId !== targetId ||
          !(
            current.status === 'starting' ||
            (current.status === 'ready' && current.sessionId === info.sessionId)
          )
        ) {
          return
        }
        set({
          status: 'ready',
          targetId: info.targetId,
          configurationTargetId: info.configurationTargetId,
          recipeMappedToBase: info.recipeMappedToBase,
          launchMode: info.launchMode,
          sessionId: info.sessionId,
          url: info.url,
          port: info.port,
          profile: info.profile,
          playwrightVersion: info.playwrightVersion,
          recording: info.recording,
          error: null
        })
      } catch (err) {
        if (
          operation !== operationGeneration ||
          get().path !== path ||
          get().targetId !== targetId
        ) {
          return
        }
        // A CLI run/project switch can deliberately stop an in-flight start.
        if (get().status === 'starting') {
          set({ status: 'crashed', launchMode: null, error: errorMessage(err) })
        }
      }
    },

    async restart() {
      const wb = api()
      const state = get()
      const { path, targetId, profile } = state
      if (!wb || !path || !targetId) return
      if (uiModeBlocksOtherWork(state)) return
      const operation = ++operationGeneration
      set({
        status: 'restarting',
        launchMode: null,
        sessionId: null,
        url: null,
        port: null,
        run: null,
        error: null
      })
      try {
        const info = await wb.uimode.restart({ path, targetId, profile })
        const current = get()
        if (
          operation !== operationGeneration ||
          current.path !== path ||
          current.targetId !== targetId ||
          !(
            current.status === 'restarting' ||
            current.status === 'starting' ||
            (current.status === 'ready' && current.sessionId === info.sessionId)
          )
        ) {
          return
        }
        set({
          status: 'ready',
          targetId: info.targetId,
          configurationTargetId: info.configurationTargetId,
          recipeMappedToBase: info.recipeMappedToBase,
          launchMode: info.launchMode,
          sessionId: info.sessionId,
          url: info.url,
          port: info.port,
          profile: info.profile,
          playwrightVersion: info.playwrightVersion,
          recording: info.recording,
          error: null
        })
      } catch (err) {
        if (
          operation !== operationGeneration ||
          get().path !== path ||
          get().targetId !== targetId
        ) {
          return
        }
        if (get().status === 'restarting') {
          set({ status: 'crashed', launchMode: null, error: errorMessage(err) })
        }
      }
    },

    async openExternal() {
      const wb = api()
      const state = get()
      const { path, targetId, profile } = state
      if (!wb || !path || !targetId) return
      if (uiModeBlocksOtherWork(state)) return
      const operation = ++operationGeneration
      set({
        status: 'starting',
        launchMode: null,
        sessionId: null,
        url: null,
        port: null,
        run: null,
        lastSaved: null,
        error: null
      })
      try {
        const info = await wb.uimode.openExternal({ path, targetId, profile })
        const current = get()
        if (
          operation !== operationGeneration ||
          current.path !== path ||
          current.targetId !== targetId ||
          !(
            current.status === 'starting' ||
            (current.status === 'external' && current.sessionId === info.sessionId)
          )
        ) {
          return
        }
        set({
          status: 'external',
          targetId: info.targetId,
          configurationTargetId: info.configurationTargetId,
          recipeMappedToBase: info.recipeMappedToBase,
          launchMode: info.launchMode,
          sessionId: info.sessionId,
          url: null,
          port: null,
          profile: info.profile,
          playwrightVersion: info.playwrightVersion,
          recording: info.recording,
          error: null
        })
      } catch (err) {
        if (
          operation !== operationGeneration ||
          get().path !== path ||
          get().targetId !== targetId
        ) {
          return
        }
        if (get().status === 'starting') {
          set({ status: 'crashed', launchMode: null, error: errorMessage(err) })
        }
      }
    },

    async stop() {
      const wb = api()
      const { path, targetId } = get()
      if (!wb || !path) return
      operationGeneration += 1
      set({ error: null })
      try {
        await wb.uimode.stop(path)
        if (get().path !== path || get().targetId !== targetId) return
        // main normally emits the stopped state; keep this as a fallback for
        // an external window that exits before its event reaches the renderer.
        set({
          status: 'stopped',
          launchMode: null,
          sessionId: null,
          url: null,
          port: null,
          run: null,
          error: null
        })
      } catch (err) {
        if (get().path !== path || get().targetId !== targetId) return
        // A failed stop does not prove an opaque process has exited. Preserve
        // ownership (and its blocking status) so recorded work cannot race it.
        set({ error: `Could not stop UI Mode — ${errorMessage(err)}` })
      }
    },

    handleTargetSwitch(path, nextTargetId) {
      const state = get()
      if (
        state.path !== path ||
        state.targetId === null ||
        state.targetId === nextTargetId
      ) {
        return
      }
      operationGeneration += 1
      const wb = api()
      if (wb) void wb.uimode.stop(path)
      set({
        path: null,
        targetId: null,
        configurationTargetId: null,
        recipeMappedToBase: false,
        status: 'idle',
        launchMode: null,
        sessionId: null,
        url: null,
        port: null,
        profile: null,
        playwrightVersion: null,
        recording: NO_RECORDING,
        error: null,
        run: null,
        lastSaved: null
      })
    },

    handleProjectSwitch(previous, next) {
      if (previous === next) return
      operationGeneration += 1
      const wb = api()
      if (previous && wb) void wb.uimode.stop(previous)
      set({
        path: null,
        targetId: null,
        configurationTargetId: null,
        recipeMappedToBase: false,
        status: 'idle',
        launchMode: null,
        sessionId: null,
        url: null,
        port: null,
        profile: null,
        playwrightVersion: null,
        recording: NO_RECORDING,
        error: null,
        run: null,
        lastSaved: null
      })
    }
  }
})

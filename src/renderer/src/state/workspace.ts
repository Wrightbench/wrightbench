import { create } from 'zustand'
import { errorMessage } from '../lib/errors'
import { useHistory } from './history'
import { useRun } from './run'
import { useUiMode } from './uimode'
import type { ProjectInspection, ProjectWithHealth } from '@shared/ipc'
import {
  LATEST_VERIFIED_PLAYWRIGHT_VERSION,
  playwrightScaffoldOption,
  playwrightCompatibility,
  type PlaywrightScaffoldSelection
} from '@shared/playwright-compat'

export type Screen =
  | { name: 'welcome' }
  | { name: 'inspecting'; path: string }
  | {
      name: 'detection'
      inspection: ProjectInspection
      /** candidate the user picked on the card (defaults to the recommendation) */
      selectedTargetId: string | null
    }
  | { name: 'scaffold-setup'; path: string; version: PlaywrightScaffoldSelection }
  | {
      name: 'scaffolding'
      path: string
      version: PlaywrightScaffoldSelection
      lines: string[]
      error: string | null
    }
  | { name: 'workspace' }

export type WorkspaceTab = 'Tests' | 'UI Mode' | 'Runs' | 'Codegen'

interface WorkspaceStore {
  screen: Screen
  projects: ProjectWithHealth[]
  activeProjectId: string | null
  /** surfaced failure from the last action (add/inspect), shown on the card */
  lastError: string | null
  /** active main tab */
  tab: WorkspaceTab
  /** temporary contextual viewer for a trace opened from disk */
  externalTraceOpen: boolean
  /** contextual native UI Mode takeover; hidden sessions stay mounted */
  uiModeOpen: boolean
  /** global embedded Playwright recorder destination */
  recordOpen: boolean
  /** global, project-scoped history destination (does not stop either runner) */
  historyOpen: boolean
  /** global Settings destination; a quiet full window only during import recovery */
  settingsOpen: boolean
  init(): Promise<void>
  pickAndInspect(): Promise<void>
  openFolder(
    path: string,
    /** candidate to keep selected after an explicit retry */
    preferredTargetId?: string | null
  ): Promise<void>
  scaffold(): Promise<void>
  selectScaffoldVersion(version: PlaywrightScaffoldSelection): void
  confirmScaffold(): Promise<void>
  confirmAdd(): Promise<void>
  cancelDetection(): void
  /** pick which discovered harness target the import should activate */
  selectDetectionTarget(targetId: string): void
  /** re-run passive detection after the user restores project dependencies */
  reinspect(): Promise<void>
  /** user-selected config fallback on the detection card */
  pickConfigForDetection(): Promise<void>
  setActiveProject(id: string): void
  /** drop the registry entry (files + history untouched); handles active/final */
  removeProject(id: string): Promise<void>
  /** re-derive health now (the missing-project Retry button) */
  refreshProjects(): Promise<void>
  setTab(tab: WorkspaceTab): void
  openExternalTrace(): void
  closeExternalTrace(): void
  openRecord(): void
  openUiMode(): void
  openCliMode(): void
  openHistory(): void
  closeUiMode(): void
  openSettings(): void
  closeSettings(): void
}

/** Outside Electron (browser preview) project actions are inert, not errors. */
function api(): NonNullable<typeof window.wrightbench> | null {
  return window.wrightbench ?? null
}

/** the active-project fallback every surface shares (newest project wins) */
function resolveActive(
  projects: ProjectWithHealth[],
  activeProjectId: string | null
): ProjectWithHealth | null {
  return projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null
}

/** Monotonic guard for overlapping import inspections of the same folder. */
let inspectionRequestSequence = 0

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  if (window.wrightbench) {
    const unsubscribe = window.wrightbench.project.onProgress((progress) => {
      const state = get()
      if (progress.kind === 'scaffold' && state.screen.name === 'scaffolding') {
        if (state.screen.path !== progress.path) return
        set({
          screen: { ...state.screen, lines: [...state.screen.lines.slice(-199), progress.line] }
        })
      }
    })
    // main pushes registry/health flips (folder deleted, restored, add/remove)
    const unsubscribeProjects = window.wrightbench.projects.onChanged((projects) => {
      const state = get()
      const previousActive = resolveActive(state.projects, state.activeProjectId)
      set({ projects })
      const nowActive = resolveActive(projects, get().activeProjectId)
      if (!nowActive || previousActive?.path !== nowActive.path) return
      const was = previousActive.health.state
      const now = nowActive.health.state
      // the active folder came back: reload its tree without user action
      if (was !== 'available' && now === 'available' && useRun.getState().path === nowActive.path) {
        void useRun.getState().loadTree()
      }
      // the active folder vanished: clear the stale tree immediately and
      // stop everything that depends on the repository (history stays)
      if (was === 'available' && now !== 'available') {
        set({ uiModeOpen: false, recordOpen: false })
        useUiMode.getState().handleProjectSwitch(nowActive.path, null)
        if (useRun.getState().path === nowActive.path) {
          useRun.getState().handleActiveUnavailable()
        }
      }
    })
    import.meta.hot?.dispose(() => {
      unsubscribe()
      unsubscribeProjects()
    })
  }

  return {
    screen: { name: 'welcome' },
    projects: [],
    activeProjectId: null,
    lastError: null,
    tab: 'Tests',
    externalTraceOpen: false,
    uiModeOpen: false,
    recordOpen: false,
    historyOpen: false,
    settingsOpen: false,

    async init() {
      if (!window.wrightbench) return
      const projects = await window.wrightbench.projects.list()
      const latest = projects[projects.length - 1] ?? null
      // never stomp a flow the user already started (e.g. instant drag-drop)
      if (get().screen.name === 'welcome' && projects.length > 0) {
        set({
          projects,
          activeProjectId: latest?.id ?? null,
          screen: { name: 'workspace' },
          uiModeOpen: true,
          recordOpen: false,
          historyOpen: false,
          externalTraceOpen: false
        })
      } else {
        set({ projects, activeProjectId: latest?.id ?? null })
      }
      // Report is SQLite-owned and must be ready independently of whether a
      // new Playwright run occurs during this renderer session.
      if (latest) void useHistory.getState().refresh(latest.path)
    },

    async pickAndInspect() {
      const wb = api()
      if (!wb) return
      const path = await wb.project.pickFolder()
      if (!path) return
      await get().openFolder(path)
    },

    async openFolder(path, preferredTargetId) {
      const wb = api()
      if (!wb) return
      // scaffolding must not be interrupted; a running inspect is simply
      // superseded (the stale-response guard below discards its result)
      if (get().screen.name === 'scaffolding') return
      const requestId = ++inspectionRequestSequence
      const currentScreen = get().screen
      const previousDetection =
        currentScreen.name === 'detection' && currentScreen.inspection.path === path
          ? currentScreen
          : null
      set({
        screen: { name: 'inspecting', path },
        lastError: null
      })
      try {
        // The project owns environment resolution. Wrightbench never overlays a
        // stored profile on import discovery.
        if (requestId !== inspectionRequestSequence) return
        const inspection = await wb.project.inspect(path, null)
        const current = get().screen
        if (
          requestId !== inspectionRequestSequence ||
          current.name !== 'inspecting' ||
          current.path !== path
        )
          return
        set({
          screen: {
            name: 'detection',
            inspection,
            selectedTargetId:
              preferredTargetId !== null &&
              preferredTargetId !== undefined &&
              inspection.targets.some((target) => target.id === preferredTargetId)
                ? preferredTargetId
                : inspection.recommendedTargetId
          }
        })
      } catch (err) {
        const current = get().screen
        if (
          requestId !== inspectionRequestSequence ||
          current.name !== 'inspecting' ||
          current.path !== path
        )
          return
        set({
          screen:
            previousDetection ??
            (get().projects.length > 0 ? { name: 'workspace' } : { name: 'welcome' }),
          lastError: `could not inspect folder — ${errorMessage(err)}`
        })
      }
    },

    async scaffold() {
      const wb = api()
      if (!wb) return
      const path = await wb.project.pickFolder()
      if (!path) return
      inspectionRequestSequence += 1
      set({
        screen: {
          name: 'scaffold-setup',
          path,
          version: LATEST_VERIFIED_PLAYWRIGHT_VERSION
        },
        lastError: null
      })
    },

    selectScaffoldVersion(version) {
      const { screen } = get()
      if (screen.name !== 'scaffold-setup' || playwrightScaffoldOption(version) === null) return
      set({ screen: { ...screen, version } })
    },

    async confirmScaffold() {
      const wb = api()
      const setup = get().screen
      if (!wb || setup.name !== 'scaffold-setup') return
      const { path, version } = setup
      const requestId = ++inspectionRequestSequence
      set({
        screen: { name: 'scaffolding', path, version, lines: [], error: null },
        lastError: null
      })
      let result
      try {
        result = await wb.project.scaffold(path, version)
      } catch (err) {
        result = { ok: false, code: null, error: errorMessage(err) }
      }
      const current = get().screen
      if (
        requestId !== inspectionRequestSequence ||
        current.name !== 'scaffolding' ||
        current.path !== path
      )
        return
      if (!result.ok) {
        set({
          screen: {
            ...current,
            error: result.error ?? `setup failed (exit code ${result.code ?? '?'})`
          }
        })
        return
      }
      set({ screen: { name: 'inspecting', path } })
      const inspection = await wb.project.inspect(path, null)
      const after = get().screen
      if (
        requestId !== inspectionRequestSequence ||
        after.name !== 'inspecting' ||
        after.path !== path
      )
        return
      set({
        screen: { name: 'detection', inspection, selectedTargetId: inspection.recommendedTargetId }
      })
    },

    async confirmAdd() {
      const wb = api()
      if (!wb) return
      const { screen } = get()
      if (screen.name !== 'detection') return
      const { inspection, selectedTargetId } = screen
      const chosen =
        inspection.targets.find((t) => t.id === selectedTargetId) ??
        inspection.targets.find((t) => t.id === inspection.recommendedTargetId) ??
        null
      const compatibility = playwrightCompatibility(chosen?.playwrightVersion ?? null)
      if (!compatibility.supported) {
        set({
          lastError: compatibility.message
        })
        return
      }
      try {
        const projects = await wb.projects.add({
          name: inspection.name,
          path: inspection.path,
          playwrightVersion: chosen?.playwrightVersion ?? inspection.playwrightVersion,
          nodeVersion: null,
          testCount: null,
          activeTargetId: chosen?.id ?? null,
          envProfile: null
        })
        const added = projects.find((p) => p.path === inspection.path) ?? null
        set({
          projects,
          activeProjectId: added?.id ?? null,
          screen: { name: 'workspace' },
          uiModeOpen: true,
          recordOpen: false,
          historyOpen: false,
          externalTraceOpen: false,
          lastError: null
        })
        if (added) void useHistory.getState().refresh(added.path)
      } catch (err) {
        set({ lastError: `could not save project — ${errorMessage(err)}` })
      }
    },

    selectDetectionTarget(targetId) {
      const { screen } = get()
      if (screen.name !== 'detection') return
      if (!screen.inspection.targets.some((t) => t.id === targetId)) return
      set({ screen: { ...screen, selectedTargetId: targetId } })
    },

    async reinspect() {
      const { screen } = get()
      if (screen.name !== 'detection') return
      await get().openFolder(screen.inspection.path, screen.selectedTargetId)
    },

    async pickConfigForDetection() {
      const wb = api()
      const { screen } = get()
      if (!wb || screen.name !== 'detection') return
      const path = screen.inspection.path
      const requestId = ++inspectionRequestSequence
      try {
        const result = await wb.project.pickConfigTarget(path, null)
        if (requestId !== inspectionRequestSequence) return
        if (result.cancelled) return
        if (result.error !== null) {
          set({ lastError: result.error })
          return
        }
        const current = get().screen
        if (current.name !== 'detection' || current.inspection.path !== path) return
        if (result.inspection) {
          set({
            lastError: null,
            screen: {
              name: 'detection',
              inspection: result.inspection,
              selectedTargetId: result.inspection.recommendedTargetId
            }
          })
        } else {
          // an already-registered folder: main persisted the pick directly —
          // re-inspect so the card reflects it instead of silently no-oping
          await get().openFolder(path)
        }
      } catch (err) {
        set({ lastError: `could not use that config — ${errorMessage(err)}` })
      }
    },

    setActiveProject(id) {
      // Project scope changes independently from the chosen destination.
      // initWorkspace drains the old project's session; keeping uiModeOpen
      // lets the new project resolve and open in the same global mode.
      const project = get().projects.find((candidate) => candidate.id === id) ?? null
      set({ activeProjectId: id, externalTraceOpen: false })
      if (project) void useHistory.getState().refresh(project.path)
    },

    async removeProject(id) {
      const wb = api()
      if (!wb) return
      const state = get()
      const index = state.projects.findIndex((p) => p.id === id)
      if (index === -1) return
      const wasActive = resolveActive(state.projects, state.activeProjectId)?.id === id
      // successor: the next project in the existing ordering, else the previous
      const successorId = state.projects[index + 1]?.id ?? state.projects[index - 1]?.id ?? null
      let projects: ProjectWithHealth[]
      try {
        projects = await wb.projects.remove(id)
      } catch (err) {
        set({ lastError: `could not remove project — ${errorMessage(err)}` })
        return
      }
      if (!wasActive) {
        // the active project must not be reset or reloaded
        set({ projects, lastError: null })
        return
      }
      const successor = projects.find((p) => p.id === successorId) ?? null
      if (successor) {
        set({
          projects,
          activeProjectId: successor.id,
          lastError: null
        })
        void useHistory.getState().refresh(successor.path)
        return
      }
      // final project removed: explicit teardown — there is no next path whose
      // initWorkspace could clean the old sessions up
      useRun.getState().teardownWorkspace()
      set({
        projects,
        activeProjectId: null,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        lastError: null,
        screen: { name: 'welcome' }
      })
    },

    async refreshProjects() {
      const wb = api()
      if (!wb) return
      try {
        const projects = await wb.projects.list()
        const before = resolveActive(get().projects, get().activeProjectId)
        set({ projects })
        const after = resolveActive(projects, get().activeProjectId)
        if (after && before?.path === after.path && useRun.getState().path === after.path) {
          if (before.health.state !== 'available' && after.health.state === 'available') {
            void useRun.getState().loadTree()
          } else if (before.health.state === 'available' && after.health.state !== 'available') {
            set({ uiModeOpen: false, recordOpen: false })
            useUiMode.getState().handleProjectSwitch(after.path, null)
            useRun.getState().handleActiveUnavailable()
          }
        }
      } catch {
        // health stays as last known
      }
    },

    setTab(tab) {
      set({
        tab,
        externalTraceOpen: false,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        settingsOpen: false
      })
    },

    openExternalTrace() {
      set({
        externalTraceOpen: true,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        settingsOpen: false
      })
    },

    closeExternalTrace() {
      set({ externalTraceOpen: false })
    },

    openRecord() {
      set({
        recordOpen: true,
        uiModeOpen: false,
        historyOpen: false,
        externalTraceOpen: false,
        settingsOpen: false
      })
    },

    openUiMode() {
      set({
        uiModeOpen: true,
        recordOpen: false,
        historyOpen: false,
        externalTraceOpen: false,
        settingsOpen: false
      })
    },

    openCliMode() {
      set({
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        externalTraceOpen: false,
        settingsOpen: false
      })
    },

    openHistory() {
      // History is read-only navigation. Keep an idle or active UI Mode
      // session mounted behind it and never alter execution ownership here.
      set({ historyOpen: true, recordOpen: false, externalTraceOpen: false, settingsOpen: false })
      const active = resolveActive(get().projects, get().activeProjectId)
      if (active) void useHistory.getState().refresh(active.path)
    },

    closeUiMode() {
      set({ uiModeOpen: false })
    },

    openSettings() {
      set({ settingsOpen: true })
    },

    closeSettings() {
      set({ settingsOpen: false })
    },

    cancelDetection() {
      inspectionRequestSequence += 1
      set({
        screen: get().projects.length > 0 ? { name: 'workspace' } : { name: 'welcome' },
        lastError: null
      })
    }
  }
})

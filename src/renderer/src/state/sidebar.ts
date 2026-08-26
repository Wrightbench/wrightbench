import { create } from 'zustand'
import { pruneViewContext } from '@/lib/sidebar'
import { useRun } from './run'
import { useWorkspace } from './workspace'
import type {
  ProjectViewContext,
  ProjectWithHealth,
  TestStatusFilter,
  WorkspaceUiState
} from '@shared/ipc'
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@shared/ipc'

/**
 * Sidebar chrome + view context: collapse/width, the tests filter, and
 * per-project persisted context (~/.wrightbench/settings.json via the typed
 * settings IPC — never localStorage). Project selection, the tree,
 * run statuses, and health stay owned by their existing stores; this store
 * only observes them (imports point sidebar → run/workspace, never back).
 */

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)))
}

function resolveActive(
  projects: ProjectWithHealth[],
  activeProjectId: string | null
): ProjectWithHealth | null {
  return projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null
}

const EMPTY_CONTEXT: ProjectViewContext = {
  expandedFiles: [],
  selectedKey: null,
  query: '',
  statusFilter: 'all',
  scrollTop: 0,
  envProfile: null
}

interface SidebarStore {
  collapsed: boolean
  width: number
  query: string
  statusFilter: TestStatusFilter
  filterOpen: boolean
  /** per-project persisted view contexts, keyed by project id */
  views: Record<string, ProjectViewContext>
  /** scroll offset to restore once the tree has rendered */
  pendingScrollTop: number | null
  /** transient "Copied" feedback */
  copiedNote: boolean

  init(): Promise<void>
  setWidth(px: number): void
  commitWidth(): void
  resetWidth(): void
  toggleCollapsed(): void
  setQuery(query: string): void
  setStatusFilter(filter: TestStatusFilter): void
  setFilterOpen(open: boolean): void
  clearFilters(): void
  noteScroll(top: number): void
  consumePendingScroll(): number | null
  showCopied(): void
}

export const useSidebar = create<SidebarStore>((set, get) => {
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let scrollTimer: ReturnType<typeof setTimeout> | null = null
  let copiedTimer: ReturnType<typeof setTimeout> | null = null
  let lastScrollTop = 0
  let initialized = false

  const activeProject = (): ProjectWithHealth | null => {
    const ws = useWorkspace.getState()
    return resolveActive(ws.projects, ws.activeProjectId)
  }

  const persist = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const wb = window.wrightbench
      if (!wb || !initialized) return
      const { collapsed, width, views } = get()
      const workspaceUi: WorkspaceUiState = {
        sidebarCollapsed: collapsed,
        sidebarWidth: width,
        projectViews: views
      }
      void wb.settings.update({ workspaceUi }).catch(() => {})
    }, 600)
  }

  /**
   * Continuous capture: mirror the live view into views[activeId] whenever
   * the loaded project's state changes. Transitional states (tree not yet
   * listed, path mismatch mid-switch) never overwrite a saved context.
   */
  const recordCurrent = (): void => {
    const active = activeProject()
    const run = useRun.getState()
    if (!active || run.path !== active.path || run.tree === null) return
    const saved = get().views[active.id] ?? EMPTY_CONTEXT
    const expandedFiles = Object.entries(run.expandedFiles)
      .filter(([, open]) => open)
      .map(([file]) => file)
      .slice(0, 200)
    const { query, statusFilter } = get()
    set({
      views: {
        ...get().views,
        [active.id]: {
          expandedFiles,
          selectedKey: run.selectedKey,
          query: query.slice(0, 200),
          statusFilter,
          scrollTop: lastScrollTop,
          // Legacy profile values remain dormant and are not silently erased
          // when another piece of per-project view state is persisted.
          envProfile: saved.envProfile
        }
      }
    })
    persist()
  }

  /** project switch/boot: adopt the saved query/filter before the tree lands */
  const applyFilterContext = (projectId: string | null): void => {
    const ctx = (projectId !== null ? get().views[projectId] : null) ?? EMPTY_CONTEXT
    set({
      query: ctx.query,
      statusFilter: ctx.statusFilter,
      filterOpen: ctx.query !== '' || ctx.statusFilter !== 'all',
      pendingScrollTop: ctx.scrollTop > 0 ? ctx.scrollTop : null
    })
    lastScrollTop = ctx.scrollTop
  }

  if (window.wrightbench) {
    let trackedProjectId: string | null = null
    let trackedIds = new Set<string>()

    const unsubWorkspace = useWorkspace.subscribe((state) => {
      const active = resolveActive(state.projects, state.activeProjectId)
      const activeId = active?.id ?? null
      if (activeId !== trackedProjectId) {
        trackedProjectId = activeId
        applyFilterContext(activeId)
      }
      // a removed project takes its saved context with it
      const ids = new Set(state.projects.map((p) => p.id))
      if (trackedIds.size > 0) {
        const dropped = [...trackedIds].filter((id) => !ids.has(id) && id in get().views)
        if (dropped.length > 0) {
          const views = { ...get().views }
          for (const id of dropped) delete views[id]
          set({ views })
          persist()
        }
      }
      trackedIds = ids
    })

    // restore expansion/selection when a fresh tree lands (switch, recovery)
    const unsubRun = useRun.subscribe((state, previous) => {
      if (previous.tree === null && state.tree !== null) {
        const active = activeProject()
        if (active && state.path === active.path) {
          const saved = get().views[active.id]
          if (saved) {
            const pruned = pruneViewContext(saved, state.tree)
            if (pruned.expandedFiles.length > 0 || pruned.selectedKey !== null) {
              useRun.setState({
                expandedFiles: Object.fromEntries(pruned.expandedFiles.map((f) => [f, true])),
                selectedKey: pruned.selectedKey
              })
            }
          }
        }
      }
      if (
        previous.expandedFiles !== state.expandedFiles ||
        previous.selectedKey !== state.selectedKey ||
        (previous.tree !== state.tree && state.tree !== null)
      ) {
        recordCurrent()
      }
    })

    import.meta.hot?.dispose(() => {
      unsubWorkspace()
      unsubRun()
    })
  }

  return {
    collapsed: false,
    width: SIDEBAR_DEFAULT_WIDTH,
    query: '',
    statusFilter: 'all',
    filterOpen: false,
    views: {},
    pendingScrollTop: null,
    copiedNote: false,

    async init() {
      const wb = window.wrightbench
      if (!wb || initialized) {
        initialized = true
        return
      }
      try {
        const settings = await wb.settings.get()
        const ui = settings.workspaceUi
        set({
          collapsed: ui.sidebarCollapsed,
          width: clampWidth(ui.sidebarWidth),
          views: ui.projectViews
        })
        initialized = true
        applyFilterContext(activeProject()?.id ?? null)
      } catch {
        initialized = true
      }
    },

    setWidth(px) {
      set({ width: clampWidth(px) })
    },

    commitWidth() {
      persist()
    },

    resetWidth() {
      set({ width: SIDEBAR_DEFAULT_WIDTH })
      persist()
    },

    toggleCollapsed() {
      set({ collapsed: !get().collapsed })
      persist()
    },

    setQuery(query) {
      set({ query })
      recordCurrent()
    },

    setStatusFilter(statusFilter) {
      set({ statusFilter })
      recordCurrent()
    },

    setFilterOpen(open) {
      set({ filterOpen: open })
    },

    clearFilters() {
      set({ query: '', statusFilter: 'all' })
      recordCurrent()
    },

    noteScroll(top) {
      lastScrollTop = Math.max(0, Math.round(top))
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        scrollTimer = null
        recordCurrent()
      }, 400)
    },

    consumePendingScroll() {
      const pending = get().pendingScrollTop
      if (pending !== null) set({ pendingScrollTop: null })
      return pending
    },

    showCopied() {
      if (copiedTimer) clearTimeout(copiedTimer)
      set({ copiedNote: true })
      copiedTimer = setTimeout(() => {
        copiedTimer = null
        set({ copiedNote: false })
      }, 1_500)
    }
  }
})

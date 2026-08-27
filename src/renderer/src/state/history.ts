import { create } from 'zustand'
import type { HistoryAnalytics, HistoryDateRange, RunRecord } from '@shared/ipc'

export type HistoryRangePreset = 'all' | 'today' | '7d' | '30d' | '90d' | 'custom'

export interface HistoryRange extends HistoryDateRange {
  preset: HistoryRangePreset
}

export const ALL_HISTORY_RANGE: HistoryRange = {
  preset: 'all',
  from: null,
  to: null
}

interface HistoryStore {
  /** calendar window shared by every project-level Reports surface */
  dateRange: HistoryRange
  /** project whose SQLite snapshot is currently represented below */
  projectPath: string | null
  runs: RunRecord[]
  analytics: HistoryAnalytics | null
  loading: boolean
  error: string | null

  refresh(path: string): Promise<void>
  setDateRange(range: HistoryRange): void
  /** clear when the workspace no longer has a project */
  reset(): void
}

let refreshSeq = 0

export const useHistory = create<HistoryStore>((set, get) => ({
  dateRange: ALL_HISTORY_RANGE,
  projectPath: null,
  runs: [],
  analytics: null,
  loading: false,
  error: null,

  async refresh(path) {
    const wb = window.wrightbench
    if (!wb) return
    const seq = ++refreshSeq
    const projectChanged = get().projectPath !== path
    set({
      projectPath: path,
      loading: true,
      error: null,
      ...(projectChanged ? { runs: [], analytics: null } : {})
    })
    try {
      const [runs, analytics] = await Promise.all([
        wb.history.runs(path, get().dateRange, 500),
        wb.history.analytics(path, get().dateRange)
      ])
      if (seq !== refreshSeq || get().projectPath !== path) return
      set({ runs, analytics, loading: false })
    } catch (err) {
      if (seq !== refreshSeq || get().projectPath !== path) return
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  // the RunsView effect owns refreshing — the setter just updates state
  setDateRange(dateRange) {
    set({ dateRange })
  },

  reset() {
    refreshSeq += 1 // invalidate any in-flight refresh
    set({
      dateRange: ALL_HISTORY_RANGE,
      projectPath: null,
      runs: [],
      analytics: null,
      loading: false,
      error: null
    })
  }
}))

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
  runs: RunRecord[]
  analytics: HistoryAnalytics | null
  loading: boolean
  error: string | null

  refresh(path: string): Promise<void>
  setDateRange(range: HistoryRange): void
  /** clear on project switch so A's data never renders under B */
  reset(): void
}

let refreshSeq = 0

export const useHistory = create<HistoryStore>((set, get) => ({
  dateRange: ALL_HISTORY_RANGE,
  runs: [],
  analytics: null,
  loading: false,
  error: null,

  async refresh(path) {
    const wb = window.wrightbench
    if (!wb) return
    const seq = ++refreshSeq
    set({ loading: true, error: null })
    try {
      const [runs, analytics] = await Promise.all([
        wb.history.runs(path, get().dateRange, 500),
        wb.history.analytics(path, get().dateRange)
      ])
      if (seq !== refreshSeq) return
      set({ runs, analytics, loading: false })
    } catch (err) {
      if (seq !== refreshSeq) return
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
      runs: [],
      analytics: null,
      loading: false,
      error: null
    })
  }
}))

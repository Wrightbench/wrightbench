import { create } from 'zustand'
import type { TraceLibEntry } from '@shared/ipc'

/** trace library + hosted viewer state (screen 12) */

export interface ExternalTrace {
  path: string
  fileName: string
  sizeBytes: number | null
}

interface TracesStore {
  path: string | null
  entries: TraceLibEntry[]
  /** zips opened via Open…/drop, newest first */
  externals: ExternalTrace[]
  filter: string
  selectedPath: string | null
  viewerUrl: string | null
  viewerError: string | null
  loading: boolean

  load(path: string): Promise<void>
  select(zipPath: string): Promise<void>
  addExternal(path: string, zipPath: string): Promise<void>
  setFilter(filter: string): void
}

let loadSeq = 0

export const useTraces = create<TracesStore>((set, get) => ({
  path: null,
  entries: [],
  externals: [],
  filter: '',
  selectedPath: null,
  viewerUrl: null,
  viewerError: null,
  loading: false,

  async load(path) {
    const wb = window.wrightbench
    if (!wb) return
    const seq = ++loadSeq
    const fresh = get().path !== path
    if (fresh) {
      set({
        path,
        entries: [],
        externals: [],
        filter: '',
        selectedPath: null,
        viewerUrl: null,
        viewerError: null
      })
    }
    set({ loading: true })
    try {
      const entries = await wb.traces.list(path)
      if (seq !== loadSeq) return
      set({ entries, loading: false })
      // auto-select the newest trace on first open
      if (get().selectedPath === null && entries.length > 0) {
        const first = entries.find((e) => e.sizeBytes !== null)
        if (first) void get().select(first.path)
      }
    } catch {
      if (seq === loadSeq) set({ loading: false })
    }
  },

  async select(zipPath) {
    const wb = window.wrightbench
    const path = get().path
    if (!wb || !path) return
    set({ selectedPath: zipPath, viewerError: null })
    try {
      const { url } = await wb.traces.serve(path, zipPath)
      if (get().selectedPath === zipPath) set({ viewerUrl: url })
    } catch (err) {
      if (get().selectedPath === zipPath) {
        set({ viewerUrl: null, viewerError: err instanceof Error ? err.message : String(err) })
      }
    }
  },

  async addExternal(path, zipPath) {
    // the library belongs to a project; adopt it if none is loaded yet
    if (get().path !== path) await get().load(path)
    const fileName = zipPath.split(/[\\/]/).pop() ?? zipPath
    if (!get().externals.some((e) => e.path === zipPath)) {
      set({
        externals: [{ path: zipPath, fileName, sizeBytes: null }, ...get().externals]
      })
    }
    await get().select(zipPath)
  },

  setFilter(filter) {
    set({ filter })
  }
}))

import { create } from 'zustand'
import type { NodeInfo, StorageStats, WrightbenchSettings } from '@shared/ipc'

/**
 * Global settings (screen 10). Density and code font apply as document-level
 * attributes so any screen can restyle from CSS.
 */

const CODE_FONT_STACKS: Record<WrightbenchSettings['codeFont'], string | null> = {
  'jetbrains-mono': null, // tokens.css default
  'sf-mono': "'SF Mono', Menlo, monospace",
  menlo: 'Menlo, monospace'
}

function applySettings(settings: WrightbenchSettings): void {
  document.documentElement.dataset.density = settings.density
  const stack = CODE_FONT_STACKS[settings.codeFont]
  if (stack === null) document.documentElement.style.removeProperty('--font-mono')
  else document.documentElement.style.setProperty('--font-mono', stack)
}

interface SettingsStore {
  settings: WrightbenchSettings | null
  storage: StorageStats | null
  nodeInfo: NodeInfo | null
  /** "removed 12 runs" feedback after Clear old artifacts */
  clearedNote: string | null
  load(): Promise<void>
  /** false means the main process rejected or could not persist the patch */
  update(patch: Partial<WrightbenchSettings>): Promise<boolean>
  refreshStorage(): Promise<void>
  clearArtifacts(): Promise<void>
}

export const useSettings = create<SettingsStore>((set, get) => {
  if (window.wrightbench) {
    const unsubscribe = window.wrightbench.settings.onChanged((settings) => {
      set({ settings })
      applySettings(settings)
    })
    import.meta.hot?.dispose(unsubscribe)
  }

  return {
    settings: null,
    storage: null,
    nodeInfo: null,
    clearedNote: null,

    async load() {
      const wb = window.wrightbench
      if (!wb) return
      const settings = await wb.settings.get()
      set({ settings })
      applySettings(settings)
      // secondary data is non-blocking
      void wb.settings
        .storage()
        .then((storage) => set({ storage }))
        .catch(() => {})
      void wb.settings
        .nodeInfo()
        .then((nodeInfo) => set({ nodeInfo }))
        .catch(() => {})
    },

    async update(patch) {
      const wb = window.wrightbench
      const current = get().settings
      if (!wb || !current) return false
      // optimistic — the changed event confirms with the validated result
      const optimistic = { ...current, ...patch }
      set({ settings: optimistic })
      applySettings(optimistic)
      try {
        const settings = await wb.settings.update(patch)
        set({ settings })
        applySettings(settings)
        return true
      } catch {
        set({ settings: current })
        applySettings(current)
        return false
      }
    },

    async refreshStorage() {
      const wb = window.wrightbench
      if (!wb) return
      try {
        set({ storage: await wb.settings.storage() })
      } catch {
        // keep last
      }
    },

    async clearArtifacts() {
      const wb = window.wrightbench
      if (!wb) return
      try {
        const { removedRuns, removedArtifacts, freedBytes } = await wb.settings.clearArtifacts()
        set({
          clearedNote:
            removedRuns === 0 && removedArtifacts === 0
              ? 'nothing older than the retention window'
              : `removed ${removedRuns} run${removedRuns === 1 ? '' : 's'} and ${removedArtifacts} artifact${removedArtifacts === 1 ? '' : 's'} · freed ${formatFreed(freedBytes)}`
        })
        await get().refreshStorage()
      } catch {
        set({ clearedNote: 'cleanup failed' })
      }
    },
  }
})

function formatFreed(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

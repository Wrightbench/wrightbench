import { create } from 'zustand'
import type { ResolvedTheme, ThemePreference, ThemeState } from '@shared/ipc'

interface ThemeStore {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

const STORAGE_KEY = 'wrightbench.theme'

function applyToDocument(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
}

function storedPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

/**
 * In Electron the main process owns the theme (nativeTheme + persistence);
 * localStorage is kept as a same-frame hint so the preference control doesn't
 * flicker before theme:get resolves. In a plain browser (kitchen-sink
 * preview) matchMedia + localStorage are the whole implementation.
 */
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

function browserResolve(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemDark.matches ? 'dark' : 'light'
  return preference
}

export const useTheme = create<ThemeStore>((set) => {
  const applyState = (state: ThemeState): void => {
    localStorage.setItem(STORAGE_KEY, state.preference)
    applyToDocument(state.resolved)
    set(state)
  }

  if (window.wrightbench) {
    window.wrightbench.theme
      .get()
      .then(applyState)
      .catch((err) => console.error('theme:get failed', err))
    const unsubscribe = window.wrightbench.theme.onChanged(applyState)
    // theme.ts is not a react-refresh boundary — without teardown every HMR
    // re-evaluation would stack another ipcRenderer listener
    import.meta.hot?.dispose(unsubscribe)
  } else {
    const onSystemChange = (): void => {
      set((s) => {
        if (s.preference !== 'system') return s
        const resolved = browserResolve('system')
        applyToDocument(resolved)
        return { ...s, resolved }
      })
    }
    systemDark.addEventListener('change', onSystemChange)
    import.meta.hot?.dispose(() => systemDark.removeEventListener('change', onSystemChange))
  }

  const initialPreference = storedPreference()
  const initialResolved = browserResolve(initialPreference)
  applyToDocument(initialResolved)

  return {
    preference: initialPreference,
    resolved: initialResolved,
    setPreference: (preference) => {
      if (window.wrightbench) {
        window.wrightbench.theme
          .set(preference)
          .then(applyState)
          .catch((err) => console.error('theme:set failed', err))
      } else {
        localStorage.setItem(STORAGE_KEY, preference)
        const resolved = browserResolve(preference)
        applyToDocument(resolved)
        set({ preference, resolved })
      }
    }
  }
})

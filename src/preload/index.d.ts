import type { WrightbenchApi } from '@shared/ipc'

declare global {
  interface Window {
    /** Absent when the renderer runs in a plain browser (kitchen-sink preview). */
    wrightbench?: WrightbenchApi
  }
}

export {}

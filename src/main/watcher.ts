import { watch, type FSWatcher } from 'chokidar'
import { join } from 'node:path'

const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, NodeJS.Timeout>()

const SPEC_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/

export function startWatch(
  projectPath: string,
  testDir: string | null,
  onChange: (file: string) => void
): void {
  stopWatch(projectPath)
  const target = testDir ? join(projectPath, testDir) : projectPath
  const watcher = watch(target, {
    ignoreInitial: true,
    ignored: (p) => p.includes('node_modules') || p.includes('test-results')
  })
  watcher.on('all', (_event, file) => {
    if (!SPEC_FILE.test(file)) return
    clearTimeout(timers.get(projectPath))
    // debounce editor save bursts
    timers.set(
      projectPath,
      setTimeout(() => onChange(file), 300)
    )
  })
  watchers.set(projectPath, watcher)
}

export function stopWatch(projectPath: string): void {
  clearTimeout(timers.get(projectPath))
  timers.delete(projectPath)
  void watchers.get(projectPath)?.close()
  watchers.delete(projectPath)
}

export function stopAllWatchers(): void {
  for (const path of [...watchers.keys()]) stopWatch(path)
}

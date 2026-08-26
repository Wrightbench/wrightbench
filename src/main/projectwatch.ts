import { watch, type FSWatcher } from 'chokidar'
import { basename, sep } from 'node:path'
import { isPlaywrightConfigName } from './targets/scan'
import { loadProjects, projectHealth } from './projects'
import type { ProjectHealth, ProjectWithHealth } from '@shared/ipc'

/**
 * Registry-wide filesystem observation — deliberately separate from the
 * Tests-tab Watch mode in watcher.ts (that one re-RUNS tests; this one only
 * keeps Wrightbench's picture of each registered folder current). It reports
 * two things: health flips (folder gone / back / unreadable) and debounced
 * "your test surface changed" invalidations for the renderer to act on.
 * It never spawns Playwright and never touches project files.
 */

interface ProjectObservationSink {
  /** some registered folder's derived health changed (or registry synced) */
  onProjectsChanged(projects: ProjectWithHealth[]): void
  /** debounced: relevant files inside an available project changed;
   *  discovery=true when the change can alter target candidates themselves
   *  (package.json, lockfiles, config files appearing/vanishing) */
  onFilesChanged(path: string, discovery: boolean): void
}

interface Observed {
  health: ProjectHealth
  watcher: FSWatcher | null
  /** stat poll while the root is missing — watchers inside a deleted
   *  directory cannot be trusted to see it come back */
  recoveryPoll: ReturnType<typeof setInterval> | null
  debounce: ReturnType<typeof setTimeout> | null
  /** a discovery-relevant file changed inside the open debounce window */
  pendingDiscovery: boolean
}

/**
 * Target-aware refresh surface, fed by the discovery service after each
 * successful listing: the exact spec files Playwright reported, the resolved
 * report rootDir, and the active config path. This is what lets customized
 * layouts (`*.e2e.ts`, arbitrary testMatch, generated tests driven by data
 * files) refresh without Wrightbench pretending to know which files are tests.
 */
export interface DiscoverySurface {
  files: Set<string>
  dirs: string[]
  configs: Set<string>
}

const observed = new Map<string, Observed>()
const surfaces = new Map<string, DiscoverySurface>()
let sink: ProjectObservationSink = { onProjectsChanged: () => {}, onFilesChanged: () => {} }

const DEBOUNCE_MS = 500
const RECOVERY_POLL_MS = 2_000

/** directories whose churn must never trigger refreshes */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  'dist',
  'build',
  'out',
  '.cache',
  '.next',
  '.turbo'
])

const SPEC_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/
/** files under a known test-surface dir that can alter the listed tests
 *  (source modules with any naming, plus data files that generate tests) */
const SURFACE_FILE = /\.([cm]?[jt]sx?|json|csv|ya?ml)$/
const DISCOVERY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'bun.lock'
])

function isIgnored(filePath: string): boolean {
  return filePath.split(sep).some((segment) => IGNORED_DIRS.has(segment))
}

/** update (or clear) the listing-derived refresh surface for one project */
export function setDiscoverySurface(path: string, surface: DiscoverySurface | null): void {
  if (surface === null) surfaces.delete(path)
  else surfaces.set(path, surface)
}

/** can this change alter which harness targets exist? */
function isDiscoveryRelevant(filePath: string): boolean {
  const name = basename(filePath)
  return DISCOVERY_FILES.has(name) || isPlaywrightConfigName(name)
}

/** files whose add/change/remove/rename can alter the listed tests */
function isRelevant(projectPath: string, filePath: string): boolean {
  const name = basename(filePath)
  if (SPEC_FILE.test(name) || isPlaywrightConfigName(name) || DISCOVERY_FILES.has(name)) return true
  const surface = surfaces.get(projectPath)
  if (!surface) return false
  if (surface.files.has(filePath) || surface.configs.has(filePath)) return true
  // anything source-like under the resolved test root — custom testMatch
  // patterns must not be ignored just because they lack .spec/.test
  if (!SURFACE_FILE.test(name)) return false
  return surface.dirs.some(
    (dir) => filePath === dir || filePath.startsWith(dir.endsWith(sep) ? dir : dir + sep)
  )
}

export function setProjectObservationSink(next: ProjectObservationSink): void {
  sink = next
}

function snapshotWithKnownHealth(): ProjectWithHealth[] {
  // reuse the healths this service just derived so a broadcast can never
  // disagree with the transition that caused it
  return loadProjects().map((project) => ({
    ...project,
    health: observed.get(project.path)?.health ?? projectHealth(project.path)
  }))
}

function broadcastChanged(): void {
  sink.onProjectsChanged(snapshotWithKnownHealth())
}

function setHealth(path: string, health: ProjectHealth): boolean {
  const entry = observed.get(path)
  if (!entry) return false
  const changed =
    entry.health.state !== health.state || entry.health.reason !== health.reason
  entry.health = health
  return changed
}

function scheduleInvalidation(path: string, discovery: boolean): void {
  const entry = observed.get(path)
  if (!entry) return
  entry.pendingDiscovery = entry.pendingDiscovery || discovery
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.debounce = setTimeout(() => {
    entry.debounce = null
    const wasDiscovery = entry.pendingDiscovery
    entry.pendingDiscovery = false
    // the folder may have vanished between the event and the debounce firing
    const health = projectHealth(path)
    if (setHealth(path, health)) {
      applyMode(path)
      broadcastChanged()
    }
    if (health.state === 'available') sink.onFilesChanged(path, wasDiscovery)
  }, DEBOUNCE_MS)
}

function recheckHealth(path: string): void {
  const health = projectHealth(path)
  if (setHealth(path, health)) {
    applyMode(path)
    broadcastChanged()
    // a folder that just came back needs its tree re-listed too (and its
    // candidates re-evaluated — anything may have changed while it was gone)
    if (health.state === 'available') sink.onFilesChanged(path, true)
  }
}

function startWatcher(path: string): void {
  const entry = observed.get(path)
  if (!entry || entry.watcher) return
  let watcher: FSWatcher
  try {
    watcher = watch(path, {
      ignoreInitial: true,
      ignored: (candidate: string) => candidate !== path && isIgnored(candidate)
    })
  } catch {
    // cannot watch (permissions?) — the recovery poll keeps checking
    startRecoveryPoll(path)
    return
  }
  watcher.on('all', (event, filePath) => {
    if (event === 'unlinkDir' && filePath === path) {
      // the root itself went away
      recheckHealth(path)
      return
    }
    if (isRelevant(path, filePath)) {
      scheduleInvalidation(path, isDiscoveryRelevant(filePath))
    }
  })
  watcher.on('error', () => recheckHealth(path))
  entry.watcher = watcher
}

function stopWatcher(entry: Observed): void {
  if (entry.watcher) {
    void entry.watcher.close()
    entry.watcher = null
  }
}

function startRecoveryPoll(path: string): void {
  const entry = observed.get(path)
  if (!entry || entry.recoveryPoll) return
  entry.recoveryPoll = setInterval(() => recheckHealth(path), RECOVERY_POLL_MS)
}

function stopRecoveryPoll(entry: Observed): void {
  if (entry.recoveryPoll) {
    clearInterval(entry.recoveryPoll)
    entry.recoveryPoll = null
  }
}

/** watcher while available; stat poll while missing/unreadable */
function applyMode(path: string): void {
  const entry = observed.get(path)
  if (!entry) return
  if (entry.health.state === 'available') {
    stopRecoveryPoll(entry)
    startWatcher(path)
  } else {
    stopWatcher(entry)
    startRecoveryPoll(path)
  }
}

function observePath(path: string): void {
  if (observed.has(path)) return
  observed.set(path, {
    health: projectHealth(path),
    watcher: null,
    recoveryPoll: null,
    debounce: null,
    pendingDiscovery: false
  })
  applyMode(path)
}

function unobservePath(path: string): void {
  const entry = observed.get(path)
  if (!entry) return
  if (entry.debounce) clearTimeout(entry.debounce)
  stopWatcher(entry)
  stopRecoveryPoll(entry)
  observed.delete(path)
  surfaces.delete(path)
}

/**
 * Reconcile observers with the persisted registry. Call after app-ready and
 * after every add/remove. Returns the current list so callers can broadcast.
 */
export function syncProjectObservation(): ProjectWithHealth[] {
  const registered = new Set(loadProjects().map((p) => p.path))
  for (const path of [...observed.keys()]) {
    if (!registered.has(path)) unobservePath(path)
  }
  for (const path of registered) observePath(path)
  return snapshotWithKnownHealth()
}

/** window-focus safety net: re-stat every registered path, broadcast flips */
export function revalidateProjects(): void {
  let changed = false
  for (const path of observed.keys()) {
    const health = projectHealth(path)
    if (setHealth(path, health)) {
      applyMode(path)
      changed = true
      if (health.state === 'available') sink.onFilesChanged(path, true)
    }
  }
  if (changed) broadcastChanged()
}

export function stopProjectObservation(): void {
  for (const path of [...observed.keys()]) unobservePath(path)
}

/** current derived health for one path, from this service's live view */
export function observedHealth(path: string): ProjectHealth {
  return observed.get(path)?.health ?? projectHealth(path)
}

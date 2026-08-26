import { createHash, randomUUID } from 'node:crypto'
import { existsSync, opendirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { CONFIG_NAMES } from './capture'
import { wrightbenchDir, writeJsonAtomic } from './settings'
import { hasRecipeContext, hasReservedRunArgs } from './targets/script'
import type {
  HarnessTarget,
  LauncherKind,
  ProjectHealth,
  ProjectInfo,
  ProjectWithHealth,
  TargetSource
} from '@shared/ipc'

function projectsPath(): string {
  return join(wrightbenchDir(), 'projects.json')
}

function isProject(value: unknown): value is ProjectInfo {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.path === 'string' &&
    typeof p.addedAt === 'string'
  )
}

// ---- harness targets: persistence, validation, legacy migration ----

const LAUNCHERS: readonly LauncherKind[] = ['npm', 'pnpm', 'yarn', 'bun']
const TARGET_SOURCES: readonly TargetSource[] = ['config', 'script', 'user']

/** deterministic target id from the launch identity — stable across rescans */
export function targetIdFor(identity: {
  cwd: string
  configPath: string | null
  source: TargetSource
  scriptName: string | null
}): string {
  const key = `${identity.cwd}\u0000${identity.configPath ?? ''}\u0000${identity.source}\u0000${identity.scriptName ?? ''}`
  return `t-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
}

/** a bounded, POSIX, workspace-relative path — persisted entries are user-editable */
function isSafeRelPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('\u0000') &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split(/[/\\]/).includes('..')
  )
}

/** validate one persisted target; null drops the entry */
export function sanitizeTarget(value: unknown): HarnessTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const t = value as Record<string, unknown>
  if (typeof t.id !== 'string' || t.id === '' || t.id.length > 64) return null
  if (!isSafeRelPath(t.cwd)) return null
  if (!isSafeRelPath(t.packageDir)) return null
  if (t.configPath !== null && !isSafeRelPath(t.configPath)) return null
  const source = TARGET_SOURCES.includes(t.source as TargetSource)
    ? (t.source as TargetSource)
    : 'config'
  const launcher = LAUNCHERS.includes(t.launcher as LauncherKind)
    ? (t.launcher as LauncherKind)
    : 'npm'
  const scriptEnv: Record<string, string> = {}
  if (typeof t.scriptEnv === 'object' && t.scriptEnv !== null) {
    const entries = Object.entries(t.scriptEnv)
    if (entries.length > 64) return null
    for (const [key, val] of entries) {
      if (typeof val === 'string' && val.includes('\u0000')) return null
      if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        typeof val === 'string' &&
        val.length <= 1024 &&
        !val.includes('\u0000')
      ) {
        scriptEnv[key] = val
      }
    }
  }
  const rawExtraArgs = Array.isArray(t.extraArgs) ? t.extraArgs : []
  if (rawExtraArgs.length > 128) return null
  if (
    rawExtraArgs.some(
      (arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\u0000')
    )
  ) {
    return null
  }
  const extraArgs = rawExtraArgs as string[]
  if (hasReservedRunArgs(extraArgs)) return null
  return {
    id: t.id,
    label:
      typeof t.label === 'string' && t.label !== '' ? t.label.slice(0, 200) : (t.id as string),
    cwd: t.cwd,
    configPath: t.configPath === null ? null : (t.configPath as string),
    packageDir: t.packageDir,
    launcher,
    source,
    scriptName:
      typeof t.scriptName === 'string' && t.scriptName.length <= 200 ? t.scriptName : null,
    scriptEnv,
    extraArgs,
    playwrightVersion:
      typeof t.playwrightVersion === 'string' ? t.playwrightVersion.slice(0, 100) : null,
    testCount:
      typeof t.testCount === 'number' && Number.isFinite(t.testCount)
        ? Math.max(0, Math.trunc(t.testCount))
        : null
  }
}

/**
 * Default target for a legacy registry entry: the workspace root with
 * Playwright's default config resolution — exactly the context the old
 * `npx playwright test --list` behavior used. Pure by design (no fs), so a
 * missing folder can never block reading the registry; migrateProjectsFile
 * enriches it with the concrete conventional config when the folder is there.
 */
export function synthesizeLegacyTarget(): HarnessTarget {
  return {
    id: targetIdFor({ cwd: '.', configPath: null, source: 'config', scriptName: null }),
    label: 'Playwright default config',
    cwd: '.',
    configPath: null,
    packageDir: '.',
    launcher: 'npm',
    source: 'config',
    scriptName: null,
    scriptEnv: {},
    extraArgs: [],
    playwrightVersion: null,
    testCount: null
  }
}

/** normalized target list + active selection for one registry entry */
export function projectTargets(project: ProjectInfo): {
  targets: HarnessTarget[]
  activeTargetId: string
} {
  const sanitized = Array.isArray(project.targets)
    ? project.targets.map(sanitizeTarget).filter((t): t is HarnessTarget => t !== null)
    : []
  const targets = sanitized.length > 0 ? sanitized : [synthesizeLegacyTarget()]
  const activeTargetId =
    typeof project.activeTargetId === 'string' &&
    targets.some((t) => t.id === project.activeTargetId)
      ? project.activeTargetId
      : targets[0].id
  return { targets, activeTargetId }
}

/**
 * Idempotent startup migration: give legacy entries an explicit default
 * target, and normalize registries written before configurations and recipes
 * were separated. Project ids, paths, history ownership, and unrecognized
 * projects.json entries stay untouched.
 */
export function migrateProjectsFile(): void {
  const { items, healthy } = readRaw()
  if (!healthy) return
  let changed = false
  const next = items.map((item) => {
    if (!isProject(item)) return item
    if (!Array.isArray(item.targets) || item.targets.length === 0) {
      const target = synthesizeLegacyTarget()
      try {
        const found = CONFIG_NAMES.find((name) => existsSync(join(item.path, name)))
        if (found) {
          // adopt the same identity a scan would produce for this config, so a
          // later rescan merges onto this target instead of duplicating it
          target.id = targetIdFor({ cwd: '.', configPath: found, source: 'config', scriptName: null })
          target.configPath = found
          target.label = found
          target.playwrightVersion =
            typeof item.playwrightVersion === 'string' ? item.playwrightVersion : null
          target.testCount = typeof item.testCount === 'number' ? item.testCount : null
        }
      } catch {
        // folder unavailable — the pure default target still reproduces legacy behavior
      }
      changed = true
      return { ...item, targets: [target], activeTargetId: target.id }
    }

    // Normalize registries written by earlier Wrightbench builds. Every script
    // context gets an independent base configuration; project-only and
    // headed/debug-only aliases are dropped, while meaningful recipes remain.
    const sanitized = item.targets
      .map(sanitizeTarget)
      .filter((target): target is HarnessTarget => target !== null)
    const normalized: HarnessTarget[] = []
    const byId = new Set<string>()
    const add = (target: HarnessTarget): void => {
      if (byId.has(target.id)) return
      byId.add(target.id)
      normalized.push(target)
    }
    for (const target of sanitized) {
      if (target.source !== 'script') add(target)
    }
    const activeRemap = new Map<string, string>()
    for (const target of sanitized) {
      if (target.source !== 'script') continue
      const base = baseTargetForRecipe(target)
      add(base)
      if (hasRecipeContext(target.scriptEnv, target.extraArgs)) {
        add(target)
      } else {
        activeRemap.set(target.id, base.id)
      }
    }
    if (normalized.length === 0) add(synthesizeLegacyTarget())
    const previousActive = typeof item.activeTargetId === 'string' ? item.activeTargetId : null
    const remappedActive = previousActive ? (activeRemap.get(previousActive) ?? previousActive) : null
    const activeTargetId =
      remappedActive && normalized.some((target) => target.id === remappedActive)
        ? remappedActive
        : normalized[0].id
    const activeWasRemapped = previousActive !== null && activeRemap.has(previousActive)
    const activeTarget = normalized.find((target) => target.id === activeTargetId)
    const testCount = activeWasRemapped ? (activeTarget?.testCount ?? null) : item.testCount
    if (
      JSON.stringify(normalized) === JSON.stringify(item.targets) &&
      activeTargetId === (item.activeTargetId ?? null) &&
      testCount === item.testCount
    ) {
      return item
    }
    changed = true
    return { ...item, targets: normalized, activeTargetId, testCount }
  })
  if (changed) writeJsonAtomic(projectsPath(), next)
}

function baseTargetForRecipe(recipe: HarnessTarget): HarnessTarget {
  const id = targetIdFor({
    cwd: recipe.cwd,
    configPath: recipe.configPath,
    source: 'config',
    scriptName: null
  })
  return {
    ...recipe,
    id,
    label:
      recipe.configPath ??
      (recipe.cwd === '.' ? 'Playwright default config' : `${recipe.cwd} · default config`),
    source: 'config',
    scriptName: null,
    scriptEnv: {},
    extraArgs: [],
    // A recipe may have listed only a filtered subset; never copy that count
    // onto its newly synthesized full-suite configuration.
    testCount: null
  }
}

/**
 * Replace one project's discovered targets (user-selected targets not in the
 * new list are kept; the merge preserves ids and cached metadata for targets
 * that persist). Validated-empty dependency defaults can be removed explicitly
 * by id without persisting scanner-only metadata. Never touches other fields.
 */
export function applyDiscoveredTargets(
  path: string,
  discovered: HarnessTarget[],
  activeTargetId?: string | null,
  suppressedTargetIds: readonly string[] = []
): ProjectInfo | null {
  const { items, healthy } = readRaw()
  if (!healthy) {
    throw new Error('projects.json is unreadable — fix or remove ~/.wrightbench/projects.json')
  }
  let updated: ProjectInfo | null = null
  let changedEntry = false
  const next = items.map((item) => {
    if (!isProject(item) || item.path !== path) return item
    const existing = projectTargets(item).targets
    const merged = mergeTargets(existing, discovered, suppressedTargetIds)
    const requestedActive =
      activeTargetId !== undefined && activeTargetId !== null ? activeTargetId : undefined
    const currentActive = item.activeTargetId ?? undefined
    const active =
      (requestedActive !== undefined && merged.some((t) => t.id === requestedActive)
        ? requestedActive
        : undefined) ??
      (currentActive !== undefined && merged.some((t) => t.id === currentActive)
        ? currentActive
        : undefined) ??
      merged[0]?.id ??
      null
    if (
      JSON.stringify(merged) === JSON.stringify(item.targets ?? []) &&
      active === (item.activeTargetId ?? null)
    ) {
      updated = item
      return item
    }
    updated = { ...item, targets: merged, activeTargetId: active }
    changedEntry = true
    return updated
  })
  if (updated && changedEntry) writeJsonAtomic(projectsPath(), next)
  return updated
}

/**
 * Merge freshly discovered targets over the existing list:
 *  - same id → replace with the fresh one, keeping newer cached metadata;
 *  - the legacy synthesized default (cwd '.', no explicit config) is upgraded
 *    in place by a discovered root conventional-config target;
 *  - user-selected targets always survive a rescan;
 *  - stale script recipes are dropped (scripts can be removed or reclassified
 *    as project/run-mode aliases); configs stay recoverable and user-picked
 *    targets always survive;
 *  - dependency defaults proven empty are pruned by the discovery service's
 *    explicit suppression ids.
 */
export function mergeTargets(
  existing: HarnessTarget[],
  discovered: HarnessTarget[],
  suppressedTargetIds: readonly string[] = []
): HarnessTarget[] {
  const legacyId = synthesizeLegacyTarget().id
  // only the conventional root config is what Playwright default resolution
  // would have loaded — a custom-named or nested config must NOT replace the
  // legacy default-resolution target
  const rootDefault = discovered.find(
    (t) =>
      t.cwd === '.' &&
      t.source === 'config' &&
      t.configPath !== null &&
      (CONFIG_NAMES as readonly string[]).includes(t.configPath)
  )
  const result: HarnessTarget[] = []
  const consumed = new Set<string>()
  const suppressed = new Set(suppressedTargetIds)
  for (const current of existing) {
    const fresh = discovered.find((t) => t.id === current.id)
    if (fresh) {
      consumed.add(fresh.id)
      result.push({
        ...fresh,
        playwrightVersion: fresh.playwrightVersion ?? current.playwrightVersion,
        testCount: fresh.testCount ?? current.testCount
      })
      continue
    }
    if (suppressed.has(current.id)) continue
    if (current.id === legacyId && current.configPath === null && rootDefault) {
      // upgraded by the explicit root-config candidate — don't keep both
      continue
    }
    if (current.source === 'script') continue
    result.push(current)
  }
  for (const fresh of discovered) {
    if (!consumed.has(fresh.id) && !suppressed.has(fresh.id)) result.push(fresh)
  }
  return result
}

/** persist the active-target selection (validated against the target list) */
export function setActiveTargetPersisted(path: string, targetId: string): ProjectInfo | null {
  const { items, healthy } = readRaw()
  if (!healthy) {
    throw new Error('projects.json is unreadable — fix or remove ~/.wrightbench/projects.json')
  }
  let updated: ProjectInfo | null = null
  const next = items.map((item) => {
    if (!isProject(item) || item.path !== path) return item
    const { targets } = projectTargets(item)
    if (!targets.some((t) => t.id === targetId)) return item
    updated = { ...item, targets: item.targets ?? targets, activeTargetId: targetId }
    return updated
  })
  if (updated) writeJsonAtomic(projectsPath(), next)
  return updated
}

/** refresh cached display metadata after a successful listing (best-effort) */
export function updateTargetCache(
  path: string,
  targetId: string,
  patch: { playwrightVersion?: string | null; testCount?: number | null }
): void {
  const { items, healthy } = readRaw()
  if (!healthy) return
  let changed = false
  const next = items.map((item) => {
    if (!isProject(item) || item.path !== path) return item
    const { targets, activeTargetId } = projectTargets(item)
    const idx = targets.findIndex((t) => t.id === targetId)
    if (idx === -1) return item
    const target = targets[idx]
    const nextTarget: HarnessTarget = {
      ...target,
      playwrightVersion:
        patch.playwrightVersion !== undefined ? patch.playwrightVersion : target.playwrightVersion,
      testCount: patch.testCount !== undefined ? patch.testCount : target.testCount
    }
    if (
      nextTarget.playwrightVersion === target.playwrightVersion &&
      nextTarget.testCount === target.testCount
    ) {
      return item
    }
    changed = true
    const nextTargets = [...targets]
    nextTargets[idx] = nextTarget
    // the project-level cache mirrors the ACTIVE target for the switcher row
    const isActive = targetId === activeTargetId
    return {
      ...item,
      targets: nextTargets,
      testCount: isActive && patch.testCount !== undefined ? patch.testCount : item.testCount,
      playwrightVersion:
        isActive && patch.playwrightVersion !== undefined && patch.playwrightVersion !== null
          ? patch.playwrightVersion
          : item.playwrightVersion
    }
  })
  if (changed) writeJsonAtomic(projectsPath(), next)
}

/** healthy=false means the file exists but can't be read — never overwrite it. */
function readRaw(): { items: unknown[]; healthy: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(projectsPath(), 'utf8'))
    return { items: Array.isArray(parsed) ? parsed : [], healthy: Array.isArray(parsed) }
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { items: [], healthy: missing }
  }
}

export function loadProjects(): ProjectInfo[] {
  return readRaw().items.filter(isProject)
}

/**
 * Filesystem health of a registered path, from explicit stat/opendir checks —
 * never inferred from downstream tool or IPC error text. Distinguishes: path
 * gone, path not a directory, directory unreadable, and available.
 */
export function projectHealth(path: string): ProjectHealth {
  let isDirectory: boolean
  try {
    isDirectory = statSync(path).isDirectory()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'missing', reason: 'Folder not found' }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { state: 'unreadable', reason: 'Folder is not accessible' }
    }
    return { state: 'unreadable', reason: 'Folder could not be read' }
  }
  if (!isDirectory) return { state: 'unreadable', reason: 'Path is not a folder' }
  try {
    opendirSync(path).closeSync()
  } catch {
    return { state: 'unreadable', reason: 'Folder is not accessible' }
  }
  return { state: 'available', reason: null }
}

function withHealth(project: ProjectInfo): ProjectWithHealth {
  return { ...project, health: projectHealth(project.path) }
}

/**
 * Resolve a project-relative file for opening, refusing anything that
 * escapes the project directory (absolute inputs, `..` traversal).
 */
export function resolveProjectFile(projectPath: string, relativeFile: string): string | null {
  if (typeof relativeFile !== 'string' || relativeFile === '' || isAbsolute(relativeFile)) {
    return null
  }
  const root = resolve(projectPath)
  const resolved = resolve(root, relativeFile)
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  return resolved
}

/** the registry plus derived (never persisted) filesystem health */
export function listProjectsWithHealth(): ProjectWithHealth[] {
  return loadProjects().map(withHealth)
}

/**
 * Drop one registry entry by id. Only ~/.wrightbench/projects.json changes:
 * the project's files and its rows in history.db are untouched, so re-adding
 * the same folder later surfaces the old history again.
 */
export function removeProject(id: string): ProjectWithHealth[] {
  const { items, healthy } = readRaw()
  if (!healthy) {
    throw new Error('projects.json is unreadable — fix or remove ~/.wrightbench/projects.json')
  }
  const kept = items.filter((item) => !(isProject(item) && item.id === id))
  writeJsonAtomic(projectsPath(), kept)
  return kept.filter(isProject).map(withHealth)
}

export function addProject(project: {
  name: string
  path: string
  playwrightVersion?: string | null
  nodeVersion?: string | null
  testCount?: number | null
  targets?: HarnessTarget[]
  suppressedTargetIds?: string[]
  activeTargetId?: string | null
}): ProjectInfo[] {
  const { items, healthy } = readRaw()
  if (!healthy) {
    throw new Error('projects.json is unreadable — fix or remove ~/.wrightbench/projects.json')
  }
  const targets = (project.targets ?? [])
    .map(sanitizeTarget)
    .filter((t): t is HarnessTarget => t !== null)
  const previous = items.filter(isProject).find((item) => item.path === project.path)
  // re-adding the same folder replaces the entry; unrecognized entries are kept
  const kept = items.filter((item) => !(isProject(item) && item.path === project.path))
  const previousTargets = previous ? projectTargets(previous) : null
  const resolvedTargets = previousTargets
    ? mergeTargets(previousTargets.targets, targets, project.suppressedTargetIds)
    : targets.length > 0
      ? targets
      : [synthesizeLegacyTarget()]
  const requestedActive = project.activeTargetId ?? null
  const previousActive = previousTargets?.activeTargetId ?? null
  const activeTargetId =
    (previousActive !== null && resolvedTargets.some((t) => t.id === previousActive)
      ? previousActive
      : null) ??
    (requestedActive !== null && resolvedTargets.some((t) => t.id === requestedActive)
      ? requestedActive
      : null) ??
    resolvedTargets[0].id
  const activeTarget = resolvedTargets.find((target) => target.id === activeTargetId)
  kept.push({
    // re-adding keeps the id so run history and view context stay attached
    id: previous?.id ?? randomUUID(),
    name: project.name,
    path: project.path,
    addedAt: previous?.addedAt ?? new Date().toISOString(),
    playwrightVersion:
      activeTarget?.playwrightVersion ??
      project.playwrightVersion ??
      previous?.playwrightVersion ??
      null,
    nodeVersion: project.nodeVersion ?? previous?.nodeVersion ?? null,
    testCount: activeTarget?.testCount ?? project.testCount ?? previous?.testCount ?? null,
    targets: resolvedTargets,
    activeTargetId
  })
  writeJsonAtomic(projectsPath(), kept)
  return kept.filter(isProject)
}

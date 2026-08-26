import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { detectLauncher, resolvePlaywright } from './launcher'
import {
  applyDiscoveredTargets,
  loadProjects,
  projectTargets,
  setActiveTargetPersisted,
  synthesizeLegacyTarget,
  targetIdFor,
  updateTargetCache
} from '../projects'
import { setDiscoverySurface } from '../projectwatch'
import { projectRunEnv } from '../settings'
import { recordingSupportForVersion } from '../pwadapter'
import { listTarget, type ExecFn, type TargetListResult } from './list'
import { environmentSetupHintsFor } from './environment'
import { resolveTargetContext } from './context'
import { assertSupportedPlaywright } from '@shared/playwright-compat'
import {
  pathIsWithin,
  scanWorkspace,
  workspaceRelative,
  type ScannedCandidate
} from './scan'
import type {
  HarnessTarget,
  TargetCandidateInfo,
  TargetDiscoveryStatus,
  TargetsState,
  TargetSummary,
  TestListOutcome
} from '@shared/ipc'

/**
 * Harness-target orchestration: turns passive scan candidates into persisted
 * targets, validates them by listing (the same code path the workspace tree
 * uses), computes what the current runner can faithfully execute, and keeps
 * the import-preview candidate cache the projects:add handler reads.
 */

// ---- candidate → target ----

export function candidateToTarget(candidate: ScannedCandidate): HarnessTarget {
  const source = candidate.source
  const id = targetIdFor({
    cwd: candidate.cwd,
    configPath: candidate.configPath,
    source,
    scriptName: candidate.scriptName
  })
  return {
    id,
    label: targetLabel(candidate),
    cwd: candidate.cwd,
    configPath: candidate.configPath,
    packageDir: candidate.packageDir,
    launcher: candidate.launcher,
    source,
    scriptName: candidate.scriptName,
    scriptEnv: candidate.scriptEnv,
    extraArgs: candidate.extraArgs,
    playwrightVersion: candidate.playwrightVersion,
    testCount: null
  }
}

function targetLabel(candidate: {
  cwd: string
  configPath: string | null
  source: string
  scriptName: string | null
}): string {
  if (candidate.source === 'script' && candidate.scriptName !== null) {
    return candidate.scriptName
  }
  if (candidate.configPath !== null) return candidate.configPath
  return candidate.cwd === '.' ? 'Playwright default config' : `${candidate.cwd} · default config`
}

// ---- runnable computation ----

/**
 * Every sanitized target is executable: the runner resolves the persisted
 * context server-side and uses the same cwd/config/env/argv as discovery.
 * Missing dependencies and invalid paths still fail at launch with a precise
 * error rather than being guessed at here from cached state.
 */
export function runnableFor(
  _workspaceRoot: string,
  _target: HarnessTarget,
  _conventionalConfig?: string | null
): { runnable: boolean; runnableReason: string | null } {
  return { runnable: true, runnableReason: null }
}

export function toSummary(
  workspaceRoot: string,
  target: HarnessTarget,
  conventionalConfig?: string | null
): TargetSummary {
  const { runnable, runnableReason } = runnableFor(workspaceRoot, target, conventionalConfig)
  return {
    id: target.id,
    label: target.label,
    cwd: target.cwd,
    configPath: target.configPath,
    packageDir: target.packageDir,
    launcher: target.launcher,
    source: target.source,
    scriptName: target.scriptName,
    playwrightVersion: target.playwrightVersion,
    testCount: target.testCount,
    runnable,
    runnableReason
  }
}

// ---- discovery (scan + validate) ----

export interface DiscoveryResult {
  candidates: TargetCandidateInfo[]
  /** the corresponding persistable targets, same order as candidates */
  targets: HarnessTarget[]
  /** dependency-inferred config-less candidates seen by this scan */
  implicitConfiglessTargetIds: string[]
  /** validated-empty dependency defaults deliberately omitted from targets */
  suppressedTargetIds: string[]
  recommendedTargetId: string | null
  opaqueScripts: { packageDir: string; scriptName: string; reason: string }[]
  truncated: boolean
}

/**
 * Recheck the selected base configuration immediately before registration.
 * Inspection cache metadata is advisory; a user may remove node_modules (or
 * a forged renderer may name a recipe) between inspection and projects:add.
 */
export function resolveImportTarget(
  workspaceRoot: string,
  discovery: Pick<DiscoveryResult, 'targets' | 'recommendedTargetId'>,
  requestedTargetId: string | null
): HarnessTarget {
  const targetId = requestedTargetId ?? discovery.recommendedTargetId
  const target = discovery.targets.find((candidate) => candidate.id === targetId) ?? null
  if (target === null || target.source === 'script') {
    throw new Error('Choose a valid Playwright configuration before adding this project')
  }
  const resolved = resolveTargetContext(workspaceRoot, target)
  if (!resolved.ok) {
    if (resolved.code === 'outside-workspace') {
      throw new Error('The selected Playwright configuration resolves outside this workspace')
    }
    if (resolved.code === 'pnp') {
      throw new Error('Yarn Plug’n’Play test configurations are not supported yet')
    }
    throw new Error(
      'Playwright is not installed for this configuration. Install project dependencies, then retry detection.'
    )
  }
  target.playwrightVersion = resolved.context.playwright.version
  assertSupportedPlaywright(target.playwrightVersion)
  return target
}

const STATUS_RANK: Record<TargetDiscoveryStatus, number> = {
  ready: 0,
  empty: 1,
  'not-validated': 2,
  'needs-context': 3,
  'setup-required': 4,
  'dependencies-missing': 5,
  'test-load-failed': 6,
  'invalid-config': 7,
  'timed-out': 8,
  'list-failed': 9,
  'unsupported-launcher': 10
}

/** at most this many candidates are validated by listing during one inspection */
const MAX_VALIDATIONS = 12
/** total wall-clock budget for one discovery pass; candidates beyond it
 *  report not-validated instead of serializing 60s timeouts */
const DISCOVERY_BUDGET_MS = 150_000
function cwdDepth(cwd: string): number {
  return cwd === '.' ? 0 : cwd.split('/').length
}

function candidateOrder(a: TargetCandidateInfo, b: TargetCandidateInfo): number {
  const status = STATUS_RANK[a.status] - STATUS_RANK[b.status]
  if (status !== 0) return status
  const depth = cwdDepth(a.cwd) - cwdDepth(b.cwd)
  if (depth !== 0) return depth
  const sourceRank = (s: string): number => (s === 'config' ? 0 : s === 'script' ? 1 : 2)
  const source = sourceRank(a.source) - sourceRank(b.source)
  if (source !== 0) return source
  const conventional = (c: TargetCandidateInfo): number =>
    c.configPath !== null && basename(c.configPath).startsWith('playwright.config.') ? 0 : 1
  return conventional(a) - conventional(b) || a.label.localeCompare(b.label)
}

/**
 * Full discovery pass: bounded passive scan, then validate each candidate by
 * listing with the project-owned runtime environment. Failed candidates never hide valid
 * ones. The one suppressed case is a validated-empty config-less package
 * inferred only from a dependency when an explicit configuration exists.
 */
export async function discoverTargets(
  workspaceRoot: string,
  _profileName: string | null,
  options: { validate?: boolean; exec?: ExecFn; extraCandidates?: HarnessTarget[] } = {}
): Promise<DiscoveryResult> {
  const validate = options.validate ?? true
  const scan = scanWorkspace(workspaceRoot)
  const targets = scan.candidates.map(candidateToTarget)
  const implicitConfiglessIds = new Set(
    scan.candidates
      .filter((candidate) => candidate.implicitConfigless)
      .map((candidate) => candidateToTarget(candidate).id)
  )
  for (const extra of options.extraCandidates ?? []) {
    if (!targets.some((t) => t.id === extra.id)) targets.push(extra)
  }
  // Validation is bounded, so high-confidence configs and script contexts
  // must get their result before dependency-inferred defaults. Final display
  // order is still computed independently by candidateOrder below.
  targets.sort(
    (a, b) => Number(implicitConfiglessIds.has(a.id)) - Number(implicitConfiglessIds.has(b.id))
  )
  const profileEnv = projectRunEnv()

  const infos: TargetCandidateInfo[] = []
  let validated = 0
  const startedAt = Date.now()
  for (const target of targets) {
    const summary = toSummary(workspaceRoot, target)
    const environmentSetupHints = environmentSetupHintsFor(workspaceRoot, target)
    const outOfBudget = validated > 0 && Date.now() - startedAt > DISCOVERY_BUDGET_MS
    if (!validate || validated >= MAX_VALIDATIONS || outOfBudget) {
      infos.push({
        ...summary,
        status: 'not-validated',
        recording: recordingSupportForVersion(summary.playwrightVersion),
        diagnostic:
          validate
            ? {
                status: 'not-validated',
                summary: 'Not validated — too many candidates in this workspace',
                detail: null,
                exitCode: null,
                configPath: target.configPath,
                cwd: target.cwd,
                launcher: target.launcher,
                playwrightVersion: target.playwrightVersion,
                output: null,
                suggestion: 'Select this target to list it on demand.'
              }
            : null,
        specFiles: null,
        environmentSetupHints,
        projectNames: null,
        configuredProjectNames: null,
        rootDir: null
      })
      continue
    }
    validated += 1
    const result = await listTarget(
      { workspaceRoot, target, profileEnv },
      options.exec
    )
    target.playwrightVersion = result.playwrightVersion ?? target.playwrightVersion
    target.testCount = result.testCount ?? target.testCount
    infos.push({
      ...summary,
      playwrightVersion: target.playwrightVersion,
      testCount: target.testCount,
      status: result.status,
      recording: recordingSupportForVersion(target.playwrightVersion),
      diagnostic: result.diagnostic,
      environmentSetupHints,
      specFiles: result.specFiles,
      projectNames: result.projectNames,
      configuredProjectNames: result.configuredProjectNames,
      rootDir: result.rootDir
    })
  }

  // best-first, and keep the target array aligned with the candidate order
  // A dependency-only default is useful as a last resort, but any explicit
  // config, user pick, or script-derived default is stronger evidence that
  // this workspace really owns a test harness.
  const hasCredibleCandidate = targets.some((target) => !implicitConfiglessIds.has(target.id))
  const entries = infos.map((info, index) => ({ info, target: targets[index] }))
  const shouldSuppress = ({ info, target }: (typeof entries)[number]): boolean =>
    hasCredibleCandidate &&
    info.status === 'empty' &&
    implicitConfiglessIds.has(target.id)
  const suppressedTargetIds = entries.filter(shouldSuppress).map(({ target }) => target.id)
  const order = entries
    .filter((entry) => !shouldSuppress(entry))
    .sort((a, b) => candidateOrder(a.info, b.info))
  const sortedInfos = order.map((o) => o.info)
  const sortedTargets = order.map((o) => o.target)
  const recommended =
    sortedInfos.find((c) => c.status === 'ready') ??
    sortedInfos.find((c) => c.status === 'empty') ??
    sortedInfos.find((c) => c.status === 'needs-context') ??
    sortedInfos.find((c) => c.status === 'setup-required') ??
    sortedInfos[0] ??
    null

  return {
    candidates: sortedInfos,
    targets: sortedTargets,
    implicitConfiglessTargetIds: [...implicitConfiglessIds],
    suppressedTargetIds,
    recommendedTargetId: recommended?.id ?? null,
    opaqueScripts: scan.opaqueScripts,
    truncated: scan.truncated
  }
}

// ---- import-preview cache (main-process only; projects:add reads it) ----

interface CachedDiscovery {
  targets: HarnessTarget[]
  suppressedTargetIds: string[]
  recommendedTargetId: string | null
  at: number
}

const inspectionCache = new Map<string, CachedDiscovery>()
const CACHE_TTL_MS = 30 * 60 * 1_000

export function cacheDiscovery(path: string, discovery: DiscoveryResult): void {
  inspectionCache.set(path, {
    targets: discovery.targets,
    suppressedTargetIds: discovery.suppressedTargetIds,
    recommendedTargetId: discovery.recommendedTargetId,
    at: Date.now()
  })
}

/** merge one user-picked config target into the cached preview (detection flow) */
export function cacheUserTarget(path: string, target: HarnessTarget): void {
  const cached = inspectionCache.get(path)
  const targets = cached ? [...cached.targets.filter((t) => t.id !== target.id), target] : [target]
  inspectionCache.set(path, {
    targets,
    suppressedTargetIds: cached?.suppressedTargetIds ?? [],
    recommendedTargetId: cached?.recommendedTargetId ?? target.id,
    at: Date.now()
  })
}

export function cachedDiscovery(path: string): CachedDiscovery | null {
  const cached = inspectionCache.get(path)
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) return null
  return cached
}

// ---- registry-facing views ----

export function targetsStateFor(path: string): TargetsState {
  const project = loadProjects().find((p) => p.path === path)
  if (!project) return { targets: [], activeTargetId: null }
  const { targets, activeTargetId } = projectTargets(project)
  return { targets: targets.map((t) => toSummary(path, t)), activeTargetId }
}

export function setActiveTarget(path: string, targetId: string): TargetsState {
  setActiveTargetPersisted(path, targetId)
  return targetsStateFor(path)
}

export async function rescanRegisteredTargets(
  path: string,
  _profileName: string | null,
  validate: boolean,
  exec?: ExecFn
): Promise<TargetsState & { candidates: TargetCandidateInfo[] }> {
  const project = loadProjects().find((p) => p.path === path)
  if (!project) throw new Error('unknown project')
  const discovery = await discoverTargets(path, null, { validate, exec })
  const existing = projectTargets(project).targets
  const existingIds = new Set(existing.map((target) => target.id))
  const implicitIds = new Set(discovery.implicitConfiglessTargetIds)
  const hasCredibleContext =
    discovery.targets.some((target) => !implicitIds.has(target.id)) ||
    existing.some(
      (target) =>
        target.source === 'user' || target.source === 'script' || target.configPath !== null
    )
  // A scan-only file refresh cannot prove a dependency-inferred default has
  // tests. If validated import previously omitted that id, keep it omitted
  // while another credible harness context remains. Existing config-less
  // targets are never pruned here: they may have validated ready earlier.
  const preservedSuppressions =
    !validate && hasCredibleContext
      ? discovery.implicitConfiglessTargetIds.filter((id) => !existingIds.has(id))
      : []
  const suppressedTargetIds = [
    ...new Set([...discovery.suppressedTargetIds, ...preservedSuppressions])
  ]
  applyDiscoveredTargets(path, discovery.targets, undefined, suppressedTargetIds)
  const state = targetsStateFor(path)
  const registeredIds = new Set(state.targets.map((target) => target.id))
  return {
    ...state,
    candidates: discovery.candidates.filter((candidate) => registeredIds.has(candidate.id))
  }
}

// ---- the workspace test tree (same discovery service as import) ----

export async function listTestsForProject(
  path: string,
  _profileName: string | null,
  targetId: string | null,
  exec?: ExecFn
): Promise<TestListOutcome> {
  const project = loadProjects().find((p) => p.path === path)
  const resolved = project
    ? projectTargets(project)
    : { targets: [synthesizeLegacyTarget()], activeTargetId: synthesizeLegacyTarget().id }
  const target =
    (targetId !== null ? resolved.targets.find((t) => t.id === targetId) : undefined) ??
    resolved.targets.find((t) => t.id === resolved.activeTargetId) ??
    resolved.targets[0]

  const result = await listTarget(
    { workspaceRoot: path, target, profileEnv: projectRunEnv() },
    exec
  )

  finishListing(path, target, result, project !== undefined)

  return {
    status: result.status,
    tree: result.tree,
    diagnostic: result.diagnostic,
    target: toSummary(path, {
      ...target,
      playwrightVersion: result.playwrightVersion ?? target.playwrightVersion,
      testCount: result.testCount ?? target.testCount
    })
  }
}

/** post-listing bookkeeping: watcher surface + cached display metadata */
function finishListing(
  path: string,
  target: HarnessTarget,
  result: TargetListResult,
  registered: boolean
): void {
  if (result.status === 'ready' || result.status === 'empty') {
    // Playwright reports realpathed locations; watcher events arrive under
    // the registered (possibly symlinked) path — keep both spellings
    let realRoot = path
    try {
      realRoot = realpathSync(path)
    } catch {
      realRoot = path
    }
    const respell = (absolute: string): string[] =>
      realRoot !== path && absolute.startsWith(realRoot)
        ? [absolute, path + absolute.slice(realRoot.length)]
        : [absolute]
    const configs = new Set<string>()
    if (target.configPath !== null) {
      configs.add(join(path, ...target.configPath.split('/')))
    }
    setDiscoverySurface(path, {
      files: new Set(result.absoluteFiles.flatMap(respell)),
      dirs: result.absoluteRootDir !== null ? respell(result.absoluteRootDir) : [],
      configs
    })
    if (registered) {
      try {
        updateTargetCache(path, target.id, {
          playwrightVersion: result.playwrightVersion,
          testCount: result.testCount
        })
      } catch (err) {
        console.error('failed to update target cache:', err)
      }
    }
  }
}

/** validate + build a user-picked config target (dialog flow) */
export function buildUserConfigTarget(
  workspaceRoot: string,
  configAbsolute: string
): { target: HarnessTarget } | { error: string } {
  let stat
  let rootReal: string
  let configReal: string
  try {
    rootReal = realpathSync(workspaceRoot)
    configReal = realpathSync(configAbsolute)
    stat = statSync(configReal)
  } catch {
    return { error: 'The selected file could not be read.' }
  }
  if (!stat.isFile()) return { error: 'The selected path is not a file.' }
  if (!pathIsWithin(rootReal, configReal)) {
    return {
      error:
        'The selected config is outside this workspace. Import its containing folder instead.'
    }
  }
  const rel = workspaceRelative(rootReal, configReal)
  if (!/\.[cm]?[jt]s$/.test(configAbsolute)) {
    return { error: 'Playwright configs are .ts, .js, .mjs, .cjs, .mts, or .cts files.' }
  }
  // the containing package (nearest package.json up to the workspace root)
  // owns the cwd, launcher, and Playwright installation
  let packageAbs = rootReal
  let probe = dirname(configReal)
  while (pathIsWithin(rootReal, probe)) {
    if (existsSync(join(probe, 'package.json'))) {
      packageAbs = probe
      break
    }
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const packageRel = workspaceRelative(rootReal, packageAbs)
  const install = resolvePlaywright(packageAbs)
  const target: HarnessTarget = {
    id: targetIdFor({ cwd: packageRel, configPath: rel, source: 'user', scriptName: null }),
    label: rel,
    cwd: packageRel,
    configPath: rel,
    packageDir: packageRel,
    launcher: detectLauncher(packageAbs, rootReal),
    source: 'user',
    scriptName: null,
    scriptEnv: {},
    extraArgs: [],
    playwrightVersion: install?.version ?? null,
    testCount: null
  }
  return { target }
}

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'
import type { LauncherKind, TargetSource } from '@shared/ipc'
import { CONFIG_NAMES } from '../capture'
import { detectLauncher, resolvePlaywright } from './launcher'
import { analyzeScript, hasRecipeContext } from './script'

/**
 * Passive harness-target scan: find every plausible Playwright invocation
 * context inside an imported folder WITHOUT executing anything. The scan is
 * bounded (depth, directory count, symlink-cycle safe), skips generated and
 * dependency directories, and never runs package scripts — script text is
 * only analyzed lexically by script.ts. Candidates are validated later by
 * actually listing them (list.ts), which is the authoritative check.
 */

export interface ScannedCandidate {
  /** working directory, workspace-relative POSIX ('.' = the imported folder) */
  cwd: string
  /** package root owning the Playwright installation, workspace-relative POSIX */
  packageDir: string
  /** config file, workspace-relative POSIX; null = Playwright default resolution */
  configPath: string | null
  source: TargetSource
  scriptName: string | null
  scriptEnv: Record<string, string>
  extraArgs: string[]
  launcher: LauncherKind
  /** resolvable installed version (null = dependencies not installed) */
  playwrightVersion: string | null
  /**
   * This config-less target was inferred only because the package declares a
   * Playwright dependency. Validation may later prove that it is a library,
   * rather than a test harness; keep that distinction out of persisted target
   * state while discovery decides whether the candidate is useful.
   */
  implicitConfigless: boolean
}

export interface OpaqueScriptInfo {
  packageDir: string
  scriptName: string
  reason: string
}

export interface WorkspaceScan {
  candidates: ScannedCandidate[]
  /** playwright-related scripts that need manual configuration, not guessing */
  opaqueScripts: OpaqueScriptInfo[]
  /** the bounded walk hit a limit — deeper packages may exist */
  truncated: boolean
}

const MAX_DEPTH = 6
const MAX_DIRS = 2500
const MAX_CANDIDATES = 24

/** heavy/generated directories that must never be scanned */
const IGNORED_DIRS = new Set([
  'node_modules',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'tmp'
])

/** customized filenames that are still clearly Playwright configs, e.g. playwright.qa.config.ts */
const CUSTOM_CONFIG = /^playwright[-.].+\.config\.[cm]?[jt]s$/

/** conventional or clearly-customized Playwright config filename — the one
 *  grammar shared by the scanner and the file watcher */
export function isPlaywrightConfigName(name: string): boolean {
  return (CONFIG_NAMES as readonly string[]).includes(name) || CUSTOM_CONFIG.test(name)
}

/** normalize a relative path to POSIX separators ('' becomes '.') */
export function toPosixRelative(path: string): string {
  const posix = path.split(sep).join('/').replace(/\\/g, '/')
  return posix === '' ? '.' : posix
}

/** workspace-relative POSIX form of an absolute path inside the workspace */
export function workspaceRelative(root: string, absolute: string): string {
  return toPosixRelative(relative(root, absolute))
}

/** join a workspace-relative POSIX path back onto the root */
export function fromWorkspaceRelative(root: string, rel: string): string {
  return rel === '.' ? root : join(root, ...rel.split('/'))
}

/** True when candidate is root itself or a descendant on the current OS. */
export function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Resolve a script-supplied config argument against its package dir (POSIX,
 * workspace-relative). Returns null when the path escapes the workspace root
 * — such a config cannot be adopted (its containing workspace should be
 * imported instead).
 */
export function resolveConfigArg(packageDirRel: string, configArg: string): string | null {
  // Scripts may have been authored on a different OS than Wrightbench is
  // currently running on. Check both path grammars before normalizing, or a
  // POSIX path such as /tmp/pw.config.ts (or a Windows C:\\... path on macOS)
  // would be silently reinterpreted as a file inside the imported workspace.
  if (isAbsolute(configArg) || win32.isAbsolute(configArg)) return null
  const normalized = toPosixRelative(configArg).replace(/^\.\//, '')
  const baseRel = toPosixRelative(packageDirRel)
  const base = baseRel === '.' ? [] : baseRel.split('/')
  const parts = [...base]
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? null : parts.join('/')
}

function isConventionalConfig(name: string): boolean {
  return (CONFIG_NAMES as readonly string[]).includes(name)
}

interface PackageManifest {
  scripts: Record<string, string>
  declaresPlaywright: boolean
  workspaces: string[]
}

function readManifest(dir: string): PackageManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const pkg = parsed as Record<string, unknown>
  const scripts: Record<string, string> = {}
  if (typeof pkg.scripts === 'object' && pkg.scripts !== null) {
    for (const [name, value] of Object.entries(pkg.scripts)) {
      if (typeof value === 'string') scripts[name] = value
    }
  }
  let declaresPlaywright = false
  for (const field of ['devDependencies', 'dependencies'] as const) {
    const deps = pkg[field]
    if (typeof deps === 'object' && deps !== null) {
      const record = deps as Record<string, unknown>
      if ('@playwright/test' in record || 'playwright' in record) declaresPlaywright = true
    }
  }
  const workspaces: string[] = []
  const raw = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : typeof pkg.workspaces === 'object' && pkg.workspaces !== null
      ? (pkg.workspaces as { packages?: unknown }).packages
      : null
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') workspaces.push(entry)
    }
  }
  return { scripts, declaresPlaywright, workspaces }
}

/** modest workspace-glob expansion: literal segments plus single-`*` wildcards */
function expandWorkspacePattern(root: string, pattern: string, limit: number): string[] {
  const segments = pattern.split('/').filter((s) => s !== '' && s !== '.')
  let dirs = [root]
  for (const segment of segments) {
    if (dirs.length === 0 || dirs.length > limit) break
    if (segment === '**') return [] // recursive globs are already covered by the walk
    const next: string[] = []
    for (const dir of dirs) {
      if (segment === '*') {
        let entries: string[]
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue
          const candidate = join(dir, entry)
          try {
            if (statSync(candidate).isDirectory()) next.push(candidate)
          } catch {
            // vanished between readdir and stat
          }
        }
      } else if (!segment.includes('*')) {
        const candidate = join(dir, segment)
        try {
          if (statSync(candidate).isDirectory()) next.push(candidate)
        } catch {
          // pattern names a dir that doesn't exist
        }
      }
    }
    dirs = next.slice(0, limit)
  }
  return dirs
}

export function scanWorkspace(root: string): WorkspaceScan {
  const candidates: ScannedCandidate[] = []
  const opaqueScripts: OpaqueScriptInfo[] = []
  let truncated = false
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return { candidates, opaqueScripts, truncated }
  }

  interface QueueEntry {
    dir: string
    depth: number
    /** nearest ancestor (or self) that has a package.json */
    packageDir: string
  }

  const seenReal = new Set<string>()
  const queuedDirs = new Set<string>()
  const queue: QueueEntry[] = [{ dir: root, depth: 0, packageDir: root }]
  queuedDirs.add(root)
  let visited = 0

  const resolvedVersions = new Map<string, string | null>()
  const resolvedLaunchers = new Map<string, LauncherKind>()

  // De-duplicate at insertion time so many aliases that point at one config
  // cannot consume the bounded candidate budget before the final semantic
  // dedupe pass.
  const inserted = new Set<string>()
  const insertionKey = (candidate: ScannedCandidate): string =>
    candidate.source === 'script'
      ? [
          'script',
          candidate.cwd,
          candidate.configPath ?? '',
          JSON.stringify(Object.entries(candidate.scriptEnv).sort(([a], [b]) => a.localeCompare(b))),
          JSON.stringify(candidate.extraArgs)
        ].join('\u0000')
      : [candidate.source, candidate.cwd, candidate.configPath ?? ''].join('\u0000')
  const addCandidate = (candidate: ScannedCandidate): void => {
    const key = insertionKey(candidate)
    if (inserted.has(key)) return
    if (candidates.length >= MAX_CANDIDATES) {
      truncated = true
      // Dependency-only defaults are deliberately the lowest-confidence
      // candidates. Do not let a large monorepo full of Playwright-using
      // libraries crowd an explicit config or script context discovered
      // later in the bounded walk.
      if (candidate.implicitConfigless) return
      let implicitIndex = -1
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (candidates[index].implicitConfigless) {
          implicitIndex = index
          break
        }
      }
      if (implicitIndex === -1) return
      const [evicted] = candidates.splice(implicitIndex, 1)
      inserted.delete(insertionKey(evicted))
    }
    inserted.add(key)
    candidates.push(candidate)
  }

  const enqueue = (dir: string, depth: number, packageDir: string): void => {
    if (queuedDirs.has(dir)) return
    queuedDirs.add(dir)
    queue.push({ dir, depth, packageDir })
  }

  while (queue.length > 0) {
    const entry = queue.shift()!
    if (visited >= MAX_DIRS) {
      truncated = true
      break
    }
    visited += 1

    // Never cross the imported workspace's real boundary. This both breaks
    // symlink cycles and prevents validation from later executing a config
    // reached through a symlink into some unrelated folder.
    try {
      const real = realpathSync(entry.dir)
      if (!pathIsWithin(realRoot, real)) continue
      if (seenReal.has(real)) continue
      seenReal.add(real)
    } catch {
      continue
    }

    let entries: string[]
    try {
      entries = readdirSync(entry.dir)
    } catch {
      continue
    }
    const entrySet = new Set(entries)

    const isPackage = entrySet.has('package.json')
    const packageDirAbs = isPackage ? entry.dir : entry.packageDir
    const packageDirRel = workspaceRelative(root, packageDirAbs)

    const manifest = isPackage ? readManifest(entry.dir) : null

    const resolved = (dir: string): { version: string | null } => {
      let version = resolvedVersions.get(dir)
      if (version === undefined) {
        version = resolvePlaywright(dir)?.version ?? null
        resolvedVersions.set(dir, version)
      }
      return { version }
    }
    const launcherOf = (dir: string): LauncherKind => {
      let launcher = resolvedLaunchers.get(dir)
      if (launcher === undefined) {
        launcher = detectLauncher(dir, root)
        resolvedLaunchers.set(dir, launcher)
      }
      return launcher
    }

    // config files in this directory (conventional names + clear custom names)
    const configNames = entries.filter(
      (name) => isConventionalConfig(name) || CUSTOM_CONFIG.test(name)
    )
    // conventional first, then customized, stable within each group
    configNames.sort((a, b) => {
      const rank = (n: string): number => (isConventionalConfig(n) ? 0 : 1)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
    for (const name of configNames) {
      const configAbsolute = join(entry.dir, name)
      try {
        if (!statSync(configAbsolute).isFile()) continue
        if (!pathIsWithin(realRoot, realpathSync(configAbsolute))) continue
      } catch {
        continue
      }
      addCandidate({
        cwd: packageDirRel,
        packageDir: packageDirRel,
        configPath: workspaceRelative(root, configAbsolute),
        source: 'config',
        scriptName: null,
        scriptEnv: {},
        extraArgs: [],
        launcher: launcherOf(packageDirAbs),
        playwrightVersion: resolved(packageDirAbs).version,
        implicitConfigless: false
      })
    }

    if (manifest) {
      // a script without -c resolves Playwright's conventional config from its
      // cwd — record that config explicitly so dedup sees the same context
      const conventionalHere = CONFIG_NAMES.find((name) => entrySet.has(name))

      // package scripts as launch adapters (each analyzed exactly once)
      for (const [name, script] of Object.entries(manifest.scripts)) {
        const analysis = analyzeScript(script)
        if (analysis.kind === 'playwright-test') {
          const configFromArg =
            analysis.configArg !== null
              ? resolveConfigArg(packageDirRel, analysis.configArg)
              : undefined
          if (configFromArg === null) {
            // -c points above the imported folder — never adopt or guess
            opaqueScripts.push({
              packageDir: packageDirRel,
              scriptName: name,
              reason: 'references a config outside this folder'
            })
            continue
          }
          // Every safe script first contributes its independent base
          // configuration. This also covers config-less packages that use a
          // hoisted Playwright install and therefore do not declare the
          // dependency in their own package.json.
          const scriptConfig =
            configFromArg !== undefined
              ? configFromArg
              : conventionalHere !== undefined
                ? workspaceRelative(root, join(entry.dir, conventionalHere))
                : null
          addCandidate({
            cwd: packageDirRel,
            packageDir: packageDirRel,
            configPath: scriptConfig,
            source: 'config',
            scriptName: null,
            scriptEnv: {},
            extraArgs: [],
            launcher: launcherOf(entry.dir),
            playwrightVersion: resolved(entry.dir).version,
            implicitConfigless: false
          })

          if (!hasRecipeContext(analysis.env, analysis.args)) continue
          addCandidate({
            cwd: packageDirRel,
            packageDir: packageDirRel,
            configPath: scriptConfig,
            source: 'script',
            scriptName: name,
            scriptEnv: analysis.env,
            extraArgs: analysis.args,
            launcher: launcherOf(entry.dir),
            playwrightVersion: resolved(entry.dir).version,
            implicitConfigless: false
          })
        } else if (analysis.kind === 'playwright-other' && analysis.configArg) {
          // A non-running mode can still be the only place a custom config is
          // named. Keep the configuration discoverable without turning the
          // list/help/UI script itself into a runnable recipe.
          const configFromArg = resolveConfigArg(packageDirRel, analysis.configArg)
          if (configFromArg === null) {
            opaqueScripts.push({
              packageDir: packageDirRel,
              scriptName: name,
              reason: 'references a config outside this folder'
            })
            continue
          }
          addCandidate({
            cwd: packageDirRel,
            packageDir: packageDirRel,
            configPath: configFromArg,
            source: 'config',
            scriptName: null,
            scriptEnv: {},
            extraArgs: [],
            launcher: launcherOf(entry.dir),
            playwrightVersion: resolved(entry.dir).version,
            implicitConfigless: false
          })
        } else if (analysis.kind === 'opaque') {
          opaqueScripts.push({ packageDir: packageDirRel, scriptName: name, reason: analysis.reason })
        } else if (
          analysis.kind === 'unrelated' &&
          manifest.declaresPlaywright &&
          /^(test|e2e)([:._-]|$)/i.test(name)
        ) {
          // "test:e2e": "node tools/prepare-and-run-tests.js" in a package
          // that depends on Playwright: a custom launcher needing explicit
          // configuration — never something to guess at or execute
          opaqueScripts.push({
            packageDir: packageDirRel,
            scriptName: name,
            reason: 'is a custom launcher Wrightbench cannot analyze'
          })
        }
      }

      // a config-less package that really depends on Playwright still lists
      // via default resolution (testDir = cwd, default testMatch)
      const hasOwnConfig = configNames.length > 0
      if (manifest.declaresPlaywright && !hasOwnConfig) {
        addCandidate({
          cwd: packageDirRel,
          packageDir: packageDirRel,
          configPath: null,
          source: 'config',
          scriptName: null,
          scriptEnv: {},
          extraArgs: [],
          launcher: launcherOf(entry.dir),
          playwrightVersion: resolved(entry.dir).version,
          implicitConfigless: true
        })
      }

      // workspace declarations reach packages beyond the depth cap
      for (const pattern of manifest.workspaces.slice(0, 32)) {
        for (const dir of expandWorkspacePattern(entry.dir, pattern, 200)) {
          enqueue(dir, entry.depth + 1, dir)
        }
      }
    }

    if (entry.depth >= MAX_DEPTH) {
      truncated = truncated || entries.some((name) => !name.startsWith('.'))
      continue
    }

    for (const name of entries) {
      if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue
      const child = join(entry.dir, name)
      let stat
      try {
        stat = statSync(child)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      enqueue(child, entry.depth + 1, packageDirAbs)
    }
  }

  return { candidates: dedupeCandidates(candidates), opaqueScripts, truncated }
}

/**
 * Collapse only candidates that are semantically equivalent. A harness
 * target is one (cwd, config, environment, argv) launch context:
 *
 *  - scripts with identical cwd/config/env/argv collapse to the first label;
 *  - a script with no env and no argv is redundant with a plain config;
 *  - env-bearing or arg-bearing scripts remain distinct;
 *  - a plain config always remains available and is validated independently.
 *
 * Preserving the plain config is important: the existence of `test:qa` does
 * not prove that the same config cannot load normally, and fixed grep/project
 * arguments must never silently replace the full-suite target.
 */
export function dedupeCandidates(candidates: ScannedCandidate[]): ScannedCandidate[] {
  const configKey = (c: ScannedCandidate): string => `${c.cwd}|${c.configPath ?? ''}`
  const envKey = (c: ScannedCandidate): string =>
    Object.entries(c.scriptEnv)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\u0000')
  const argsKey = (c: ScannedCandidate): string => JSON.stringify(c.extraArgs)
  const plainConfigs = new Set(candidates.filter((c) => c.source === 'config').map(configKey))
  const seen = new Set<string>()
  const result: ScannedCandidate[] = []

  for (const candidate of candidates) {
    if (
      candidate.source === 'script' &&
      Object.keys(candidate.scriptEnv).length === 0 &&
      candidate.extraArgs.length === 0 &&
      plainConfigs.has(configKey(candidate))
    ) {
      continue
    }
    const identity =
      candidate.source === 'script'
        ? `script|${configKey(candidate)}|${envKey(candidate)}|${argsKey(candidate)}`
        : `${candidate.source}|${configKey(candidate)}`
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(candidate)
  }
  return result
}

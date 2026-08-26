import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { LauncherKind } from '@shared/ipc'

/**
 * Package-manager and Playwright-installation resolution for harness targets.
 * Everything here is local filesystem inspection — resolution never runs a
 * package manager and never downloads anything. Discovery and execution use
 * the resolved installation directly (`node <pkg>/cli.js …`), so a missing
 * installation is a diagnostic, never an implicit `npx` install.
 */

/**
 * The ESM app build derives a require from import.meta.url; the CJS test
 * bundle already has an ambient one (esbuild leaves import.meta.url
 * undefined there, so createRequire would throw). `typeof` keeps the probe
 * safe in real ESM where `require` is undeclared. Shared with inspect.ts.
 */
export function ambientRequire(): NodeRequire {
  return typeof require === 'function' ? require : createRequire(import.meta.url)
}
const nodeRequire = ambientRequire()

/** every lockfile name the launcher table knows — single source for
 *  detection-card display and watcher invalidation lists */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock'
]

const LOCKFILE_LAUNCHERS: readonly [string, LauncherKind][] = [
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun']
] // keep in sync with LOCKFILE_NAMES below (same rows, exported name list)

export function launcherFromPackageManagerField(value: unknown): LauncherKind | null {
  if (typeof value !== 'string') return null
  const name = value.split('@')[0].trim()
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  return null
}

export function launcherFromLockfileName(name: string): LauncherKind | null {
  return LOCKFILE_LAUNCHERS.find(([file]) => file === name)?.[1] ?? null
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Resolve the package manager owning `packageDir`, in order: the nearest
 * `packageManager` declaration, then the nearest lockfile — both walking up
 * from the package to the workspace root — then a conservative npm fallback.
 */
export function detectLauncher(packageDir: string, workspaceRoot: string): LauncherKind {
  let dir = packageDir
  for (;;) {
    const declared = launcherFromPackageManagerField(readPackageJson(dir)?.packageManager)
    if (declared) return declared
    for (const [file, launcher] of LOCKFILE_LAUNCHERS) {
      if (existsSync(join(dir, file))) return launcher
    }
    if (dir === workspaceRoot) break
    const parent = dirname(dir)
    if (parent === dir || !parent.startsWith(workspaceRoot)) break
    dir = parent
  }
  return 'npm'
}

export interface ResolvedPlaywright {
  /** package root of the resolved installation */
  packageRoot: string
  /** absolute path of the CLI entry to hand to `node` */
  cliPath: string
  version: string | null
}

/**
 * Locate the Playwright installation a package actually uses, without
 * executing anything: resolve `@playwright/test` (falling back to
 * `playwright`, whose cli.js hosts the same runner) from the package dir and
 * hand back its cli.js. Works for npm/pnpm/yarn(node-modules)/bun layouts;
 * Yarn Plug'n'Play has no node_modules to resolve through and is reported as
 * unresolvable (callers surface a structured diagnostic).
 */
export function resolvePlaywright(packageDir: string): ResolvedPlaywright | null {
  for (const pkg of ['@playwright/test', 'playwright'] as const) {
    let manifestPath: string
    try {
      manifestPath = nodeRequire.resolve(`${pkg}/package.json`, { paths: [packageDir] })
    } catch {
      continue
    }
    const packageRoot = dirname(manifestPath)
    const cliPath = join(packageRoot, 'cli.js')
    if (!existsSync(cliPath)) continue
    let version: string | null = null
    try {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const value = (manifest as { version?: unknown }).version
      if (typeof value === 'string' && value !== '') version = value
    } catch {
      version = null
    }
    return { packageRoot, cliPath, version }
  }
  return null
}

/** true when the package tree uses Yarn Plug'n'Play (no node_modules to resolve) */
export function usesYarnPnp(packageDir: string, workspaceRoot: string): boolean {
  let dir = packageDir
  for (;;) {
    if (existsSync(join(dir, '.pnp.cjs')) || existsSync(join(dir, '.pnp.js'))) return true
    if (dir === workspaceRoot) return false
    const parent = dirname(dir)
    if (parent === dir || !parent.startsWith(workspaceRoot)) return false
    dir = parent
  }
}

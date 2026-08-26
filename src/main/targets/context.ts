import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { HarnessTarget } from '@shared/ipc'
import { fromWorkspaceRelative, pathIsWithin, toPosixRelative } from './scan'
import { resolvePlaywright, usesYarnPnp, type ResolvedPlaywright } from './launcher'

export type TargetContextFailureCode = 'outside-workspace' | 'pnp' | 'missing-playwright'

export interface ResolvedTargetContext {
  workspaceRoot: string
  cwd: string
  packageDir: string
  configPath: string | null
  playwright: ResolvedPlaywright
}

export type TargetContextResult =
  | { ok: true; context: ResolvedTargetContext }
  | { ok: false; code: TargetContextFailureCode }

function realPathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Canonicalize an existing target path while keeping missing leaves bounded. */
function resolvedWorkspacePath(root: string, realRoot: string, rel: string): string {
  const lexical = fromWorkspaceRelative(root, rel)
  try {
    return realpathSync(lexical)
  } catch {
    return fromWorkspaceRelative(realRoot, rel)
  }
}

/**
 * Resolve only persisted, sanitized target data. Every resulting path is
 * checked against the imported workspace before a local Playwright CLI can
 * be loaded or spawned.
 */
export function resolveTargetContext(
  workspaceRoot: string,
  target: Pick<HarnessTarget, 'cwd' | 'packageDir' | 'configPath'>
): TargetContextResult {
  const root = realPathOr(workspaceRoot)
  const cwd = resolvedWorkspacePath(workspaceRoot, root, target.cwd)
  const packageDir = resolvedWorkspacePath(workspaceRoot, root, target.packageDir)
  const configPath =
    target.configPath === null
      ? null
      : resolvedWorkspacePath(workspaceRoot, root, target.configPath)

  if (
    !pathIsWithin(root, cwd) ||
    !pathIsWithin(root, packageDir) ||
    (configPath !== null && !pathIsWithin(root, configPath))
  ) {
    return { ok: false, code: 'outside-workspace' }
  }

  const playwright = resolvePlaywright(packageDir)
  if (playwright === null) {
    return {
      ok: false,
      code: usesYarnPnp(packageDir, root) ? 'pnp' : 'missing-playwright'
    }
  }
  return {
    ok: true,
    context: { workspaceRoot: root, cwd, packageDir, configPath, playwright }
  }
}

/** Wrightbench-owned flags must stay before a package script's custom `--` contract. */
export function splitTargetArgs(extraArgs: string[]): {
  options: string[]
  customArgs: string[]
} {
  const separator = extraArgs.indexOf('--')
  return separator === -1
    ? { options: extraArgs, customArgs: [] }
    : { options: extraArgs.slice(0, separator), customArgs: extraArgs.slice(separator) }
}

/**
 * Convert the renderer's workspace-relative `file:line` identity into the
 * selected target cwd's relative spelling, rejecting arbitrary paths.
 */
export function targetRunLocation(
  context: Pick<ResolvedTargetContext, 'workspaceRoot' | 'cwd'>,
  location: string | null | undefined
): string | null {
  if (!location) return null
  if (location.length > 4096 || location.includes('\u0000')) throw new Error('invalid test location')
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(location)
  if (!match || match[1] === '') throw new Error('invalid test location')
  const file = match[1]
  const line = Number(match[2])
  const column = match[3] === undefined ? null : Number(match[3])
  if (
    !Number.isInteger(line) ||
    line < 1 ||
    (column !== null && (!Number.isInteger(column) || column < 1)) ||
    isAbsolute(file)
  ) {
    throw new Error('invalid test location')
  }
  const absolute = resolve(context.workspaceRoot, file)
  if (!pathIsWithin(context.workspaceRoot, absolute)) throw new Error('invalid test location')
  let canonicalFile: string
  try {
    canonicalFile = realpathSync(absolute)
    if (!statSync(canonicalFile).isFile()) throw new Error('not a file')
  } catch {
    throw new Error('invalid test location')
  }
  // Lexical containment alone is insufficient: a workspace symlink may point
  // at an unrelated file outside the imported folder.
  if (!pathIsWithin(context.workspaceRoot, canonicalFile)) {
    throw new Error('invalid test location')
  }
  const fromCwd = toPosixRelative(relative(context.cwd, canonicalFile))
  return `${fromCwd}:${line}${column === null ? '' : `:${column}`}`
}

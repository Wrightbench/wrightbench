import type { TargetDiagnostic, TargetDiscoveryStatus, TargetSummary } from '@shared/ipc'

export type TargetStatusTone = 'ok' | 'warn' | 'fail' | 'muted'
export type StandaloneRecovery = 'environment' | 'setup' | null

/**
 * WAI-ARIA radio-group navigation: arrows wrap, while Home/End jump to an edge.
 * Returning null lets unrelated keys retain their native button behavior.
 */
export function radioNavigationIndex(
  key: string,
  currentIndex: number,
  itemCount: number
): number | null {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) return null
  if (key === 'ArrowDown' || key === 'ArrowRight') return (currentIndex + 1) % itemCount
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return (currentIndex - 1 + itemCount) % itemCount
  }
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  return null
}

/** Recovery rows are status-driven and stay visible even without a target picker. */
export function standaloneRecoveryFor(status: TargetDiscoveryStatus): StandaloneRecovery {
  if (status === 'needs-context') return 'environment'
  if (status === 'setup-required') return 'setup'
  return null
}

/** Shared presentation contract for one import-detection target row. */
export function targetStatusPresentation(
  status: TargetDiscoveryStatus,
  testCount: number | null
): { caption: string; tone: TargetStatusTone } {
  switch (status) {
    case 'ready':
      return { caption: `${testCount ?? '?'} tests`, tone: 'ok' }
    case 'empty':
      return { caption: 'no tests', tone: 'muted' }
    case 'needs-context':
      return { caption: 'needs environment', tone: 'warn' }
    case 'setup-required':
      return { caption: 'needs setup', tone: 'warn' }
    case 'dependencies-missing':
      return { caption: 'dependencies not installed', tone: 'warn' }
    case 'invalid-config':
      return { caption: 'config failed to load', tone: 'fail' }
    case 'test-load-failed':
      return { caption: 'tests failed to load', tone: 'fail' }
    case 'timed-out':
      return { caption: 'listing timed out', tone: 'fail' }
    case 'unsupported-launcher':
      return { caption: 'unsupported layout', tone: 'warn' }
    case 'not-validated':
      return { caption: 'not validated', tone: 'muted' }
    default:
      return { caption: 'listing failed', tone: 'fail' }
  }
}

/** Detail and remediation shown when the user selects a failed target row. */
export function targetDiagnosticPresentation(
  status: TargetDiscoveryStatus,
  diagnostic: TargetDiagnostic | null
): { detail: string | null; suggestion: string | null } {
  if (status === 'ready' || status === 'empty' || diagnostic === null) {
    return { detail: null, suggestion: null }
  }
  return {
    detail: diagnostic.detail ?? diagnostic.summary,
    suggestion: diagnostic.suggestion
  }
}

/** A configuration is a complete inventory; a script target is an optional recipe. */
export function isRunRecipe(target: Pick<TargetSummary, 'source'>): boolean {
  return target.source === 'script'
}

/** Invocation contexts sharing these fields load the same Playwright config. */
export function targetConfigurationKey(
  target: Pick<TargetSummary, 'cwd' | 'configPath' | 'packageDir'>
): string {
  return JSON.stringify([target.cwd, target.configPath, target.packageDir])
}

export interface TargetGroup<T extends TargetSummary = TargetSummary> {
  key: string
  /** null only for a malformed legacy registry containing an orphan recipe */
  configuration: T | null
  recipes: T[]
}

/**
 * Derive the presentation model without changing the persisted target schema:
 * configurations choose a complete inventory, recipes apply fixed env/argv to
 * that same configuration. User-picked and scanned copies of one config are
 * deliberately collapsed.
 */
export function groupTargets<T extends TargetSummary>(targets: readonly T[]): TargetGroup<T>[] {
  const groups = new Map<string, TargetGroup<T>>()

  for (const target of targets) {
    if (isRunRecipe(target)) continue
    const key = targetConfigurationKey(target)
    const current = groups.get(key)
    if (!current) {
      groups.set(key, { key, configuration: target, recipes: [] })
      continue
    }
    // A scanner-owned configuration is the stable canonical row when the
    // same file was also manually selected in an earlier session.
    if (current.configuration?.source === 'user' && target.source === 'config') {
      current.configuration = target
    }
  }

  for (const target of targets) {
    if (!isRunRecipe(target)) continue
    const key = targetConfigurationKey(target)
    const group = groups.get(key) ?? { key, configuration: null, recipes: [] }
    group.recipes.push(target)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    group.recipes.sort((a, b) => a.label.localeCompare(b.label))
  }
  return [...groups.values()]
}

import { isAbsolute } from 'node:path'
import type { HarnessTarget, ProjectInfo } from '@shared/ipc'
import { projectTargets } from './projects'

export interface ResolvedUiModeRequest {
  projectPath: string
  /** The active target selected by the renderer/user (a recipe is allowed). */
  targetId: string
  profile: string | null
  /** Effective full configuration. Recipe-only CLI filters/argv are absent. */
  target: HarnessTarget
  /** Safe inline recipe env still applies; Wrightbench adds no stored profile overlay. */
  recipeEnv: Record<string, string>
}

function sameConfiguration(left: HarnessTarget, right: HarnessTarget): boolean {
  return (
    left.cwd === right.cwd &&
    left.configPath === right.configPath &&
    left.packageDir === right.packageDir
  )
}

/**
 * Resolve an untrusted renderer request to the registered active target.
 * UI Mode is configuration-oriented: if the active target is a run recipe,
 * use the persisted base configuration with the same cwd/config/package and
 * intentionally discard the recipe's fixed filters and custom argv. Safe
 * inline recipe env is retained because it may be required to load the config.
 */
export function resolveUiModeRequest(
  value: unknown,
  projects: readonly ProjectInfo[]
): ResolvedUiModeRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid UI Mode request')
  const input = value as Record<string, unknown>
  const path = input.path
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid project path')

  const registered = projects.find((project) => project.path === path)
  if (!registered) throw new Error('unknown project')
  const { targets, activeTargetId } = projectTargets(registered)

  const targetId = input.targetId
  if (
    typeof targetId !== 'string' ||
    targetId === '' ||
    targetId.length > 64 ||
    targetId.includes('\u0000')
  ) {
    throw new Error('missing or invalid test configuration')
  }
  if (targetId !== activeTargetId) {
    throw new Error('The selected test configuration changed; refresh the test list and retry')
  }
  const requested = targets.find((candidate) => candidate.id === targetId)
  if (!requested) throw new Error('unknown test configuration')

  let target = requested
  if (requested.source === 'script') {
    target =
      targets.find(
        (candidate) => candidate.source === 'config' && sameConfiguration(candidate, requested)
      ) ??
      targets.find(
        (candidate) => candidate.source === 'user' && sameConfiguration(candidate, requested)
      ) ??
      requested
    if (target === requested) {
      throw new Error(
        'The selected run recipe has no base configuration; refresh project configurations and retry'
      )
    }
  }

  return {
    projectPath: path,
    targetId,
    // Retained in the downstream/shared shape while legacy settings migrate;
    // it is never active launch context.
    profile: null,
    target,
    recipeEnv: requested.source === 'script' ? requested.scriptEnv : target.scriptEnv
  }
}

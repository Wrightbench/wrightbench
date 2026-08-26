import { isAbsolute } from 'node:path'
import type { HarnessTarget, ProjectInfo, RunConfig } from '@shared/ipc'
import { projectTargets } from './projects'
import { sanitizeCliProcessEnv } from './pwadapter'

export interface ResolvedRunRequest {
  config: RunConfig
  target: HarnessTarget
  env: Record<string, string>
}

export type RuntimeEnvResolver = () => Record<string, string>

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > maxLength || value.includes('\u0000')) {
    throw new Error(`invalid ${label}`)
  }
  return value
}

/**
 * Resolve an untrusted renderer request to one exact registered invocation
 * context. The renderer supplies only an id; cwd/config/env/argv always come
 * from the persisted main-process target.
 */
export function resolveRunRequest(
  value: unknown,
  projects: readonly ProjectInfo[],
  resolveRuntimeEnv: RuntimeEnvResolver
): ResolvedRunRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid run request')
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
  const target = targets.find((candidate) => candidate.id === targetId)
  if (!target) throw new Error('unknown test configuration')

  let workers: number | null = null
  if (input.workers !== null && input.workers !== undefined) {
    if (
      !Number.isInteger(input.workers) ||
      (input.workers as number) < 1 ||
      (input.workers as number) > 1024
    ) {
      throw new Error('invalid workers value')
    }
    workers = input.workers as number
  }
  const trigger =
    input.trigger === 'watch' || input.trigger === 'rerun-failed' ? input.trigger : 'manual'
  const config: RunConfig = {
    path,
    targetId,
    project: optionalString(input.project, 'Playwright project', 500),
    grep: optionalString(input.grep, 'grep pattern', 4096),
    workers,
    envProfile: null,
    lastFailed: input.lastFailed === true,
    location: optionalString(input.location, 'test location', 4096),
    trigger
  }

  // Script defaults form the target. Wrightbench contributes only its runtime
  // controls (fixed Node path and reporter-open suppression), never stored
  // profile values. Private UI session keys are never inherited.
  const env = sanitizeCliProcessEnv({
    ...target.scriptEnv,
    ...resolveRuntimeEnv()
  })
  return { config, target, env }
}

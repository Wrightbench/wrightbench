import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EnvironmentSetupHint, HarnessTarget } from '@shared/ipc'
import {
  fromWorkspaceRelative,
  pathIsWithin,
  workspaceRelative
} from './scan'

const ENV_TEMPLATE_NAMES = ['.env.example', '.env.sample', '.env.template'] as const

/** Does this path exist, including a broken symlink? */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Report conventional environment templates near a target's config/package.
 *
 * This is deliberately metadata-only: Wrightbench never reads a template,
 * creates the destination, or follows a template symlink outside the imported
 * workspace. Existing local .env files suppress the hint entirely.
 */
export function environmentSetupHintsFor(
  workspaceRoot: string,
  target: Pick<HarnessTarget, 'cwd' | 'configPath' | 'packageDir'>
): EnvironmentSetupHint[] {
  let realRoot: string
  try {
    realRoot = realpathSync(workspaceRoot)
  } catch {
    return []
  }

  const configDir =
    target.configPath !== null
      ? dirname(fromWorkspaceRelative(workspaceRoot, target.configPath))
      : null
  const candidateDirs = [
    configDir,
    fromWorkspaceRelative(workspaceRoot, target.cwd),
    fromWorkspaceRelative(workspaceRoot, target.packageDir)
  ].filter((path): path is string => path !== null)

  const seenDirs = new Set<string>()
  const seenHints = new Set<string>()
  const hints: EnvironmentSetupHint[] = []
  for (const directory of candidateDirs) {
    let realDirectory: string
    try {
      realDirectory = realpathSync(directory)
    } catch {
      continue
    }
    if (!pathIsWithin(realRoot, realDirectory) || seenDirs.has(realDirectory)) continue
    seenDirs.add(realDirectory)

    const destination = join(directory, '.env')
    if (pathEntryExists(destination)) continue

    for (const name of ENV_TEMPLATE_NAMES) {
      const template = join(directory, name)
      let realTemplate: string
      try {
        realTemplate = realpathSync(template)
        if (!pathIsWithin(realRoot, realTemplate) || !statSync(realTemplate).isFile()) continue
      } catch {
        continue
      }

      const hint: EnvironmentSetupHint = {
        templatePath: workspaceRelative(workspaceRoot, template),
        destinationPath: workspaceRelative(workspaceRoot, destination)
      }
      const key = `${hint.templatePath}\0${hint.destinationPath}`
      if (seenHints.has(key)) continue
      seenHints.add(key)
      hints.push(hint)
    }
  }
  return hints
}

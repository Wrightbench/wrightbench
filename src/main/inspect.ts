import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { killTree, trackedSpawn } from './proc'
import { resolvePlaywright } from './targets/launcher'
import { cachedDiscovery, cacheDiscovery, discoverTargets } from './targets/service'
import type { ProjectInspection, TargetCandidateInfo } from '@shared/ipc'

/**
 * Project inspection for the import card. This pass is intentionally passive:
 * it finds safe local Playwright launch contexts and installed versions, but
 * does not load the config, list tests, probe browser caches, or resolve Node.
 * Playwright UI Mode and the workspace test tree own those runtime concerns
 * after the project has been registered.
 */

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = trackedSpawn(cmd, args, cwd, extraEnv)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => (stdout += d))
    child.stderr?.on('data', (d: string) => (stderr += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function emptyInspection(projectPath: string): ProjectInspection {
  return {
    path: projectPath,
    name: basename(projectPath),
    configFile: null,
    playwrightVersion: null,
    targets: [],
    recommendedTargetId: null
  }
}

export async function inspectProject(
  projectPath: string,
  _envProfile: string | null = null
): Promise<ProjectInspection> {
  let isDirectory = false
  try {
    isDirectory = statSync(projectPath).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) return emptyInspection(projectPath)

  // user-picked configs from an earlier dialog survive a re-inspection
  const userTargets = (cachedDiscovery(projectPath)?.targets ?? []).filter(
    (t) => t.source === 'user'
  )
  const discovery = await discoverTargets(projectPath, null, {
    validate: false,
    extraCandidates: userTargets
  })

  // UI Mode is configuration-oriented. Safe script recipes stay in the
  // cached/persisted discovery result for the CLI runner, but never appear as
  // choices during import. A dependency-only default is also redundant when
  // an explicit config/user/script-derived base context exists; omit it
  // without executing Playwright just to prove that default is empty.
  const implicitConfiglessIds = new Set(discovery.implicitConfiglessTargetIds)
  const hasCredibleConfiguration = discovery.targets.some(
    (target) => target.source !== 'script' && !implicitConfiglessIds.has(target.id)
  )
  const importSuppressions = hasCredibleConfiguration
    ? discovery.implicitConfiglessTargetIds
    : discovery.suppressedTargetIds
  cacheDiscovery(projectPath, { ...discovery, suppressedTargetIds: importSuppressions })
  const configurations = discovery.candidates.filter(
    (candidate) =>
      candidate.source !== 'script' &&
      (!hasCredibleConfiguration || !implicitConfiglessIds.has(candidate.id))
  )

  const best: TargetCandidateInfo | null =
    configurations.find((c) => c.id === discovery.recommendedTargetId) ??
    configurations[0] ??
    null

  // Installed version comes from the selected package context, with a root
  // hoist as the fallback. A declared range is not enough to launch UI Mode.
  const installed = best?.playwrightVersion ?? resolvePlaywright(projectPath)?.version ?? null

  return {
    path: projectPath,
    name: basename(projectPath),
    configFile: best?.configPath ?? null,
    playwrightVersion: installed,
    targets: configurations,
    recommendedTargetId: best?.id ?? null
  }
}

/** where/which node resolves on the repaired PATH — for the Settings chip */
export async function probeNode(): Promise<{ autoPath: string | null; autoVersion: string | null }> {
  const [version, where] = await Promise.all([
    run('node', ['--version'], homedir(), 10_000),
    run(process.platform === 'win32' ? 'where' : 'which', ['node'], homedir(), 10_000)
  ])
  return {
    autoVersion: version.code === 0 && version.stdout.trim() !== '' ? version.stdout.trim() : null,
    autoPath: where.code === 0 ? (where.stdout.trim().split('\n')[0] || null) : null
  }
}

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { cp } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import type { CommandResult, ReportInfo } from '@shared/ipc'
import { killTree, NPX, trackedSpawn } from './proc'
import { freePort, waitForHttp } from './servers'
import { reportDirectoryForRun } from './db'

/**
 * Hosts Playwright HTML reports (`npx playwright show-report`) for contextual
 * inspector webviews. The legacy current-project helpers remain for existing
 * callers; completed Tests runs use the immutable per-run report directory.
 */

interface ReportServer {
  port: number
  child: ChildProcess
  ready: Promise<void>
}

const servers = new Map<string, ReportServer>()
const starting = new Map<string, Promise<{ port: number }>>()
const runServers = new Map<string, ReportServer>()
const runStarting = new Map<string, Promise<{ url: string }>>()

function runKey(projectPath: string, runId: number): string {
  return `${projectPath}\u0000${runId}`
}

function reportIndex(projectPath: string): string {
  return join(projectPath, 'playwright-report', 'index.html')
}

export function reportInfo(projectPath: string): ReportInfo {
  try {
    const stat = statSync(reportIndex(projectPath))
    return { exists: true, generatedAt: stat.mtimeMs }
  } catch {
    return { exists: false, generatedAt: null }
  }
}

async function launchReport(projectPath: string): Promise<{ port: number }> {
  if (!reportInfo(projectPath).exists) {
    throw new Error('no report yet — run the suite first')
  }
  const port = await freePort()
  const child = trackedSpawn(
    NPX,
    ['playwright', 'show-report', '--host', '127.0.0.1', '--port', String(port)],
    projectPath
  )
  const entry: ReportServer = {
    port,
    child,
    ready: waitForHttp(`http://127.0.0.1:${port}`, child, /playwright|report/i, 'report server', 20_000)
  }
  servers.set(projectPath, entry)
  child.on('close', () => {
    if (servers.get(projectPath)?.child === child) servers.delete(projectPath)
  })
  try {
    await entry.ready
  } catch (err) {
    stopReport(projectPath)
    throw err
  }
  return { port }
}

export function startReport(projectPath: string): Promise<{ port: number }> {
  const existing = servers.get(projectPath)
  if (existing) return existing.ready.then(() => ({ port: existing.port }))
  const inFlight = starting.get(projectPath)
  if (inFlight) return inFlight
  const promise = launchReport(projectPath).finally(() => starting.delete(projectPath))
  starting.set(projectPath, promise)
  return promise
}

export function stopReport(projectPath: string): boolean {
  let stopped = false
  const server = servers.get(projectPath)
  if (server) {
    killTree(server.child)
    servers.delete(projectPath)
    stopped = true
  }
  for (const [key, entry] of runServers) {
    if (!key.startsWith(`${projectPath}\u0000`)) continue
    killTree(entry.child)
    runServers.delete(key)
    stopped = true
  }
  return stopped
}

export function reportPort(projectPath: string): number | null {
  return servers.get(projectPath)?.port ?? null
}

/** Main-process webview policy helper: only currently live report ports qualify. */
export function hasReportPort(projectPath: string, port: number): boolean {
  if (servers.get(projectPath)?.port === port) return true
  for (const [key, entry] of runServers) {
    if (key.startsWith(`${projectPath}\u0000`) && entry.port === port) return true
  }
  return false
}

async function launchRunReport(
  projectPath: string,
  runId: number,
  reportDir: string
): Promise<{ url: string }> {
  try {
    if (!statSync(join(reportDir, 'index.html')).isFile()) throw new Error('missing report index')
  } catch {
    throw new Error('this run has no retained HTML report')
  }
  const key = runKey(projectPath, runId)
  const port = await freePort()
  const child = trackedSpawn(
    NPX,
    [
      'playwright',
      'show-report',
      reportDir,
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    projectPath
  )
  const url = `http://127.0.0.1:${port}`
  const entry: ReportServer = {
    port,
    child,
    ready: waitForHttp(url, child, /playwright|report/i, 'run report server', 20_000)
  }
  runServers.set(key, entry)
  child.on('close', () => {
    if (runServers.get(key)?.child === child) runServers.delete(key)
  })
  try {
    await entry.ready
  } catch (err) {
    killTree(child)
    runServers.delete(key)
    throw err
  }
  return { url }
}

/** Serve the immutable report captured for an exact history run. */
export function serveRunReport(projectPath: string, runId: number): Promise<{ url: string }> {
  const reportDir = reportDirectoryForRun(projectPath, runId)
  if (!reportDir) return Promise.reject(new Error('this run has no retained HTML report'))
  const key = runKey(projectPath, runId)
  const existing = runServers.get(key)
  if (existing) return existing.ready.then(() => ({ url: `http://127.0.0.1:${existing.port}` }))
  const inFlight = runStarting.get(key)
  if (inFlight) return inFlight
  const promise = launchRunReport(projectPath, runId, reportDir).finally(() => runStarting.delete(key))
  runStarting.set(key, promise)
  return promise
}

/** copy the report folder to a user-picked destination directory */
export async function exportReport(projectPath: string, destDir: string): Promise<CommandResult> {
  if (!reportInfo(projectPath).exists) {
    return { ok: false, code: null, error: 'no report to export' }
  }
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    await cp(join(projectPath, 'playwright-report'), join(destDir, `playwright-report-${stamp}`), {
      recursive: true
    })
    return { ok: true, code: 0 }
  } catch (err) {
    return { ok: false, code: null, error: err instanceof Error ? err.message : String(err) }
  }
}

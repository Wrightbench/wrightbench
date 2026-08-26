import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { wrightbenchDir } from './settings'

export const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'
export const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** GUI apps on macOS get a minimal PATH; make sure the usual node homes are on it. */
export function spawnEnv(): NodeJS.ProcessEnv {
  const extras = ['/usr/local/bin', '/opt/homebrew/bin']
  const path = process.env.PATH ?? ''
  const parts = path.split(delimiter)
  const missing =
    process.platform === 'win32' ? [] : extras.filter((p) => !parts.includes(p))
  return { ...process.env, PATH: [path, ...missing].filter(Boolean).join(delimiter) }
}

const live = new Set<ChildProcess>()

/**
 * On-disk ledger of spawned child pids. A graceful quit kills children via
 * 'before-quit', but a crash or a hard kill (electron-vite dev restarts the
 * main process with SIGKILL) orphans them — detached process-group leaders
 * like `playwright test-server` then outlive the app indefinitely. The
 * ledger lets the next launch reap what the previous instance leaked.
 */
interface LedgerEntry {
  pid: number
  cmd: string
}

function ledgerPath(): string {
  return join(wrightbenchDir(), 'live-pids.json')
}

function readLedger(): LedgerEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is LedgerEntry =>
        typeof e === 'object' && e !== null &&
        typeof (e as LedgerEntry).pid === 'number' &&
        typeof (e as LedgerEntry).cmd === 'string'
    )
  } catch {
    return []
  }
}

function writeLedger(entries: LedgerEntry[]): void {
  try {
    writeFileSync(ledgerPath(), JSON.stringify(entries))
  } catch {
    // ledger is best-effort — never let bookkeeping break a spawn
  }
}

function ledgerAdd(pid: number, cmd: string): void {
  writeLedger([...readLedger().filter((e) => e.pid !== pid), { pid, cmd }])
}

function ledgerRemove(pid: number): void {
  writeLedger(readLedger().filter((e) => e.pid !== pid))
}

/** the live command line of a pid, or null when it no longer runs */
function commandOf(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8'
      })
      return out.includes(`"${pid}"`) ? out.trim() : null
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    return out.trim() === '' ? null : out.trim()
  } catch {
    return null
  }
}

/**
 * Reap children a previous instance leaked. Runs once at startup. A pid is
 * killed only if the ledger recorded it AND its live command still looks
 * like something we spawn (guards against pid reuse by unrelated processes).
 */
export function sweepOrphans(): void {
  const entries = readLedger()
  if (entries.length === 0) return
  for (const entry of entries) {
    const cmd = commandOf(entry.pid)
    const ours =
      cmd !== null &&
      (/playwright|node_modules/i.test(cmd) || (process.platform === 'win32' && /node/i.test(cmd)))
    if (ours) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'])
        } else {
          try {
            process.kill(-entry.pid, 'SIGKILL')
          } catch {
            process.kill(entry.pid, 'SIGKILL')
          }
        }
        console.log(`reaped orphaned child from previous session: pid ${entry.pid} (${entry.cmd})`)
      } catch {
        // already gone between the check and the kill
      }
    }
  }
  writeLedger([])
}

/**
 * npx/npm spawn their real work as grandchildren; killing just the wrapper
 * leaves them running. On POSIX we make the child a process-group leader and
 * kill the whole group.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // child.kill() would stop only the npx.cmd wrapper — taskkill takes the tree
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** Kill every tracked child — wired to app 'before-quit'. */
export function killAllTracked(): void {
  for (const child of live) killTree(child)
  live.clear()
}

export function trackedSpawn(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>
): ChildProcess {
  const base = spawnEnv()
  let env = base
  if (extraEnv) {
    // a profile's PATH extends the repaired PATH — it must never replace it,
    // or npx itself becomes unresolvable
    const { PATH: extraPath, ...rest } = extraEnv
    env = { ...base, ...rest }
    if (extraPath) env.PATH = `${extraPath}${delimiter}${base.PATH ?? ''}`
  }
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: process.platform !== 'win32'
  })
  live.add(child)
  if (child.pid !== undefined) ledgerAdd(child.pid, `${cmd} ${args.join(' ')}`.slice(0, 200))
  const forget = (): void => {
    live.delete(child)
    if (child.pid !== undefined) ledgerRemove(child.pid)
  }
  child.on('close', forget)
  child.on('error', forget)
  return child
}

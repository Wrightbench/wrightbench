import { realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { killTree, trackedSpawn } from '../proc'
import { pathIsWithin, toPosixRelative } from './scan'
import { resolveTargetContext, splitTargetArgs } from './context'
import { sanitizeCliProcessEnv } from '../pwadapter'
import type {
  HarnessTarget,
  TargetDiagnostic,
  TargetDiscoveryStatus,
  TestDecl,
  TestTree
} from '@shared/ipc'

/**
 * Target-aware `playwright test --list --reporter=json` invocation and
 * parsing. This is the single discovery service: import validation and the
 * workspace test tree both run through here with the same launch context
 * (cwd, explicit config, the project's own installed Playwright, script env,
 * profile env, fixed args) — the exact context a future runner reuses.
 *
 * The project's installation is invoked directly (`node <pkg>/cli.js`),
 * never through `npx`/`yarn dlx`-style commands, so discovery can never
 * download Playwright or fall back to an unrelated global installation.
 */

export interface ExecRequest {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** spawn-level failure (ENOENT etc.), when the child never ran */
  spawnError: string | null
  stdoutTruncated: boolean
}

export type ExecFn = (request: ExecRequest) => Promise<ExecResult>

/** hard caps so a chatty config can't exhaust main-process memory */
const STDOUT_CAP = 32 * 1024 * 1024
const STDERR_CAP = 16 * 1024
const OUTPUT_EXCERPT_CAP = 1200
const DETAIL_CAP = 600
export const LIST_TIMEOUT_MS = 60_000

/** real exec on trackedSpawn: process-group cleanup, capped capture */
export const defaultExec: ExecFn = (request) =>
  new Promise((resolve) => {
    let child
    try {
      child = trackedSpawn(request.cmd, request.args, request.cwd, request.env)
    } catch (err) {
      resolve({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
        stdoutTruncated: false
      })
      return
    }
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let timedOut = false
    let spawnError: string | null = null
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, request.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdoutTruncated) return
      const room = STDOUT_CAP - stdout.length
      stdout += chunk.length > room ? chunk.slice(0, room) : chunk
      if (stdout.length >= STDOUT_CAP) {
        stdoutTruncated = true
        killTree(child)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length)
    })
    child.on('error', (err) => {
      spawnError = err.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, spawnError, stdoutTruncated })
    })
  })

// ---- JSON report shapes (the parts we read; everything else is ignored) ----

interface ListedSpec {
  file?: string
  title?: string
  line?: number
  column?: number
  tests?: { projectName?: string }[]
}

interface ListedSuite {
  title?: string
  file?: string
  suites?: ListedSuite[]
  specs?: ListedSpec[]
}

interface ListedProject {
  name?: string
  testDir?: string
}

interface ListedReport {
  config?: { rootDir?: string; projects?: ListedProject[] }
  suites?: ListedSuite[]
  errors?: { message?: string }[]
}

function isListedReport(value: unknown): value is ListedReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  if (typeof report.config !== 'object' || report.config === null || Array.isArray(report.config)) {
    return false
  }
  if (!Array.isArray(report.suites) || !Array.isArray(report.errors)) return false
  return true
}

/**
 * The report is the LAST JSON document on stdout, but the user's config may
 * console.log anything (including braces) before it — try every line that
 * starts with '{', last candidate first. Returns the report plus where it
 * starts, so diagnostics can quote only the noise before it.
 */
export function parseListReport(
  stdout: string
): { report: ListedReport; start: number } | null {
  const candidates: number[] = []
  const lineStart = /^\{/gm
  let match: RegExpExecArray | null
  while ((match = lineStart.exec(stdout)) !== null) candidates.push(match.index)
  const first = stdout.indexOf('{')
  if (first !== -1 && !candidates.includes(first)) candidates.unshift(first)
  for (const idx of candidates.reverse()) {
    try {
      const parsed: unknown = JSON.parse(stdout.slice(idx))
      if (isListedReport(parsed)) return { report: parsed, start: idx }
    } catch {
      // config noise, keep walking backwards
    }
  }
  return null
}

/** normalized report error messages, capped */
function reportErrors(report: ListedReport): string[] {
  return (report.errors ?? [])
    .map((e) => (typeof e.message === 'string' ? e.message.trim() : ''))
    .filter((m) => m !== '')
    .slice(0, 10)
}

/**
 * A real JSON listing report with resolved root/project metadata proves that
 * Playwright finished loading the configuration. Errors in that report are
 * therefore test-suite/module evaluation failures, not config-load failures.
 */
function reportHasLoadedConfig(report: ListedReport): boolean {
  const rootDir = report.config?.rootDir
  const projects = report.config?.projects
  return (
    (typeof rootDir === 'string' && rootDir.trim() !== '') ||
    (Array.isArray(projects) && projects.length > 0)
  )
}

/** the "successful discovery, zero tests" signature (exit 1 in every known version) */
function isNoTestsReport(
  report: ListedReport,
  errors: string[],
  exitCode: number | null
): boolean {
  const suites = report.suites ?? []
  if (suites.length > 0) return false
  if (errors.length === 0) return exitCode === 0
  return (
    (exitCode === 0 || exitCode === 1) &&
    errors.every((message) => /^Error: No tests found/.test(message))
  )
}

/** heuristic: the failure text reads like a missing environment variable */
export function looksLikeMissingEnv(text: string): boolean {
  if (/process\.env/.test(text)) return true
  if (/environment (variable|value)/i.test(text)) return true
  if (/env(ironment)? (var|variable)/i.test(text)) return true
  return (
    /\b[A-Z][A-Z0-9_]{2,}\b/.test(text) &&
    /(required|not set|missing|must be set|undefined|not defined|provide)/i.test(text)
  )
}

/**
 * Narrow heuristic for a project-owned Playwright authentication/storage
 * state file that has not been created yet. Generic missing files deliberately
 * do not match — only explicit storage/auth-state language is setup-required.
 */
export function looksLikeMissingAuthState(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ')
  const stateFile = String.raw`(?:storage|auth(?:entication)?)\s+state(?:\s+file)?`
  const missing = String.raw`(?:does\s+not\s+exist|doesn't\s+exist|not\s+found|is\s+missing|ENOENT|no\s+such\s+file\s+or\s+directory)`
  return (
    new RegExp(`${stateFile}.{0,200}${missing}`, 'i').test(normalized) ||
    new RegExp(`(?:missing|cannot\s+find).{0,80}${stateFile}`, 'i').test(normalized)
  )
}

/** Replace exact env values before any child output crosses IPC into the UI. */
function redactEnvValues(text: string, env: Record<string, string>): string {
  const values = [...new Set(Object.values(env).filter((value) => value !== ''))].sort(
    (a, b) => b.length - a.length
  )
  let redacted = text
  for (const value of values) redacted = redacted.split(value).join('[redacted]')
  return redacted
}

/** first meaningful lines of a failed listing, with ANSI and env values removed */
function outputExcerpt(
  result: ExecResult,
  jsonStart: number,
  sensitiveEnv: Record<string, string>
): string | null {
  // eslint-disable-next-line no-control-regex -- ANSI escapes must not reach the UI
  const clean = (s: string): string => s.replace(/\[[0-9;]*m/g, '')
  const stdoutHead = jsonStart >= 0 ? result.stdout.slice(0, jsonStart) : result.stdout
  const combined = [clean(result.stderr), clean(stdoutHead)]
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n')
  if (combined === '') return null
  return redactEnvValues(combined, sensitiveEnv).slice(0, OUTPUT_EXCERPT_CAP)
}

/** the single line worth quoting: the actual Error: …, not a stack frame */
function meaningfulLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return (
    lines.find((l) => /\bError\b|error:/i.test(l) && !l.startsWith('at ')) ?? lines[0] ?? null
  )
}

// ---- tree building ----

interface CollectedDecl extends TestDecl {
  projectSet: Set<string>
}

/**
 * Collect unique source declarations. Handles both JSON shapes in the wild:
 * newer Playwright emits one spec with a tests[] entry per project, older
 * versions repeat the whole file suite once per project — dedup by
 * file:line:column:titlePath and merge the project lists.
 */
function collectDecls(suites: ListedSuite[]): Map<string, CollectedDecl> {
  const byKey = new Map<string, CollectedDecl>()
  const walk = (suite: ListedSuite, ancestors: string[], file: string | undefined): void => {
    const suiteFile = suite.file ?? file
    // file-level suites are titled with their own path; only real describe
    // titles join the title path
    const isFileSuite = suite.title === undefined || suite.title === '' || suite.title === suite.file
    const path = isFileSuite ? ancestors : [...ancestors, suite.title!]
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? suiteFile
      if (!specFile || spec.title === undefined) continue
      const normalizedFile = toPosixRelative(specFile)
      const titlePath = [...path, spec.title]
      const line = spec.line ?? 0
      const column = spec.column ?? 0
      const key = `${normalizedFile}:${line}:${column}:${titlePath.join('')}`
      let decl = byKey.get(key)
      if (!decl) {
        decl = {
          file: normalizedFile,
          line,
          column,
          title: spec.title,
          titlePath,
          projects: [],
          projectSet: new Set()
        }
        byKey.set(key, decl)
      }
      for (const test of spec.tests ?? []) {
        if (test.projectName !== undefined) decl.projectSet.add(test.projectName)
      }
    }
    for (const child of suite.suites ?? []) walk(child, path, suiteFile)
  }
  for (const suite of suites) walk(suite, [], undefined)
  for (const decl of byKey.values()) {
    decl.projects = [...decl.projectSet]
  }
  return byKey
}

/**
 * Base directory the report's spec paths are relative to: the report's
 * rootDir — the common ancestor of every project-level testDir, NOT any
 * single project's testDir (per-project testDir overrides would corrupt
 * every path outside the first project). Expressed relative to the WORKSPACE
 * root (absolute when outside it), because every consumer joins it there:
 * open-file resolution, codegen save, the watch dir, and single-test
 * locations for the current root-cwd runner. A future target-cwd runner can
 * re-derive its own relative form from this plus the target's cwd.
 */
function rootDirRelativeTo(report: ListedReport, baseAbs: string): string | null {
  const absolute = report.config?.rootDir ?? report.config?.projects?.[0]?.testDir
  if (!absolute) return null
  let rel = relative(baseAbs, absolute)
  if (rel.startsWith('..')) {
    // the report may carry the un-realpathed form of the same directory
    // (symlinked project roots) — compare like with like before giving up
    rel = relative(baseAbs, realPathOr(absolute))
  }
  if (rel === '') return '.'
  return rel.startsWith('..') ? toPosixAbsolute(absolute) : toPosixRelative(rel)
}

/** keep absolute paths readable on Windows without inventing separators */
function toPosixAbsolute(path: string): string {
  return path.replace(/\\/g, '/')
}

export interface TargetListResult {
  status: TargetDiscoveryStatus
  tree: TestTree | null
  diagnostic: TargetDiagnostic | null
  projectNames: string[] | null
  configuredProjectNames: string[] | null
  specFiles: number | null
  testCount: number | null
  rootDir: string | null
  playwrightVersion: string | null
  /** absolute paths for the file watcher's discovery surface */
  absoluteRootDir: string | null
  absoluteFiles: string[]
}

export interface ListTargetOptions {
  workspaceRoot: string
  target: Pick<
    HarnessTarget,
    'id' | 'cwd' | 'configPath' | 'packageDir' | 'launcher' | 'scriptEnv' | 'extraArgs'
  >
  /** env profile variables + shared run env (fixed-node PATH etc.) */
  profileEnv: Record<string, string>
  timeoutMs?: number
}

/** best-effort realpath: symlinked workspace paths (macOS /var → /private/var,
 *  user-level symlinks) must not diverge from Playwright's own realpathing,
 *  or the report's rootDir-relative files degrade into ../ chains */
function realPathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export async function listTarget(
  options: ListTargetOptions,
  exec: ExecFn = defaultExec
): Promise<TargetListResult> {
  const { workspaceRoot, target } = options
  const failure = (
    status: TargetDiscoveryStatus,
    summary: string,
    extras: Partial<TargetDiagnostic> = {}
  ): TargetListResult => ({
    status,
    tree: null,
    diagnostic: {
      status,
      summary,
      detail: null,
      exitCode: null,
      configPath: target.configPath,
      cwd: target.cwd,
      launcher: target.launcher,
      playwrightVersion: null,
      output: null,
      suggestion: null,
      ...extras
    },
    projectNames: null,
    configuredProjectNames: null,
    specFiles: null,
    testCount: null,
    rootDir: null,
    playwrightVersion: null,
    absoluteRootDir: null,
    absoluteFiles: []
  })

  const resolved = resolveTargetContext(workspaceRoot, target)
  if (!resolved.ok && resolved.code === 'outside-workspace') {
    return failure('unsupported-launcher', 'This target resolves outside the imported workspace', {
      suggestion: 'Import the containing folder or choose a config file inside this workspace.'
    })
  }
  if (!resolved.ok) {
    if (resolved.code === 'pnp') {
      return failure(
        'unsupported-launcher',
        'Yarn Plug’n’Play install layouts are not supported yet',
        {
          suggestion:
            'Install with the node-modules linker (nodeLinker: node-modules) so the local Playwright can be resolved.'
        }
      )
    }
    return failure('dependencies-missing', 'Playwright is not installed in this package', {
      suggestion: `Install dependencies first (${target.launcher} install) — Wrightbench never installs packages itself.`
    })
  }

  const {
    workspaceRoot: workspaceRootAbs,
    cwd: cwdAbs,
    configPath: configAbs,
    playwright: install
  } = resolved.context

  const { options: scriptOptions, customArgs: scriptCustomArgs } = splitTargetArgs(target.extraArgs)
  const args = [
    install.cliPath,
    'test',
    ...scriptOptions,
    '--list',
    '--reporter=json',
    ...(configAbs !== null ? [`--config=${configAbs}`] : []),
    ...scriptCustomArgs
  ]
  // script env first, then the profile: an explicitly selected Wrightbench
  // profile overrides a script default for the same variable
  const env = sanitizeCliProcessEnv({
    ...target.scriptEnv,
    ...options.profileEnv,
    FORCE_COLOR: '0'
  })
  const sensitiveEnv = { ...target.scriptEnv, ...options.profileEnv }

  const result = await exec({
    cmd: 'node',
    args,
    cwd: cwdAbs,
    env,
    timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS
  })

  const version = install.version
  const withVersion = (r: TargetListResult): TargetListResult => {
    if (r.diagnostic) r.diagnostic.playwrightVersion = version
    return { ...r, playwrightVersion: version }
  }

  if (result.spawnError !== null) {
    const nodeMissing = /ENOENT/i.test(result.spawnError)
    return withVersion(
      failure('list-failed', 'Playwright could not be started', {
        detail: result.spawnError.slice(0, DETAIL_CAP),
        suggestion: nodeMissing
          ? 'No usable Node runtime was found — set a fixed Node path in Settings.'
          : null
      })
    )
  }
  if (result.timedOut) {
    return withVersion(
      failure('timed-out', `Test listing timed out after ${Math.round((options.timeoutMs ?? LIST_TIMEOUT_MS) / 1000)}s`, {
        output: outputExcerpt(result, -1, sensitiveEnv)
      })
    )
  }
  if (result.stdoutTruncated) {
    return withVersion(
      failure('list-failed', 'Test listing produced more output than Wrightbench accepts', {
        exitCode: result.code
      })
    )
  }

  const parsed = parseListReport(result.stdout)
  const report = parsed?.report ?? null
  const jsonStart = parsed?.start ?? -1
  const errors = report !== null ? reportErrors(report) : []
  const noTests = report !== null && isNoTestsReport(report, errors, result.code)
  const failed = !noTests && (result.code !== 0 || errors.length > 0)
  if (report === null || failed) {
    // a parseable partial report from a failed command is still a failure —
    // classify it and preserve the useful error text
    const text = redactEnvValues(
      [...errors, outputExcerpt(result, jsonStart, sensitiveEnv) ?? '']
        .filter((s) => s !== '')
        .join('\n'),
      sensitiveEnv
    )
    const detailLine = meaningfulLine(text)
    if (looksLikeMissingAuthState(text)) {
      return withVersion(
        failure('setup-required', 'This configuration requires project authentication setup', {
          detail: detailLine?.slice(0, DETAIL_CAP) ?? null,
          exitCode: result.code,
          output: text.slice(0, OUTPUT_EXCERPT_CAP) || null,
          suggestion:
            'Complete the project’s documented setup or authentication step to create the required state file, then retry. Wrightbench will not run project setup or authentication commands automatically.'
        })
      )
    }
    // hard load-failure signatures outrank the env heuristic: a syntax error
    // on a line that happens to mention process.env is not an env problem
    const hardFailure =
      /SyntaxError|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|ReferenceError/.test(text)
    if (!hardFailure && looksLikeMissingEnv(text)) {
      return withVersion(
        failure('needs-context', 'This configuration needs environment variables to load', {
          detail: detailLine?.slice(0, DETAIL_CAP) ?? null,
          exitCode: result.code,
          output: text.slice(0, OUTPUT_EXCERPT_CAP) || null,
          suggestion:
            'Choose an environment profile that provides the missing variables, then retry.'
        })
      )
    }
    if (report !== null && reportHasLoadedConfig(report) && errors.length > 0) {
      const missingModule = /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(text)
      return withVersion(
        failure(
          'test-load-failed',
          'Playwright loaded the configuration but could not load its tests',
          {
            detail: detailLine?.slice(0, DETAIL_CAP) ?? null,
            exitCode: result.code,
            output: text.slice(0, OUTPUT_EXCERPT_CAP) || null,
            suggestion: missingModule
              ? 'Run the project’s documented build or setup step, then retry. Wrightbench will not run project setup commands automatically.'
              : 'Fix the reported test-module error, then retry.'
          }
        )
      )
    }
    if (/SyntaxError|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ReferenceError|TypeError|Error/i.test(text)) {
      return withVersion(
        failure('invalid-config', 'The Playwright configuration failed to load', {
          detail: detailLine?.slice(0, DETAIL_CAP) ?? null,
          exitCode: result.code,
          output: text.slice(0, OUTPUT_EXCERPT_CAP) || null
        })
      )
    }
    return withVersion(
      failure('list-failed', 'Playwright could not list tests', {
        detail: detailLine?.slice(0, DETAIL_CAP) ?? null,
        exitCode: result.code,
        output: text.slice(0, OUTPUT_EXCERPT_CAP) || null
      })
    )
  }

  const reportedRoot = report.config?.rootDir ?? report.config?.projects?.[0]?.testDir ?? null
  if (reportedRoot !== null && !pathIsWithin(workspaceRootAbs, realPathOr(reportedRoot))) {
    return withVersion(
      failure(
        'unsupported-launcher',
        'This configuration resolves tests outside the imported workspace',
        {
          suggestion: 'Import the containing workspace folder so Wrightbench can open and run these tests safely.'
        }
      )
    )
  }

  if (noTests && report !== null) {
    // A recognized Playwright JSON report with the exact no-tests signature.
    const configuredNames = configuredProjectNamesOf(report)
    const effectiveNames = effectiveProjectNamesForEmptyTarget(target.extraArgs, configuredNames)
    return withVersion({
      status: 'empty',
      tree: {
        targetId: target.id,
        files: [],
        projectNames: effectiveNames ?? [],
        rootDir: rootDirRelativeTo(report, workspaceRootAbs),
        totalTests: 0
      },
      diagnostic: null,
      projectNames: effectiveNames,
      configuredProjectNames: configuredNames,
      specFiles: 0,
      testCount: 0,
      rootDir: rootDirRelativeTo(report, workspaceRootAbs),
      playwrightVersion: version,
      absoluteRootDir: report.config?.rootDir ?? null,
      absoluteFiles: []
    })
  }

  // successful listing
  const decls = collectDecls(report.suites ?? [])
  const byFile = new Map<string, TestDecl[]>()
  const absoluteFiles: string[] = []
  const rootAbs = report.config?.rootDir ?? null
  for (const decl of decls.values()) {
    const { projectSet: _projectSet, ...clean } = decl
    const list = byFile.get(clean.file) ?? []
    list.push(clean)
    byFile.set(clean.file, list)
  }
  for (const file of byFile.keys()) {
    if (rootAbs !== null) absoluteFiles.push(join(rootAbs, ...file.split('/')))
  }
  const files = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, tests]) => ({
      file,
      tests: tests.sort((a, b) => a.line - b.line || a.column - b.column)
    }))

  const configuredNames = configuredProjectNamesOf(report)
  const names =
    decls.size === 0
      ? effectiveProjectNamesForEmptyTarget(target.extraArgs, configuredNames)
      : effectiveProjectNames(decls, configuredNames)
  const rootDir = rootDirRelativeTo(report, workspaceRootAbs)
  const tree: TestTree = {
    targetId: target.id,
    files,
    projectNames: names ?? [],
    rootDir,
    totalTests: decls.size
  }
  return {
    status: decls.size === 0 ? 'empty' : 'ready',
    tree,
    diagnostic: null,
    projectNames: names,
    configuredProjectNames: configuredNames,
    specFiles: files.length,
    testCount: decls.size,
    rootDir,
    playwrightVersion: version,
    absoluteRootDir: rootAbs,
    absoluteFiles
  }
}

function configuredProjectNamesOf(report: ListedReport): string[] | null {
  const names = (report.config?.projects ?? [])
    .map((p) => p.name)
    .filter((n): n is string => typeof n === 'string' && n !== '')
  return names.length > 0 ? names : null
}

/**
 * The JSON report keeps every configured project in config.projects even
 * when a fixed --project filter narrowed this target. The declaration rows
 * carry the projects that actually survived all target filters, so their
 * union is the truthful project set for this test inventory.
 */
function effectiveProjectNames(
  decls: Map<string, CollectedDecl>,
  configured: string[] | null
): string[] | null {
  const names = new Set<string>()
  for (const decl of decls.values()) {
    for (const name of decl.projects) names.add(name)
  }
  return names.size > 0 ? [...names] : configured
}

/**
 * An empty report has no declaration rows from which to derive effective
 * projects. Preserve fixed --project filters rather than falsely presenting
 * every project declared by the config as part of this recipe.
 */
function effectiveProjectNamesForEmptyTarget(
  args: string[],
  configured: string[] | null
): string[] | null {
  const filters: string[] = []
  const separator = args.indexOf('--')
  const options = separator === -1 ? args : args.slice(0, separator)
  for (let index = 0; index < options.length; index += 1) {
    const token = options[index]
    if (token === '--project' && options[index + 1] !== undefined) {
      filters.push(options[index + 1])
      index += 1
    } else if (token.startsWith('--project=')) {
      filters.push(token.slice('--project='.length))
    }
  }
  if (filters.length === 0) return configured
  if (configured === null) {
    const exact = filters.filter((filter) => !filter.includes('*'))
    return exact.length > 0 ? [...new Set(exact)] : []
  }
  const matches = (name: string, filter: string): boolean => {
    const pattern = filter
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${pattern}$`).test(name)
  }
  return configured.filter((name) => filters.some((filter) => matches(name, filter)))
}

/**
 * Typed IPC contract between main and renderer.
 * Every channel is declared here; both sides import from this file so the
 * names and payload types can never drift apart.
 */

import type { PlaywrightScaffoldSelection } from './playwright-compat'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  preference: ThemePreference
  resolved: ResolvedTheme
}

/** package-manager family that owns a harness target's package */
export type LauncherKind = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** how a harness target was established */
export type TargetSource = 'config' | 'script' | 'user'

/**
 * One concrete Playwright invocation context inside a Wrightbench workspace
 * (the persisted shape). A workspace (the folder the user imported — possibly
 * a repository or monorepo root) can hold several of these; each pairs a
 * working directory, a config, a package root with its locally installed
 * Playwright, and any launch context recovered from a safe package script.
 * Discovery and (future) execution must share this exact context.
 *
 * Not to be confused with Playwright *projects* (chromium/firefox/setup/…),
 * which live inside a config and are reported per target.
 */
export interface HarnessTarget {
  /** stable id, derived deterministically from the launch identity */
  id: string
  /** short display label, e.g. "packages/web/playwright.config.ts" */
  label: string
  /** working directory for Playwright invocations, workspace-relative POSIX ('.' = root) */
  cwd: string
  /** config file, workspace-relative POSIX; null = Playwright default resolution from cwd */
  configPath: string | null
  /** package root that owns the Playwright installation, workspace-relative POSIX */
  packageDir: string
  launcher: LauncherKind
  source: TargetSource
  /** package script this target was recovered from, when source === 'script' */
  scriptName: string | null
  /** inline env assignments recovered from a safe package script (repo content) */
  scriptEnv: Record<string, string>
  /** fixed `playwright test` CLI arguments recovered from a safe package script */
  extraArgs: string[]
  /** cached installed @playwright/test version at last validation */
  playwrightVersion: string | null
  /** cached last-known test count for switcher/summary display */
  testCount: number | null
}

/** outcome classification of one target discovery (list) attempt — derived, never persisted */
export type TargetDiscoveryStatus =
  | 'ready'
  | 'empty'
  | 'needs-context'
  /** project-owned setup/authentication state must be created manually */
  | 'setup-required'
  | 'dependencies-missing'
  | 'invalid-config'
  /** config loaded, but one or more test modules could not be evaluated */
  | 'test-load-failed'
  | 'list-failed'
  | 'timed-out'
  | 'unsupported-launcher'
  /** scanned but not (yet) validated by a listing */
  | 'not-validated'

/** structured, renderer-safe explanation of a non-ready discovery outcome */
export interface TargetDiagnostic {
  status: TargetDiscoveryStatus
  /** one-line user-facing summary */
  summary: string
  /** capped underlying cause (config/test-module error text, resolver detail) */
  detail: string | null
  exitCode: number | null
  /** workspace-relative config path involved, when known */
  configPath: string | null
  /** workspace-relative working directory of the attempt */
  cwd: string
  launcher: LauncherKind
  playwrightVersion: string | null
  /** capped stderr/stdout excerpt (never environment values) */
  output: string | null
  /** suggested recovery, e.g. "Install dependencies with npm install" */
  suggestion: string | null
}

/** persisted target + derived run capability, as sent to the renderer */
export interface TargetSummary {
  id: string
  label: string
  cwd: string
  configPath: string | null
  packageDir: string
  launcher: LauncherKind
  source: TargetSource
  scriptName: string | null
  playwrightVersion: string | null
  testCount: number | null
  /** whether the current runner can faithfully execute this target */
  runnable: boolean
  /** honest explanation when runnable is false */
  runnableReason: string | null
}

/** one discovered candidate with its validation outcome (import/rescan preview) */
export interface EnvironmentSetupHint {
  /** workspace-relative path to a conventional template; contents are never inspected */
  templatePath: string
  /** workspace-relative local file the user may create manually */
  destinationPath: string
}

export interface TargetCandidateInfo extends TargetSummary {
  status: TargetDiscoveryStatus
  diagnostic: TargetDiagnostic | null
  /** whether this installed Playwright version can feed UI Mode runs into Wrightbench history */
  recording: UiRecordingInfo
  /**
   * Known environment-template files beside this target's configuration or package,
   * expressed relative to the imported workspace. Discovery checks only the
   * fixed filenames; it never reads their contents or creates a local .env.
   */
  environmentSetupHints: EnvironmentSetupHint[]
  specFiles: number | null
  /** Playwright projects that remain after this target's fixed filters */
  projectNames: string[] | null
  /** every Playwright project declared by this target's config */
  configuredProjectNames: string[] | null
  /** report rootDir relative to the workspace root (display) */
  rootDir: string | null
}

/** registry view of one workspace's targets */
export interface TargetsState {
  targets: TargetSummary[]
  activeTargetId: string | null
}

/** A project confirmed into the workspace (the persisted projects.json shape). */
export interface ProjectInfo {
  id: string
  name: string
  path: string
  addedAt: string
  /** cached from detection for the status bar and sidebar counts */
  playwrightVersion?: string | null
  nodeVersion?: string | null
  testCount?: number | null
  /** discovered Playwright harness targets (absent on legacy entries) */
  targets?: HarnessTarget[]
  /** selected target; tests are listed for this target only */
  activeTargetId?: string | null
}

/**
 * Filesystem health of a registered project folder. Derived at read time in
 * the main process — never persisted; projects.json stays pure registry.
 */
export type ProjectHealthState = 'available' | 'missing' | 'unreadable'

export interface ProjectHealth {
  state: ProjectHealthState
  /** short user-facing reason for non-available states */
  reason: string | null
}

/** persisted record + derived runtime health, as sent to the renderer */
export interface ProjectWithHealth extends ProjectInfo {
  health: ProjectHealth
}

/**
 * Launch-critical facts for the import card. Import is deliberately passive:
 * it discovers safe local configuration contexts without executing a test
 * listing. Runtime/test/browser diagnostics belong to Playwright UI Mode or
 * the workspace test tree after the folder has been registered.
 */
export interface ProjectInspection {
  path: string
  name: string
  /** recommended target's config, workspace-relative (e.g. "packages/web/playwright.config.ts") */
  configFile: string | null
  /** locally installed project-owned Playwright version; null means dependencies are absent */
  playwrightVersion: string | null
  /** discovered base configurations only; run recipes are intentionally omitted */
  targets: TargetCandidateInfo[]
  /** candidate preselected for import (best valid one) */
  recommendedTargetId: string | null
}

export interface CommandResult {
  ok: boolean
  code: number | null
  error?: string
}

/** One declared test (one source declaration, aggregated across Playwright projects). */
export interface TestDecl {
  /**
   * Path relative to the report's resolved rootDir — the common ancestor of
   * every project-level testDir, NOT any single testDir. Always '/'-separated.
   */
  file: string
  line: number
  column: number
  /** leaf title (matches the run reporter's identity) */
  title: string
  /** nested describe titles + leaf title, file segment excluded */
  titlePath: string[]
  /** every Playwright project that contains this source declaration */
  projects: string[]
}

/**
 * Deterministic identity of one source declaration inside one harness target.
 * Live-run and history matching still use the legacy `file:line:title` key
 * (the reporter emits exactly that); this id exists so multi-target data can
 * never collide on it.
 */
export function declIdentity(
  targetId: string,
  decl: Pick<TestDecl, 'file' | 'line' | 'column' | 'titlePath'>
): string {
  return `${targetId}::${decl.file}:${decl.line}:${decl.column}::${decl.titlePath.join('\u001f')}`
}

export interface TestTreeFile {
  /** rootDir-relative spec path — nested directories stay distinguishable */
  file: string
  tests: TestDecl[]
}

export interface TestTree {
  /** harness target this listing belongs to */
  targetId: string
  files: TestTreeFile[]
  projectNames: string[]
  /**
   * Report rootDir relative to the WORKSPACE root ('.' when equal). Targets
   * whose tests resolve outside the imported workspace are reported as
   * unsupported, so joining workspaceRoot + rootDir + file is always bounded.
   */
  rootDir: string | null
  /** unique source declarations */
  totalTests: number
}

/** structured outcome of one target-aware test listing */
export interface TestListOutcome {
  status: TargetDiscoveryStatus
  /** present when status is 'ready' or 'empty' */
  tree: TestTree | null
  /** present when status is a failure (and for 'empty' when noteworthy) */
  diagnostic: TargetDiagnostic | null
  /** the target that was listed */
  target: TargetSummary
}

export type RunTrigger = 'manual' | 'watch' | 'rerun-failed'
export type CaptureMode = 'balanced' | 'full' | 'failures'

/**
 * Triggers persisted to run history. CLI runs use RunTrigger; runs initiated
 * inside embedded Playwright UI Mode are recorded as 'ui-mode'. ('ui-watch' is
 * reserved: the test-server protocol does not distinguish watch reruns, so we
 * deliberately record them as 'ui-mode' rather than guessing.)
 */
export type HistoryTrigger = RunTrigger | 'ui-mode'

export interface RunConfig {
  path: string
  /** exact persisted invocation context that produced the visible test tree */
  targetId: string
  /** one Playwright project name (projects may model browsers, devices, setup, or any suite) */
  project?: string | null
  /** --grep */
  grep?: string | null
  /** --workers */
  workers?: number | null
  /** named profile from settings; its env vars are applied to the process */
  envProfile?: string | null
  /** --last-failed */
  lastFailed?: boolean
  /** positional declaration filter, e.g. "tests/e2e/checkout.spec.ts:21:7" */
  location?: string | null
  /** what started this run (persisted to history) */
  trigger?: RunTrigger
}

/** identifies one scheduled test instance (per project) */
export interface TestRef {
  file: string
  line: number
  title: string
  project: string
  /** present in reporter protocol v2+; absent in legacy stored/wire events */
  column?: number
  /** nested describe titles + leaf title; absent in legacy stored/wire events */
  titlePath?: string[]
}

/** one concrete Playwright execution attempt (project + retry) */
export interface TestAttemptRef extends TestRef {
  /** reporter-stable within a run */
  attemptId: string
  retry: number
  workerIndex: number | null
  parallelIndex: number | null
}

/** file-backed artifact reported by Playwright for one test attempt */
export interface AttachmentRef {
  name: string
  contentType: string
  path: string
}

export type RunEvent =
  | { type: 'begin'; total: number; workers?: number; scheduled: TestRef[] }
  | ({ type: 'test-begin'; startedAt: number } & TestAttemptRef)
  | ({
      type: 'step-begin'
      stepId: string
      parentStepId: string | null
      stepTitle: string
      category: string
      startedAt: number
    } & TestAttemptRef)
  | ({ type: 'step-end'; stepId: string; duration: number; error?: string } & TestAttemptRef)
  | {
      type: 'stdio'
      stream: 'stdout' | 'stderr'
      text: string
      timestamp: number
      attemptId?: string
      file?: string
      line?: number
      column?: number
      title?: string
      titlePath?: string[]
      project?: string
    }
  | ({
      type: 'test-end'
      status: string
      outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped'
      duration: number
      finishedAt: number
      error?: string
      annotations?: { type: string; description: string | null }[]
      attachments?: AttachmentRef[]
    } & TestAttemptRef)
  | { type: 'end'; status: string }
  | { type: 'error'; message: string }
  /** emitted by the main process when the child exits */
  | { type: 'finished'; code: number | null; stderrTail?: string }

export interface RunEventPayload {
  runId: string
  /** persistent SQLite id; null only when history is unavailable */
  historyRunId: number | null
  runNumber: number
  path: string
  event: RunEvent
}

/** whether runs inside this UI Mode session are recorded to Wrightbench history */
export interface UiRecordingInfo {
  supported: boolean
  /** user-facing explanation when unsupported, e.g. unsupported Playwright version */
  reason: string | null
}

export interface UiModeStartConfig {
  path: string
  /** exact persisted active target; main resolves its cwd/config/install */
  targetId: string
  /** env profile applied to the test server's process environment at start */
  profile: string | null
}

export type UiModeLaunchMode = 'embedded' | 'external'

/** one live embedded UI Mode session (per project) */
export interface UiModeSessionInfo {
  sessionId: string
  /** requested active target (may be a run recipe) */
  targetId: string
  /** effective complete configuration used by Playwright UI Mode */
  configurationTargetId: string
  /** true when recipe CLI filters/argv were omitted for the native full configuration */
  recipeMappedToBase: boolean
  launchMode: 'embedded'
  /** direct uiMode.html?ws=… URL for the renderer's <webview> */
  url: string
  port: number
  profile: string | null
  playwrightVersion: string | null
  recording: UiRecordingInfo
}

/** public `playwright test --ui` fallback launched in the user's browser */
export interface UiModeExternalSessionInfo {
  sessionId: string
  targetId: string
  configurationTargetId: string
  recipeMappedToBase: boolean
  launchMode: 'external'
  profile: string | null
  playwrightVersion: string | null
  recording: UiRecordingInfo
}

export type UiModeState =
  | 'starting'
  | 'ready'
  | 'external'
  | 'restarting'
  | 'stopped'
  | 'crashed'

/** main → renderer lifecycle + history activity of the embedded UI Mode session */
export type UiModeEvent =
  | {
      type: 'state'
      sessionId: string | null
      targetId: string | null
      configurationTargetId: string | null
      recipeMappedToBase: boolean
      launchMode: UiModeLaunchMode | null
      state: UiModeState
      url: string | null
      port: number | null
      profile: string | null
      playwrightVersion: string | null
      recording: UiRecordingInfo
      /** crash/stop detail for the user, when there is one */
      message: string | null
    }
  | { type: 'run-begin'; sessionId: string; runNumber: number; total: number }
  | {
      type: 'run-progress'
      sessionId: string
      runNumber: number
      done: number
      total: number
      failed: number
    }
  | {
      type: 'run-end'
      sessionId: string
      runNumber: number
      status: string
      passed: number
      failed: number
      flaky: number
      skipped: number
      total: number
      durationMs: number
    }

export interface UiModeEventPayload {
  path: string
  event: UiModeEvent
}

/** named env-var set applied to spawned runs */
export interface EnvProfile {
  name: string
  env: Record<string, string>
  /** short muted annotation after the name, e.g. "read-only checks" */
  description?: string
}

/** sidebar test-tree status filter (single-select) */
export type TestStatusFilter = 'all' | 'passed' | 'failed' | 'flaky' | 'skipped' | 'not-run'

export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 380
export const SIDEBAR_DEFAULT_WIDTH = 262

/** persisted per-project sidebar view context, keyed by stable project id */
export interface ProjectViewContext {
  expandedFiles: string[]
  selectedKey: string | null
  query: string
  statusFilter: TestStatusFilter
  scrollTop: number
  /** env profile this project last used — projects need different environments */
  envProfile: string | null
}

/** persisted workspace chrome preferences (validated on load) */
export interface WorkspaceUiState {
  sidebarCollapsed: boolean
  /** clamped to SIDEBAR_MIN_WIDTH..SIDEBAR_MAX_WIDTH */
  sidebarWidth: number
  projectViews: Record<string, ProjectViewContext>
}

export type Density = 'relaxed' | 'compact'
/** bundled JetBrains Mono, or a system mono the user prefers */
export type CodeFontChoice = 'jetbrains-mono' | 'sf-mono' | 'menlo'
export type NodeMode = 'auto' | 'fixed'

/** everything settings.json persists (theme changes still go via theme:set) */
export interface WrightbenchSettings {
  theme: ThemePreference
  envProfiles: EnvProfile[]
  defaultProfile: string | null
  runRetentionDays: number
  traceRetentionDays: number
  /** Wrightbench diagnostic evidence policy for Tests-tab CLI runs */
  captureMode: CaptureMode
  /** automatic artifact budget; oldest evidence is pruned first */
  artifactBudgetGb: number
  density: Density
  codeFont: CodeFontChoice
  nodeMode: NodeMode
  /** absolute node binary path, used when nodeMode === 'fixed' */
  nodePath: string
  /** sidebar chrome + per-project view context (validated, safe defaults) */
  workspaceUi: WorkspaceUiState
}

export interface StorageStats {
  dbBytes: number
  /** stat-summed sizes of attachment files still on disk */
  artifactBytes: number
  artifactCount: number
  /** artifact bytes bucketed for the storage caption */
  traceBytes: number
  videoBytes: number
  otherBytes: number
  totalRuns: number
  oldestKeptAt: number | null
}

export interface NodeInfo {
  autoPath: string | null
  autoVersion: string | null
}

/** one captured codegen step, parsed from the generated test source */
export type CodegenActionKind =
  | 'goto'
  | 'click'
  | 'fill'
  | 'press'
  | 'check'
  | 'select'
  | 'assert'
  | 'other'

export interface CodegenAction {
  kind: CodegenActionKind
  /** locator/source part, e.g. `page.getByTestId('email')` or a URL */
  locator: string
  /** filled/pressed/selected value when the call carries one */
  value: string | null
}

/** Measured/fallback viewport represented in generated Record source. */
export interface CodegenViewport {
  width: number
  height: number
}

/** Target-aware launch request for Record's external browser + embedded Inspector. */
export interface CodegenStartConfig {
  path: string
  targetId: string
  url: string | null
  browser: 'chromium' | 'firefox' | 'webkit'
  viewport: CodegenViewport
}

/** Commands emitted by Playwright's unmodified Inspector frontend. */
export interface CodegenInspectorCommand {
  method:
    | 'clear'
    | 'fileChanged'
    | 'setAutoExpect'
    | 'setMode'
    | 'resume'
    | 'pause'
    | 'step'
    | 'highlightRequested'
    | 'wrightbenchReady'
  params?: unknown
}

/** Events consumed by Playwright's unmodified Inspector frontend. */
export interface CodegenInspectorEvent {
  method:
    | 'modeChanged'
    | 'sourcesUpdated'
    | 'pageNavigated'
    | 'pauseStateChanged'
    | 'callLogsUpdated'
    | 'sourceRevealRequested'
    | 'elementPicked'
  params: unknown
}

export type CodegenEvent =
  | {
      type: 'ready'
      /** Loopback page serving this project's exact recorder frontend assets. */
      inspectorUrl: string
      pageUrl: string
      browserVersion: string
      viewport: CodegenViewport
    }
  | { type: 'inspector'; event: CodegenInspectorEvent }
  | { type: 'update'; code: string; actions: CodegenAction[] }
  | { type: 'stopped'; code: string; actions: CodegenAction[] }
  | { type: 'error'; message: string }

export interface CodegenEventPayload {
  path: string
  event: CodegenEvent
}

export interface ReportInfo {
  exists: boolean
  generatedAt: number | null
}

/** one trace.zip in the library (from run history) */
export interface TraceLibEntry {
  runId: number
  runNumber: number
  startedAt: number
  status: string
  file: string
  line: number
  title: string
  path: string
  /** null when the file no longer exists on disk */
  sizeBytes: number | null
}

/** one persisted run (runs table) */
export interface RunRecord {
  id: number
  runNumber: number
  trigger: string
  commitHash: string | null
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  status: string
  passed: number
  failed: number
  flaky: number
  skipped: number
  total: number
}

/** one declaration contained in a project-level historical run */
export interface HistoryRunTest extends TestResultRef {
  status: Last20Cell['status']
  durationMs: number
  attemptCount: number
  artifactKinds: ArtifactKind[]
  projectStatuses: RunProjectStatus[]
  firstErrorLine: string | null
}

export type HistoryFilter = 'all' | 'cli' | 'ui-mode' | 'failed' | 'flaky' | 'watch'

/** Inclusive wall-clock boundaries for the project-level Reports calendar. */
export interface HistoryDateRange {
  from: number | null
  to: number | null
}

export interface PassRatePoint {
  runNumber: number
  /** null when the run executed nothing (all skipped) */
  rate: number | null
  failed: number
  flaky: number
}

export interface FlakyTestInfo {
  file: string
  line: number
  title: string
  /** chronological last-10 native Playwright outcomes (skips excluded) */
  outcomes: ('pass' | 'fail' | 'flaky')[]
  /** executions Playwright classified as flaky (failed, then passed on retry) */
  flakyRuns: number
  /** flakyRuns / outcomes.length */
  flakyPct: number
}

export interface DurationRegression {
  file: string
  line: number
  title: string
  beforeMs: number
  afterMs: number
}

export interface HistoryAnalytics {
  passRatePct: number | null
  /** same metric over the window before this one, for the tile delta */
  passRatePriorPct: number | null
  avgDurationMs: number | null
  avgDurationPriorMs: number | null
  flakyCount: number
  /** completed runs inside the active Reports calendar range */
  rangeRuns: number
  runsThisWeek: number
  weekManual: number
  weekWatch: number
  series: PassRatePoint[]
  flakiest: FlakyTestInfo[]
  regressions: DurationRegression[]
  totalRuns: number
  oldestKeptAt: number | null
  filterCounts: { all: number; failed: number; flaky: number; watch: number }
  retentionDays: number
}

/** identifies one persisted test result (no per-project split — worst outcome wins) */
export interface TestResultRef {
  file: string
  line: number
  title: string
}

/** newest completed SQLite result for one legacy persisted declaration identity */
export interface PersistedTestStatus extends TestResultRef {
  status: 'pass' | 'fail' | 'flaky' | 'skipped'
  durationMs: number
}

export interface Last20Cell {
  runId: number
  runNumber: number
  status: 'pass' | 'fail' | 'flaky' | 'skipped'
}

/** latest persisted result for the Tests-tab selected-test inspector */
export interface TestInspectorLatest {
  runId: number
  runNumber: number
  status: Last20Cell['status']
  durationMs: number
  startedAt: number
  finishedAt: number | null
  trigger: string
  commitHash: string | null
}

/** Wrightbench-owned history summary for one test declaration. */
export interface TestInspectorDetail {
  latest: TestInspectorLatest
  /** chronological outcomes, oldest to newest */
  last20: Last20Cell[]
  /** strict passes / executed outcomes (flaky is not counted as a pass) */
  passRatePct: number | null
  /** native Playwright-flaky outcomes / last ≤10 executed outcomes */
  flakyPct: number
  /** median duration over the last ≤20 executed outcomes */
  medianDurationMs: number | null
  /** newest failed/flaky result, even when the latest result passed */
  latestFailure: {
    runId: number
    runNumber: number
    status: 'fail' | 'flaky'
    error: string | null
  } | null
  /** newest first; selecting one loads its attempt-level detail */
  runs: TestRunSummary[]
}

/** final per-Playwright-project outcome inside one logical run */
export interface RunProjectStatus {
  project: string
  status: Last20Cell['status']
}

export interface TestRunSummary {
  runId: number
  runNumber: number
  status: Last20Cell['status']
  durationMs: number
  startedAt: number
  finishedAt: number | null
  trigger: string
  commitHash: string | null
  projectFilter: string
  attemptCount: number
  artifactKinds: ArtifactKind[]
  /** per-project rollup derived from attempts (empty when attempts weren't recorded) */
  projectStatuses: RunProjectStatus[]
  /** first non-empty stored error line for failed/flaky results, display-ready */
  firstErrorLine: string | null
}

export type ArtifactKind =
  | 'trace'
  | 'screenshot'
  | 'video'
  | 'diff'
  | 'report'
  | 'custom'

export interface PersistedArtifact {
  id: number
  attemptId: number | null
  name: string
  kind: ArtifactKind
  contentType: string
  path: string
  fileName: string
  sizeBytes: number | null
}

export interface PersistedStep {
  id: number
  externalId: string
  parentExternalId: string | null
  title: string
  category: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  error: string | null
}

export interface PersistedLog {
  id: number
  stream: 'stdout' | 'stderr'
  text: string
  timestamp: number
}

export interface PersistedAttempt {
  id: number
  externalId: string
  project: string
  retry: number
  workerIndex: number | null
  parallelIndex: number | null
  startedAt: number
  finishedAt: number | null
  status: string
  durationMs: number | null
  error: string | null
  annotations: { type: string; description: string | null }[]
  steps: PersistedStep[]
  logs: PersistedLog[]
  artifacts: PersistedArtifact[]
}

/** exact evidence for one declaration in one persisted run */
export interface TestRunDetail {
  run: RunRecord
  test: TestResultRef & { status: string; durationMs: number; error: string | null }
  captureMode: CaptureMode
  attempts: PersistedAttempt[]
  runArtifacts: PersistedArtifact[]
}

/** Renderer → main, request/response (ipcRenderer.invoke). */
export interface InvokeChannels {
  'theme:get': { args: []; result: ThemeState }
  'theme:set': { args: [ThemePreference]; result: ThemeState }
  'projects:list': { args: []; result: ProjectWithHealth[] }
  'projects:add': {
    args: [
      {
        name: string
        path: string
        playwrightVersion?: string | null
        nodeVersion?: string | null
        testCount?: number | null
        /** candidate chosen on the detection card; targets come from the main-process inspection cache */
        activeTargetId?: string | null
        /** dormant compatibility field; Wrightbench does not inject environment profiles */
        envProfile?: string | null
      }
    ]
    result: ProjectWithHealth[]
  }
  /** remove a registry entry by stable id — never touches project files or history */
  'projects:remove': { args: [string]; result: ProjectWithHealth[] }
  'dialog:pick-folder': { args: []; result: string | null }
  /** [path, envProfile] — passive, launch-context-only import inspection */
  'project:inspect': { args: [string, string | null]; result: ProjectInspection }
  /** persisted targets + active selection for a registered workspace */
  'project:targets': { args: [string]; result: TargetsState }
  'project:set-active-target': { args: [string, string]; result: TargetsState }
  /** [path, envProfile, validate] — re-scan candidates; validate=true also lists each */
  'project:rescan-targets': {
    args: [string, string | null, boolean]
    result: TargetsState & { candidates: TargetCandidateInfo[] }
  }
  /**
   * User-selected config fallback: open a file dialog, canonicalize the choice,
   * and (for registered workspaces) persist it as the active target.
   * For unregistered paths the candidate lands in the inspection cache so a
   * following projects:add persists it.
   */
  'project:pick-config-target': {
    args: [string, string | null]
    result: {
      cancelled: boolean
      error: string | null
      inspection: ProjectInspection | null
      targets: TargetsState | null
    }
  }
  /** open a source file (project-root-relative) with the OS default app */
  'project:open-file': { args: [string, string]; result: CommandResult }
  /** reveal a REGISTERED project folder in the OS file manager */
  'project:reveal': { args: [string]; result: boolean }
  'project:scaffold': { args: [string, PlaywrightScaffoldSelection]; result: CommandResult }
  /** [path, envProfile, targetId] — targetId null lists the active target */
  'project:test-tree': { args: [string, string | null, string | null]; result: TestListOutcome }
  'run:start': {
    args: [RunConfig]
    result: {
      runId: string
      historyRunId: number | null
      runNumber: number
      commitHash: string | null
    }
  }
  'run:stop': { args: [string]; result: boolean }
  'watch:start': { args: [string, string | null]; result: boolean }
  'watch:stop': { args: [string]; result: boolean }
  /** start (or join) the project's UI Mode session; recording capability included */
  'uimode:start': { args: [UiModeStartConfig]; result: UiModeSessionInfo }
  /** stop + start the current project-owned context; emits 'restarting' first */
  'uimode:restart': { args: [UiModeStartConfig]; result: UiModeSessionInfo }
  /** user-triggered public-CLI fallback; remains lifecycle-owned by Wrightbench */
  'uimode:open-external': {
    args: [UiModeStartConfig]
    result: UiModeExternalSessionInfo
  }
  'uimode:stop': { args: [string]; result: boolean }
  'history:runs': { args: [string, HistoryDateRange, number]; result: RunRecord[] }
  /** declarations and retained-evidence summary for one project-level run */
  'history:run-tests': { args: [string, number]; result: HistoryRunTest[] }
  'history:analytics': { args: [string, HistoryDateRange]; result: HistoryAnalytics }
  /** batch hydration for sidebar dots after reload/re-import */
  'history:latest-test-statuses': { args: [string]; result: PersistedTestStatus[] }
  /** general selected-test history */
  'history:test-inspector': {
    args: [string, TestResultRef]
    result: TestInspectorDetail | null
  }
  'history:test-run-detail': {
    args: [string, number, TestResultRef]
    result: TestRunDetail | null
  }
  /** reveal (trace.zip) or open (media) an attachment in the OS */
  'attachment:open': { args: [string]; result: boolean }
  /** serve one DB-owned immutable run artifact for an in-app preview */
  'attachment:serve': {
    args: [string, number, number]
    result: { url: string; contentType: string }
  }
  /** start a target-aware embedded Record session */
  'codegen:start': { args: [CodegenStartConfig]; result: boolean }
  /** forward one validated native-Inspector command to the isolated recorder session */
  'codegen:command': { args: [string, CodegenInspectorCommand]; result: boolean }
  /** stop the session; resolves with the final generated code */
  'codegen:stop': { args: [string]; result: string }
  'codegen:save': {
    args: [
      {
        path: string
        /** rootDir-relative destination spec, joined with rootDir below */
        file: string
        rootDir: string | null
        testName: string
        code: string
      }
    ]
    result: CommandResult
  }
  'report:start': { args: [string]; result: { port: number } }
  /** serve the immutable HTML report belonging to one recorded run */
  'report:serve-run': { args: [string, number]; result: { url: string } }
  'report:stop': { args: [string]; result: boolean }
  'report:info': { args: [string]; result: ReportInfo }
  /** open the served report in the default browser */
  'report:open-browser': { args: [string]; result: boolean }
  /** copy playwright-report/ to a user-picked folder */
  'report:export': { args: [string]; result: CommandResult }
  'traces:list': { args: [string]; result: TraceLibEntry[] }
  /** serve the trace viewer for one zip; resolves with the webview URL */
  'traces:serve': { args: [string, string]; result: { url: string } }
  'traces:stop': { args: [string]; result: boolean }
  'dialog:pick-trace': { args: []; result: string | null }
  'settings:get': { args: []; result: WrightbenchSettings }
  /** partial update; theme is ignored here (theme:set owns it) */
  'settings:update': { args: [Partial<WrightbenchSettings>]; result: WrightbenchSettings }
  'settings:storage': { args: []; result: StorageStats }
  /** prune history older than runRetentionDays; never touches repo files */
  'settings:clear-artifacts': {
    args: []
    result: { removedRuns: number; removedArtifacts: number; freedBytes: number }
  }
  'settings:node-info': { args: []; result: NodeInfo }
}

/** One streamed output line from a long-running project command. */
export interface ProjectProgress {
  kind: 'scaffold'
  path: string
  line: string
}

/** Main → renderer, push events (webContents.send). */
export interface EventChannels {
  'theme:changed': ThemeState
  'project:progress': ProjectProgress
  'run:event': RunEventPayload
  'uimode:event': UiModeEventPayload
  'watch:changed': { path: string; file: string }
  /** registry or filesystem-health change (add, remove, folder gone/back) */
  'projects:changed': ProjectWithHealth[]
  /** debounced: test/config files of a registered project changed on disk */
  'project:files-changed': { path: string; discovery: boolean }
  'codegen:event': CodegenEventPayload
  'settings:changed': WrightbenchSettings
}

export type InvokeChannel = keyof InvokeChannels
export type EventChannel = keyof EventChannels

/** The API surface exposed on `window.wrightbench` by the preload script. */
export interface WrightbenchApi {
  theme: {
    get(): Promise<ThemeState>
    set(preference: ThemePreference): Promise<ThemeState>
    onChanged(listener: (state: ThemeState) => void): () => void
  }
  projects: {
    list(): Promise<ProjectWithHealth[]>
    add(project: {
      name: string
      path: string
      playwrightVersion?: string | null
      nodeVersion?: string | null
      testCount?: number | null
      activeTargetId?: string | null
      envProfile?: string | null
    }): Promise<ProjectWithHealth[]>
    remove(id: string): Promise<ProjectWithHealth[]>
    onChanged(listener: (projects: ProjectWithHealth[]) => void): () => void
    onFilesChanged(listener: (change: { path: string; discovery: boolean }) => void): () => void
  }
  project: {
    pickFolder(): Promise<string | null>
    inspect(path: string, envProfile: string | null): Promise<ProjectInspection>
    scaffold(path: string, version: PlaywrightScaffoldSelection): Promise<CommandResult>
    onProgress(listener: (progress: ProjectProgress) => void): () => void
    /** envProfile: session profile whose vars the listing runs with (configs may require them) */
    testTree(
      path: string,
      envProfile: string | null,
      targetId: string | null
    ): Promise<TestListOutcome>
    targets(path: string): Promise<TargetsState>
    setActiveTarget(path: string, targetId: string): Promise<TargetsState>
    rescanTargets(
      path: string,
      envProfile: string | null,
      validate: boolean
    ): Promise<TargetsState & { candidates: TargetCandidateInfo[] }>
    pickConfigTarget(
      path: string,
      envProfile: string | null
    ): Promise<{
      cancelled: boolean
      error: string | null
      inspection: ProjectInspection | null
      targets: TargetsState | null
    }>
    openFile(path: string, relativeFile: string): Promise<CommandResult>
    reveal(path: string): Promise<boolean>
  }
  run: {
    start(config: RunConfig): Promise<{
      runId: string
      historyRunId: number | null
      runNumber: number
      commitHash: string | null
    }>
    stop(runId: string): Promise<boolean>
    onEvent(listener: (payload: RunEventPayload) => void): () => void
  }
  watch: {
    start(path: string, rootDir: string | null): Promise<boolean>
    stop(path: string): Promise<boolean>
    onChanged(listener: (change: { path: string; file: string }) => void): () => void
  }
  uimode: {
    start(config: UiModeStartConfig): Promise<UiModeSessionInfo>
    restart(config: UiModeStartConfig): Promise<UiModeSessionInfo>
    openExternal(config: UiModeStartConfig): Promise<UiModeExternalSessionInfo>
    stop(path: string): Promise<boolean>
    onEvent(listener: (payload: UiModeEventPayload) => void): () => void
  }
  settings: {
    get(): Promise<WrightbenchSettings>
    update(patch: Partial<WrightbenchSettings>): Promise<WrightbenchSettings>
    storage(): Promise<StorageStats>
    clearArtifacts(): Promise<{ removedRuns: number; removedArtifacts: number; freedBytes: number }>
    nodeInfo(): Promise<NodeInfo>
    onChanged(listener: (settings: WrightbenchSettings) => void): () => void
  }
  codegen: {
    start(config: CodegenStartConfig): Promise<boolean>
    command(path: string, command: CodegenInspectorCommand): Promise<boolean>
    stop(path: string): Promise<string>
    save(input: {
      path: string
      file: string
      rootDir: string | null
      testName: string
      code: string
    }): Promise<CommandResult>
    onEvent(listener: (payload: CodegenEventPayload) => void): () => void
  }
  report: {
    start(path: string): Promise<{ port: number }>
    serveRun(path: string, runId: number): Promise<{ url: string }>
    stop(path: string): Promise<boolean>
    info(path: string): Promise<ReportInfo>
    openBrowser(path: string): Promise<boolean>
    export(path: string): Promise<CommandResult>
  }
  traces: {
    list(path: string): Promise<TraceLibEntry[]>
    serve(path: string, zipPath: string): Promise<{ url: string }>
    stop(path: string): Promise<boolean>
    pickFile(): Promise<string | null>
  }
  history: {
    runs(path: string, range: HistoryDateRange, limit: number): Promise<RunRecord[]>
    runTests(path: string, runId: number): Promise<HistoryRunTest[]>
    analytics(path: string, range: HistoryDateRange): Promise<HistoryAnalytics>
    latestTestStatuses(path: string): Promise<PersistedTestStatus[]>
    testInspector(path: string, ref: TestResultRef): Promise<TestInspectorDetail | null>
    testRunDetail(path: string, runId: number, ref: TestResultRef): Promise<TestRunDetail | null>
  }
  attachments: {
    open(path: string): Promise<boolean>
    serve(
      projectPath: string,
      runId: number,
      artifactId: number
    ): Promise<{ url: string; contentType: string }>
  }
  /** Resolve the filesystem path of a File dropped onto the window. */
  getPathForFile(file: File): string
}

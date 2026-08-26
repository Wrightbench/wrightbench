import { create } from 'zustand'
import { useCodegen } from './codegen'
import { useHistory } from './history'
import { uiModeBlocksOtherWork, useUiMode } from './uimode'
import {
  declIdentity,
  type TestDecl,
  type TestRef,
  type AttachmentRef,
  type RunEvent,
  type RunTrigger,
  type PersistedTestStatus,
  type TargetDiagnostic,
  type TargetSummary,
  type TestAttemptRef,
  type TestTree
} from '@shared/ipc'

export function legacyTestKey(ref: { file: string; line: number; title: string }): string {
  return `${ref.file}:${ref.line}:${ref.title}`
}

/**
 * Source-declaration identity for listed tests and reporter protocol v2.
 * Legacy reporter/history refs lack column/titlePath and deliberately fall
 * back to the old key until their storage schema is migrated.
 */
export function testKey(
  ref: Pick<TestDecl, 'file' | 'line' | 'column' | 'titlePath' | 'title'> | TestRef,
  targetId?: string | null
): string {
  if (
    targetId &&
    typeof ref.column === 'number' &&
    Array.isArray(ref.titlePath) &&
    ref.titlePath.length > 0
  ) {
    return declIdentity(targetId, {
      file: ref.file,
      line: ref.line,
      column: ref.column,
      titlePath: ref.titlePath
    })
  }
  return legacyTestKey(ref)
}

export type TestStatus = 'pass' | 'fail' | 'flaky' | 'skipped' | 'running' | 'queued' | 'none'

type Outcome = 'expected' | 'unexpected' | 'flaky' | 'skipped'

const OUTCOME_RANK: Record<Outcome, number> = {
  unexpected: 3,
  flaky: 2,
  expected: 1,
  skipped: 0
}

interface InstanceResult {
  outcome: Outcome
  duration: number
  error: string | null
}

interface DeclRunState {
  scheduled: number
  /** instances currently executing (begin events minus end events) */
  active: number
  /** latest result per Playwright project — a retry REPLACES, never merges */
  perProject: Record<string, InstanceResult>
  startedAt: number | null
}

function declWorst(decl: DeclRunState): Outcome | null {
  let worst: Outcome | null = null
  for (const result of Object.values(decl.perProject)) {
    if (worst === null || OUTCOME_RANK[result.outcome] > OUTCOME_RANK[worst]) {
      worst = result.outcome
    }
  }
  return worst
}

function declDuration(decl: DeclRunState): number {
  let max = 0
  for (const result of Object.values(decl.perProject)) max = Math.max(max, result.duration)
  return max
}

export interface FinalStatus {
  status: Exclude<TestStatus, 'running' | 'queued' | 'none'>
  duration: number
}

/**
 * Restore retained outcomes only when the legacy SQLite identity resolves to
 * exactly one current precise declaration. Body-only edits keep the latest
 * recorded result; a rename/move/line change becomes not-run until rerun.
 */
function statusesForTree(
  tree: TestTree,
  persisted: PersistedTestStatus[] | null,
  current: Record<string, FinalStatus>
): Record<string, FinalStatus> {
  const declarationsByLegacy = new Map<string, TestDecl[]>()
  const validKeys = new Set<string>()
  for (const file of tree.files) {
    for (const test of file.tests) {
      const precise = testKey(test, tree.targetId)
      const legacy = legacyTestKey(test)
      validKeys.add(precise)
      const declarations = declarationsByLegacy.get(legacy) ?? []
      declarations.push(test)
      declarationsByLegacy.set(legacy, declarations)
    }
  }

  const statuses = Object.fromEntries(
    Object.entries(current).filter(([key]) => validKeys.has(key))
  )
  if (persisted === null) return statuses

  for (const result of persisted) {
    const declarations = declarationsByLegacy.get(legacyTestKey(result))
    if (declarations?.length !== 1) continue
    statuses[testKey(declarations[0], tree.targetId)] = {
      status: result.status,
      duration: result.durationMs
    }
  }
  return statuses
}

export interface LastRunInfo {
  historyRunId: number | null
  number: number
  finishedAt: number
  durationMs: number
  passed: number
  failed: number
  flaky: number
  interrupted: boolean
}

export interface LiveStep {
  id: string
  parentId: string | null
  title: string
  category: string
  startedAt: number
  durationMs: number | null
  error: string | null
}

export interface LiveLog {
  stream: 'stdout' | 'stderr'
  text: string
  timestamp: number
}

export interface LiveAttempt extends TestAttemptRef {
  startedAt: number
  finishedAt: number | null
  status: string
  durationMs: number | null
  error: string | null
  steps: LiveStep[]
  logs: LiveLog[]
  attachments: AttachmentRef[]
}

/**
 * A listing failure arrives wrapped by Electron ("Error invoking remote
 * method 'project:test-tree': Error: could not list tests — …"). Keep only
 * the meaningful cause so screens can show WHY listing failed (missing deps
 * vs a config that crashed on load) without the transport noise.
 */
/**
 * The line worth showing from a dead run's stderr: the actual "Error: …"
 * message, not whatever stack frame happened to be flushed last.
 */
function meaningfulStderrLine(stderrTail: string | undefined): string | null {
  const lines = (stderrTail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return lines.find((l) => /\bError\b|error:/i.test(l) && !l.startsWith('at ')) ?? lines[0] ?? null
}

function listingErrorDetail(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err)
  const detail = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  if (detail === '') return null
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail
}

interface RunStore {
  /** project path this session state belongs to */
  path: string | null
  tree: TestTree | null
  treeError: string | null
  /** underlying cause of the last listing failure (IPC wrapper stripped) */
  treeErrorDetail: string | null
  /** structured outcome of the last listing attempt, when it failed */
  treeDiagnostic: TargetDiagnostic | null
  treeLoading: boolean
  expandedFiles: Record<string, boolean>
  selectedKey: string | null
  /** one-shot navigation from a failure entry point into an exact Trace tab */
  traceIntent: { id: number; key: string; runId: number | null } | null

  /** harness targets of the active workspace; tests list for the active one */
  targets: TargetSummary[]
  activeTargetId: string | null

  project: string | null
  grep: string
  workers: string

  running: boolean
  runId: string | null
  historyRunId: number | null
  /** authoritative persisted number; 0 while unknown (render a placeholder) */
  runNumber: number
  runCommit: string | null
  runTrigger: RunTrigger
  decls: Record<string, DeclRunState>
  attempts: Record<string, LiveAttempt>
  /** latest recorded outcome per test, hydrated from SQLite and updated live */
  statuses: Record<string, FinalStatus>
  instanceTotal: number
  instanceDone: number
  workersBusy: number | null
  startedAt: number | null
  lastRun: LastRunInfo | null
  runError: string | null

  watch: boolean

  /** available=false (folder missing/unreadable) switches state but skips listing */
  initWorkspace(path: string, available?: boolean, projectId?: string | null): Promise<void>
  /** preserveView keeps expanded rows/selection that still exist (fs refresh) */
  loadTree(preserveView?: boolean): Promise<void>
  /** re-read retained outcomes without relisting Playwright tests */
  refreshPersistedStatuses(): Promise<void>
  /** switch the active harness target: persists, clears run state, reloads */
  setActiveTarget(targetId: string): Promise<void>
  /** re-read the registry's target list (after a rescan or files change) */
  refreshTargets(rescan?: boolean): Promise<void>
  /** user-selected config fallback: pick a file, activate it, list it */
  pickConfigTarget(): Promise<void>
  /** removing the final project: stop sessions + clear state with no next path */
  teardownWorkspace(): void
  /** active folder became missing/unreadable: drop the stale tree + statuses,
   *  stop repository-dependent sessions — history stays untouched */
  handleActiveUnavailable(): void
  startRun(options?: {
    lastFailed?: boolean
    trigger?: RunTrigger
    /** run a single declaration, e.g. "tests/e2e/checkout.spec.ts:21:7" */
    location?: string
    /** escaped full-title suffix paired with location for same-line declarations */
    grep?: string
  }): Promise<void>
  stopRun(): Promise<void>
  toggleWatch(): Promise<void>
  select(key: string | null): void
  openTrace(key: string, runId: number | null): void
  consumeTraceIntent(id: number): void
  toggleFile(file: string): void
  /** replace spec disclosure in one update (folder-view Expand/Collapse all) */
  setExpandedFiles(files: readonly string[]): void
  setProject(project: string): void
  setGrep(grep: string): void
  setWorkers(workers: string): void
}

function api(): NonNullable<typeof window.wrightbench> | null {
  return window.wrightbench ?? null
}

function outcomeToStatus(outcome: Outcome): FinalStatus['status'] {
  if (outcome === 'unexpected') return 'fail'
  if (outcome === 'flaky') return 'flaky'
  if (outcome === 'skipped') return 'skipped'
  return 'pass'
}

/** live status of one declaration during/after a run */
export function declStatus(decl: DeclRunState | undefined): TestStatus {
  if (!decl) return 'none'
  if (decl.active > 0) return 'running'
  const done = Object.keys(decl.perProject).length
  if (done === 0) return 'queued'
  if (done < decl.scheduled) return 'queued'
  return outcomeToStatus(declWorst(decl) ?? 'expected')
}

function emptyAttempt(ref: TestAttemptRef, startedAt: number): LiveAttempt {
  return {
    ...ref,
    startedAt,
    finishedAt: null,
    status: 'running',
    durationMs: null,
    error: null,
    steps: [],
    logs: [],
    attachments: []
  }
}

export const useRun = create<RunStore>((set, get) => {
  let wasInterrupted = false
  let sawBegin = false
  let stopRequested = false
  /** discards responses from superseded tree loads (switches, teardown) */
  let treeLoadSeq = 0
  /** fs change arrived while a run/recording owned the project */
  let pendingTreeRefresh = false
  /** a target-affecting fs change must rescan before its tree refresh */
  let pendingTargetRefresh = false
  /** one ordered fs refresh pipeline at a time */
  let fileRefreshInFlight = false
  /** invalidates an old project's deferred refresh after a workspace switch */
  let workspaceRefreshSeq = 0
  /** concurrent callers for one workspace await the same scan-only rescan */
  const rescansInFlight = new Map<string, Promise<void>>()
  let traceIntentSequence = 0

  const refreshBusy = (): boolean =>
    get().running || uiModeBlocksOtherWork(useUiMode.getState()) || useCodegen.getState().recording

  /**
   * Protocol v2 carries exact source identity. For a legacy reporter, upgrade
   * the old file:line:title key only when it resolves to one listed
   * declaration; ambiguous legacy events stay detached instead of painting
   * multiple rows with the same status.
   */
  const reporterKey = (ref: TestRef): string => {
    const state = get()
    const targetId = state.tree?.targetId ?? state.activeTargetId
    const precise = testKey(ref, targetId)
    const legacy = legacyTestKey(ref)
    if (precise !== legacy || !state.tree || !targetId) return precise
    const matches = state.tree.files.flatMap((file) =>
      file.tests.filter((test) => legacyTestKey(test) === legacy)
    )
    return matches.length === 1 ? testKey(matches[0], targetId) : legacy
  }

  const consumePendingRefresh = (): void => {
    if (
      fileRefreshInFlight ||
      refreshBusy() ||
      (!pendingTreeRefresh && !pendingTargetRefresh)
    ) {
      return
    }
    const path = get().path
    if (!path) {
      pendingTreeRefresh = false
      pendingTargetRefresh = false
      return
    }
    const refreshSeq = workspaceRefreshSeq
    fileRefreshInFlight = true
    void (async () => {
      try {
        // Batch synchronous observer notifications (one save can touch both a
        // config and package.json) into the same ordered pass.
        await Promise.resolve()
        let shouldLoadTree = pendingTreeRefresh || pendingTargetRefresh
        pendingTreeRefresh = false
        // A discovery notification that arrives while a scan is running needs
        // one subsequent scan, but all tree notifications received before the
        // final scan finishes are satisfied by the single listing below.
        while (pendingTargetRefresh) {
          pendingTargetRefresh = false
          await get().refreshTargets(true)
          shouldLoadTree = true
          if (get().path !== path || workspaceRefreshSeq !== refreshSeq) return
          pendingTreeRefresh = false
          if (refreshBusy()) {
            pendingTreeRefresh = true
            return
          }
        }
        if (get().path !== path || workspaceRefreshSeq !== refreshSeq) return
        shouldLoadTree ||= pendingTreeRefresh
        pendingTreeRefresh = false
        // A run/recording can start while the scan is in flight. Target state
        // is already current; defer only the listing until it is idle.
        if (refreshBusy()) {
          pendingTreeRefresh = true
          return
        }
        if (shouldLoadTree) await get().loadTree(true)
      } finally {
        fileRefreshInFlight = false
        // Changes that landed during the rescan/listing get one subsequent
        // ordered pass instead of racing the pass already in progress.
        consumePendingRefresh()
      }
    })()
  }

  /** everything a project owns in the main process stops when it is left */
  const stopProjectSessions = (previous: string): void => {
    const wb = api()
    if (!wb) return
    const { running, runId } = get()
    // never orphan a live run in the main process
    if (running && runId) void wb.run.stop(runId)
    if (get().watch) void wb.watch.stop(previous)
    // phase-5 per-project servers and sessions follow the same rule
    void wb.report.stop(previous)
    void wb.traces.stop(previous)
    void wb.codegen.stop(previous)
    useHistory.getState().reset()
  }

  if (window.wrightbench) {
    const unsubRun = window.wrightbench.run.onEvent(
      ({ runId, historyRunId, runNumber, path, event }) => {
      const state = get()
      if (path !== state.path || !state.running) return
      // events can outrace the run:start invoke response — adopt the runId
      // from the first event of the run we just started
      if (state.runId !== null && runId !== state.runId) return
      if (state.runId === null) {
        set({ runId, historyRunId, runNumber })
        if (stopRequested) void window.wrightbench?.run.stop(runId)
      }
      applyEvent(event)
      }
    )
    const unsubWatch = window.wrightbench.watch.onChanged(({ path }) => {
      const state = get()
      if (state.watch && !state.running && path === state.path) {
        void state.startRun({ trigger: 'watch' })
      }
    })
    // registry observation: test/config files changed on disk (already
    // debounced in main). Never disrupt live work — refresh when idle.
    // discovery=true (package.json/lockfile/config changes) also re-evaluates
    // the candidate targets with a cheap scan-only pass.
    const unsubFiles = window.wrightbench.projects.onFilesChanged(({ path, discovery }) => {
      if (path !== get().path) return
      pendingTreeRefresh = true
      if (discovery) pendingTargetRefresh = true
      consumePendingRefresh()
    })
    // a deferred refresh runs once the owning operation ends
    const unsubUiIdle = useUiMode.subscribe((state, previous) => {
      const wasBlocking = uiModeBlocksOtherWork(previous)
      const isBlocking = uiModeBlocksOtherWork(state)
      if (wasBlocking && !isBlocking) consumePendingRefresh()
    })
    const unsubCodegenIdle = useCodegen.subscribe((state, previous) => {
      if (previous.recording && !state.recording) consumePendingRefresh()
    })
    import.meta.hot?.dispose(() => {
      unsubRun()
      unsubWatch()
      unsubFiles()
      unsubUiIdle()
      unsubCodegenIdle()
    })
  }

  function applyEvent(event: RunEvent): void {
    if (event.type === 'begin') {
      wasInterrupted = false
      sawBegin = true
      const decls: Record<string, DeclRunState> = {}
      for (const ref of event.scheduled) {
        const key = reporterKey(ref)
        const decl = (decls[key] ??= {
          scheduled: 0,
          active: 0,
          perProject: {},
          startedAt: null
        })
        decl.scheduled += 1
      }
      set({
        decls,
        attempts: {},
        instanceTotal: event.total,
        instanceDone: 0,
        workersBusy: event.workers ?? null
      })
      return
    }
    if (event.type === 'step-begin') {
      const attempts = { ...get().attempts }
      const current = attempts[event.attemptId] ?? emptyAttempt(event, event.startedAt)
      attempts[event.attemptId] = {
        ...current,
        steps: [
          ...current.steps.filter((step) => step.id !== event.stepId),
          {
            id: event.stepId,
            parentId: event.parentStepId,
            title: event.stepTitle,
            category: event.category,
            startedAt: event.startedAt,
            durationMs: null,
            error: null
          }
        ]
      }
      set({ attempts })
      return
    }
    if (event.type === 'step-end') {
      const attempts = { ...get().attempts }
      const current = attempts[event.attemptId] ?? emptyAttempt(event, Date.now())
      attempts[event.attemptId] = {
        ...current,
        steps: current.steps.map((step) =>
          step.id === event.stepId
            ? { ...step, durationMs: event.duration, error: event.error ?? null }
            : step
        )
      }
      set({ attempts })
      return
    }
    if (event.type === 'stdio') {
      if (!event.attemptId) return
      const attempts = { ...get().attempts }
      const current = attempts[event.attemptId]
      if (!current) return
      attempts[event.attemptId] = {
        ...current,
        logs: [
          ...current.logs,
          { stream: event.stream, text: event.text, timestamp: event.timestamp }
        ]
      }
      set({ attempts })
      return
    }
    if (event.type === 'test-begin' || event.type === 'test-end') {
      const key = reporterKey(event)
      const decls = { ...get().decls }
      const previous = decls[key] ?? {
        scheduled: 1,
        active: 0,
        perProject: {},
        startedAt: null
      }
      const decl = { ...previous, perProject: { ...previous.perProject } }
      let doneDelta = 0
      if (event.type === 'test-begin') {
        decl.active += 1
        decl.startedAt ??= event.startedAt
        const attempts = { ...get().attempts }
        attempts[event.attemptId] = emptyAttempt(event, event.startedAt)
        set({ attempts })
      } else {
        decl.active = Math.max(0, decl.active - 1)
        // an interrupted instance never finished — keep its previous status
        if (event.status !== 'interrupted') {
          // a retry replaces the project's earlier result; progress counts
          // each (test, project) instance once
          if (!(event.project in decl.perProject)) doneDelta = 1
          decl.perProject[event.project] = {
            outcome: event.outcome,
            duration: event.duration,
            error: event.error ?? null
          }
        }
        const attempts = { ...get().attempts }
        const current =
          attempts[event.attemptId] ??
          emptyAttempt(event, Math.max(0, event.finishedAt - event.duration))
        attempts[event.attemptId] = {
          ...current,
          finishedAt: event.finishedAt,
          status: event.status,
          durationMs: event.duration,
          error: event.error ?? null,
          attachments: event.attachments ?? []
        }
        set({ attempts })
      }
      decls[key] = decl
      set({ decls, instanceDone: get().instanceDone + doneDelta })
      return
    }
    if (event.type === 'error') {
      set({ runError: event.message })
      return
    }
    if (event.type === 'end') {
      if (event.status === 'interrupted') wasInterrupted = true
      return
    }
    if (event.type === 'finished') {
      finishRun(event.code, event.stderrTail)
    }
  }

  function finishRun(code: number | null, stderrTail?: string): void {
    const state = get()
    const statuses = { ...state.statuses }
    let passed = 0
    let failed = 0
    let flaky = 0
    let interrupted = wasInterrupted
    for (const [key, decl] of Object.entries(state.decls)) {
      const done = Object.keys(decl.perProject).length
      if (done === 0) {
        interrupted = true
        continue // never ran — keep the previous known status
      }
      const status = outcomeToStatus(declWorst(decl) ?? 'expected')
      statuses[key] = { status, duration: declDuration(decl) }
      if (status === 'pass') passed += 1
      else if (status === 'fail') failed += 1
      else if (status === 'flaky') flaky += 1
      if (done < decl.scheduled) interrupted = true
    }
    set({
      running: false,
      runId: null,
      decls: {},
      statuses,
      workersBusy: null,
      lastRun: {
        historyRunId: state.historyRunId,
        number: state.runNumber,
        finishedAt: Date.now(),
        durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
        passed,
        failed,
        flaky,
        interrupted
      },
      startedAt: null,
      runError:
        state.runError ??
        (passed + failed + flaky === 0 && !interrupted && (code ?? 1) !== 0
          ? (meaningfulStderrLine(stderrTail) ??
            (sawBegin
              ? `playwright exited with code ${code ?? '?'}`
              : `playwright exited with code ${code ?? '?'} — no tests ran`))
          : null)
    })
    // fs changes held back during the run land now
    consumePendingRefresh()
  }

  return {
    path: null,
    tree: null,
    treeError: null,
    treeErrorDetail: null,
    treeDiagnostic: null,
    treeLoading: false,
    expandedFiles: {},
    selectedKey: null,
    traceIntent: null,

    targets: [],
    activeTargetId: null,

    project: null,
    grep: '',
    workers: 'auto',

    running: false,
    runId: null,
    historyRunId: null,
    runNumber: 0,
    runCommit: null,
    runTrigger: 'manual',
    decls: {},
    attempts: {},
    statuses: {},
    instanceTotal: 0,
    instanceDone: 0,
    workersBusy: null,
    startedAt: null,
    lastRun: null,
    runError: null,

    watch: false,

    async initWorkspace(path, available = true, _projectId = null) {
      const wb = api()
      if (!wb) return
      const previous = get().path
      if (previous === path) {
        // same-project remount (e.g. Settings round-trip): never reset live
        // run/codegen state — the cleanup below is for project CHANGES only.
        // A missing tree just retries the load.
        if (available && !get().tree && !get().treeLoading) void get().loadTree()
        return
      }
      if (previous && previous !== path) stopProjectSessions(previous)
      // the UI Mode session (and any open UI run row) stops with its project
      useUiMode.getState().handleProjectSwitch(previous, path)
      useCodegen.getState().resetForProject(path, null)
      wasInterrupted = false
      sawBegin = false
      stopRequested = false
      pendingTreeRefresh = false
      pendingTargetRefresh = false
      workspaceRefreshSeq += 1
      set({
        path,
        tree: null,
        treeError: null,
        treeErrorDetail: null,
        treeDiagnostic: null,
        selectedKey: null,
        traceIntent: null,
        expandedFiles: {},
        decls: {},
        attempts: {},
        statuses: {},
        targets: [],
        activeTargetId: null,
        running: false,
        runId: null,
        historyRunId: null,
        runNumber: 0,
        lastRun: null,
        runError: null,
        watch: false,
        project: null,
        grep: ''
      })
      // Playwright owns environment loading through the project config, shell,
      // setup code, and any fixed env on a safe run recipe. Wrightbench does not
      // overlay a stored profile on discovery or execution.
      const targetsState = await wb.project.targets(path).catch(() => null)
      if (get().path !== path) return
      set({
        targets: targetsState?.targets ?? [],
        activeTargetId: targetsState?.activeTargetId ?? null
      })
      // a missing/unreadable folder gets its recovery surface, not a doomed
      // Playwright listing; observation reloads the tree when it returns
      if (available) await get().loadTree()
    },

    async loadTree(preserveView = false) {
      const wb = api()
      const path = get().path
      if (!wb || !path) return
      const seq = ++treeLoadSeq
      set({ treeLoading: true, treeError: null, treeErrorDetail: null, treeDiagnostic: null })
      try {
        // Listing and execution share the project-owned environment.
        const [outcome, persistedStatuses] = await Promise.all([
          wb.project.testTree(path, null, get().activeTargetId),
          wb.history.latestTestStatuses(path).catch(() => null)
        ])
        if (get().path !== path || seq !== treeLoadSeq) return
        // the target the main process actually listed (it may have resolved
        // the persisted active target when ours was stale)
        if (outcome.target) {
          const targetChanged = get().activeTargetId !== outcome.target.id
          if (targetChanged) {
            useUiMode.getState().handleTargetSwitch(path, outcome.target.id)
          }
          const targets = get().targets.some((t) => t.id === outcome.target.id)
            ? get().targets.map((t) => (t.id === outcome.target.id ? outcome.target : t))
            : [...get().targets, outcome.target]
          set({
            targets,
            activeTargetId: outcome.target.id,
            ...(targetChanged
              ? {
                  tree: null,
                  selectedKey: null,
                  traceIntent: null,
                  expandedFiles: {},
                  decls: {},
                  attempts: {},
                  statuses: {},
                  project: null
                }
              : {})
          })
        }
        if (outcome.status !== 'ready' && outcome.status !== 'empty') {
          const diag = outcome.diagnostic
          set({
            treeLoading: false,
            treeError: 'Could not refresh the test list.',
            treeErrorDetail: diag
              ? diag.detail !== null && diag.detail !== diag.summary
                ? `${diag.summary} — ${diag.detail}`
                : diag.summary
              : null,
            treeDiagnostic: diag
          })
          return
        }
        const tree = outcome.tree!
        const expandedFiles: Record<string, boolean> = preserveView
          ? Object.fromEntries(
              Object.entries(get().expandedFiles).filter(
                ([file, open]) => open && tree.files.some((f) => f.file === file)
              )
            )
          : {}
        if (!preserveView && tree.files[0]) expandedFiles[tree.files[0].file] = true
        // Retained history is authoritative where its legacy identity maps to
        // one current declaration; session-only results survive DB outages.
        const validKeys = new Set(
          tree.files.flatMap((f) => f.tests.map((test) => testKey(test, tree.targetId)))
        )
        const statuses = statusesForTree(tree, persistedStatuses, get().statuses)
        const selectedKey =
          get().selectedKey && validKeys.has(get().selectedKey!) ? get().selectedKey : null
        set({ tree, treeLoading: false, expandedFiles, statuses, selectedKey })
      } catch (err) {
        if (get().path !== path || seq !== treeLoadSeq) return
        console.error('test listing failed:', err)
        set({
          treeLoading: false,
          treeError: 'Could not refresh the test list.',
          treeErrorDetail: listingErrorDetail(err),
          treeDiagnostic: null
        })
      }
    },

    async refreshPersistedStatuses() {
      const wb = api()
      const { path, tree } = get()
      if (!wb || !path || !tree) return
      try {
        const persisted = await wb.history.latestTestStatuses(path)
        if (get().path !== path || get().tree !== tree) return
        set({ statuses: statusesForTree(tree, persisted, get().statuses) })
      } catch {
        // History is optional at runtime; keep the session's known outcomes.
      }
    },

    async setActiveTarget(targetId) {
      const wb = api()
      const path = get().path
      if (!wb || !path || targetId === get().activeTargetId) return
      try {
        const state = await wb.project.setActiveTarget(path, targetId)
        if (get().path !== path) return
        useUiMode.getState().handleTargetSwitch(path, state.activeTargetId)
        // a different target is a different execution context: live results,
        // session statuses, and the previous tree don't carry over (a failed
        // listing must show its error, not the old target's tests). loadTree
        // keeps the selected test only if the exact identity exists in the
        // new listing.
        set({
          targets: state.targets,
          activeTargetId: state.activeTargetId,
          tree: null,
          decls: {},
          attempts: {},
          statuses: {}
        })
        await get().loadTree()
      } catch (err) {
        console.error('switching target failed:', err)
      }
    },

    async refreshTargets(rescan = false) {
      const wb = api()
      const path = get().path
      if (!wb || !path) return
      const refresh = async (): Promise<void> => {
        try {
          const state = rescan
            ? await wb.project.rescanTargets(path, null, false)
            : await wb.project.targets(path)
          if (get().path !== path) return
          const targetChanged = get().activeTargetId !== state.activeTargetId
          if (targetChanged) {
            useUiMode.getState().handleTargetSwitch(path, state.activeTargetId)
          }
          set({
            targets: state.targets,
            activeTargetId: state.activeTargetId,
            ...(targetChanged
              ? {
                  tree: null,
                  selectedKey: null,
                  traceIntent: null,
                  expandedFiles: {},
                  decls: {},
                  attempts: {},
                  statuses: {},
                  project: null
                }
              : {})
          })
        } catch {
          // registry unavailable — keep the last known targets
        }
      }
      if (!rescan) {
        await refresh()
        return
      }
      // Scans are debounced upstream, but installs can still emit several
      // discovery events. Every waiter observes the same completed target
      // state before it proceeds to list tests.
      const existing = rescansInFlight.get(path)
      if (existing) {
        await existing
        return
      }
      const task = refresh()
      rescansInFlight.set(path, task)
      try {
        await task
      } finally {
        if (rescansInFlight.get(path) === task) rescansInFlight.delete(path)
      }
    },

    async pickConfigTarget() {
      const wb = api()
      const path = get().path
      if (!wb || !path) return
      try {
        const result = await wb.project.pickConfigTarget(path, null)
        if (result.cancelled || get().path !== path) return
        if (result.error !== null) {
          // the status bar is the failure surface for target actions
          set({ runError: `could not use that config — ${result.error}` })
          return
        }
        // main persisted the picked config as the active target — adopt its
        // state BEFORE listing so loadTree lists the new target, not a stale id
        if (result.targets) {
          useUiMode.getState().handleTargetSwitch(path, result.targets.activeTargetId)
          set({
            targets: result.targets.targets,
            activeTargetId: result.targets.activeTargetId,
            tree: null,
            decls: {},
            attempts: {},
            statuses: {}
          })
        }
        await get().loadTree()
      } catch (err) {
        console.error('config pick failed:', err)
      }
    },

    handleActiveUnavailable() {
      const wb = api()
      const path = get().path
      if (wb && path) {
        // repository-dependent sessions can't outlive the folder; the db and
        // global History keeps working from Wrightbench-owned state
        if (get().watch) void wb.watch.stop(path)
        void wb.report.stop(path)
        void wb.traces.stop(path)
        void wb.codegen.stop(path)
      }
      pendingTreeRefresh = false
      pendingTargetRefresh = false
      workspaceRefreshSeq += 1
      treeLoadSeq += 1 // discard any in-flight listing for the vanished folder
      set({
        tree: null,
        treeError: null,
        treeErrorDetail: null,
        treeDiagnostic: null,
        treeLoading: false,
        selectedKey: null,
        traceIntent: null,
        expandedFiles: {},
        decls: {},
        attempts: {},
        statuses: {},
        watch: false
      })
    },

    teardownWorkspace() {
      const previous = get().path
      if (previous) stopProjectSessions(previous)
      useUiMode.getState().handleProjectSwitch(previous, null)
      useCodegen.getState().resetForProject(null, null)
      wasInterrupted = false
      sawBegin = false
      stopRequested = false
      pendingTreeRefresh = false
      pendingTargetRefresh = false
      workspaceRefreshSeq += 1
      treeLoadSeq += 1 // discard any in-flight tree response
      set({
        path: null,
        tree: null,
        treeError: null,
        treeErrorDetail: null,
        treeDiagnostic: null,
        treeLoading: false,
        selectedKey: null,
        traceIntent: null,
        expandedFiles: {},
        decls: {},
        attempts: {},
        statuses: {},
        targets: [],
        activeTargetId: null,
        running: false,
        runId: null,
        historyRunId: null,
        runNumber: 0,
        lastRun: null,
        runError: null,
        watch: false,
        project: null,
        grep: ''
      })
    },

    async startRun(options) {
      const wb = api()
      const state = get()
      if (!wb || !state.path || state.running) return
      if (uiModeBlocksOtherWork(useUiMode.getState())) {
        set({
          runError:
            useUiMode.getState().status === 'external'
              ? 'Stop the external UI Mode session before starting a Wrightbench run.'
              : 'Stop the active UI Mode session before starting a Wrightbench run.'
        })
        return
      }
      const targetId = state.tree?.targetId ?? state.activeTargetId
      if (!targetId) {
        set({ runError: 'Select a valid test configuration before running.' })
        return
      }
      const workers = Number.parseInt(state.workers, 10)
      const trigger: RunTrigger =
        options?.trigger ?? (options?.lastFailed ? 'rerun-failed' : 'manual')
      wasInterrupted = false
      sawBegin = false
      stopRequested = false
      set({
        running: true,
        runId: null,
        historyRunId: null,
        runNumber: 0, // unknown until the main process assigns it
        runCommit: null,
        runTrigger: trigger,
        decls: {},
        attempts: {},
        instanceTotal: 0,
        instanceDone: 0,
        startedAt: Date.now(),
        runError: null
      })
      try {
        const { runId, historyRunId, runNumber, commitHash } = await wb.run.start({
          path: state.path,
          targetId,
          project: state.project,
          // A location rerun ignores the toolbar grep. Test-row callers add
          // an escaped title suffix so same-line generated tests stay exact.
          grep:
            options?.grep !== undefined
              ? options.grep.trim() || null
              : options?.location
                ? null
                : state.grep.trim() || null,
          workers: Number.isFinite(workers) ? workers : null,
          envProfile: null,
          lastFailed: options?.lastFailed ?? false,
          location: options?.location ?? null,
          trigger
        })
        if (get().path !== state.path) {
          // the user switched projects mid-start — don't orphan the child
          void wb.run.stop(runId)
          return
        }
        // authoritative persisted number + commit from the main process
        set({ historyRunId, runNumber, runCommit: commitHash })
        // keep an event-adopted runId if events already arrived
        if (get().runId === null) set({ runId })
        if (stopRequested) void wb.run.stop(get().runId ?? runId)
      } catch (err) {
        set({
          running: false,
          runId: null,
          historyRunId: null,
          runNumber: state.runNumber,
          startedAt: null,
          runError: err instanceof Error ? err.message : String(err)
        })
      }
    },

    async stopRun() {
      const wb = api()
      const { runId, running } = get()
      if (!wb) return
      if (runId === null) {
        // start invoke still in flight — stop as soon as the id is known
        if (running) stopRequested = true
        return
      }
      await wb.run.stop(runId)
    },

    async toggleWatch() {
      const wb = api()
      const state = get()
      if (!wb || !state.path) return
      if (state.watch) {
        set({ watch: false })
        await wb.watch.stop(state.path)
      } else {
        set({ watch: true })
        await wb.watch.start(state.path, state.tree?.rootDir ?? null)
      }
    },

    select(key) {
      set({ selectedKey: key, traceIntent: null })
    },
    openTrace(key, runId) {
      set({
        selectedKey: key,
        traceIntent: { id: ++traceIntentSequence, key, runId }
      })
    },
    consumeTraceIntent(id) {
      if (get().traceIntent?.id === id) set({ traceIntent: null })
    },
    toggleFile(file) {
      const expanded = { ...get().expandedFiles }
      expanded[file] = !expanded[file]
      set({ expandedFiles: expanded })
    },
    setExpandedFiles(files) {
      const valid = new Set(get().tree?.files.map((file) => file.file) ?? [])
      set({
        expandedFiles: Object.fromEntries(
          [...new Set(files)].filter((file) => valid.has(file)).map((file) => [file, true])
        )
      })
    },
    setProject(project) {
      set({
        project:
          project === '' || project === 'all projects' || project === 'all applicable projects'
            ? null
            : project
      })
    },
    setGrep(grep) {
      set({ grep })
    },
    setWorkers(workers) {
      set({ workers })
    }
  }
})

/** the workspace's active harness target (null until targets load) */
export function useActiveTarget(): TargetSummary | null {
  const targets = useRun((s) => s.targets)
  const activeTargetId = useRun((s) => s.activeTargetId)
  return targets.find((t) => t.id === activeTargetId) ?? targets[0] ?? null
}

/** unified status lookup: live run state first, then last known */
export function useTestStatus(key: string): { status: TestStatus; duration: number | null; startedAt: number | null } {
  const decl = useRun((s) => s.decls[key])
  const final = useRun((s) => s.statuses[key])
  if (decl) {
    const status = declStatus(decl)
    const done = Object.keys(decl.perProject).length
    return {
      status,
      duration: status === 'running' ? null : done > 0 ? declDuration(decl) : null,
      startedAt: decl.startedAt
    }
  }
  if (final) return { status: final.status, duration: final.duration, startedAt: null }
  return { status: 'none', duration: null, startedAt: null }
}

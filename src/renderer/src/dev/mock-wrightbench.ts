import type {
  ArtifactKind,
  CodegenEventPayload,
  HistoryAnalytics,
  PersistedArtifact,
  PersistedAttempt,
  PersistedTestStatus,
  ProjectInspection,
  ProjectInfo,
  ProjectWithHealth,
  RunEventPayload,
  RunProjectStatus,
  RunRecord,
  TargetSummary,
  TestListOutcome,
  TestRef,
  TestInspectorDetail,
  TestRunDetail,
  TestRunSummary,
  TestTree,
  TraceLibEntry,
  WrightbenchApi,
  WrightbenchSettings
} from '@shared/ipc'

/**
 * Dev-only mock of window.wrightbench for browser-pane pixel checks of the
 * workspace (#preview-workspace). Never active inside Electron. The scripted
 * run reproduces artboard 06's mid-run states; window.__mockFinishRun()
 * fast-forwards to the finished state (artboard 04).
 */

const AVAILABLE = { state: 'available', reason: null } as const

const PROJECT: ProjectInfo = {
  id: 'mock',
  name: 'web-app',
  path: '/dev/acme/web-app',
  addedAt: new Date().toISOString(),
  playwrightVersion: '1.62.1',
  nodeVersion: 'v20.12.2',
  testCount: 20
}

/* the fixture workspace trio (AGENTS.md) so the project switcher can demo */
const EXTRA_PROJECTS: ProjectInfo[] = [
  {
    id: 'mock-admin',
    name: 'admin-portal',
    path: '/dev/acme/admin-portal',
    addedAt: new Date().toISOString(),
    playwrightVersion: '1.62.1',
    nodeVersion: 'v20.12.2',
    testCount: 34
  },
  {
    id: 'mock-api',
    name: 'api-e2e',
    path: '/dev/acme/api-e2e',
    addedAt: new Date().toISOString(),
    playwrightVersion: '1.62.1',
    nodeVersion: 'v20.12.2',
    testCount: 12
  }
]

const FILES: [string, string[]][] = [
  [
    'checkout.spec.ts',
    [
      'completes guest checkout with saved address',
      'applies discount code SPRING24',
      'shows error when card is declined',
      'retries payment after gateway timeout',
      'persists cart across sessions'
    ]
  ],
  [
    'auth.spec.ts',
    [
      'signs in with magic link',
      'rejects expired session token',
      'resets password from email',
      'locks account after 5 failed attempts'
    ]
  ],
  [
    'cart.spec.ts',
    ['updates quantity from mini-cart', 'removes item and recalculates totals', 'merges guest cart on login']
  ],
  ['search.spec.ts', ['filters results by price facet', 'shows empty state for zero results']],
  ['onboarding.spec.ts', ['walks through the welcome tour', 'skips optional profile steps']],
  ['profile.spec.ts', ['updates display name', 'uploads an avatar']],
  ['notifications.spec.ts', ['marks all as read', 'mutes a thread']]
]

const PROJECT_NAMES = ['chromium', 'firefox', 'webkit']

/** one runnable conventional-root target per mock project */
function mockTarget(id: string, testCount: number): TargetSummary {
  return {
    id,
    label: 'playwright.config.ts',
    cwd: '.',
    configPath: 'playwright.config.ts',
    packageDir: '.',
    launcher: 'npm',
    source: 'config',
    scriptName: null,
    playwrightVersion: '1.62.1',
    testCount,
    runnable: true,
    runnableReason: null
  }
}

/** per-path active-target selection for the switcher demo */
const mockActiveTargets: Record<string, string> = {}

/** ids must match the trees the mock serves, like the real registry does */
function mockTargetIdFor(path: string): string {
  if (path === EXTRA_PROJECTS[0].path) return 'mock-target-admin'
  if (path === EXTRA_PROJECTS[1].path) return 'mock-target-api'
  return 'mock-target-web'
}

function mockTargetsState(path: string): { targets: TargetSummary[]; activeTargetId: string } {
  const base = mockTarget(
    mockTargetIdFor(path),
    path === EXTRA_PROJECTS[0].path ? 5 : path === EXTRA_PROJECTS[1].path ? 2 : 15
  )
  const targets =
    path === EXTRA_PROJECTS[1].path
      ? [base]
      : [
          base,
          {
            ...base,
            id: `${base.id}-monitor`,
            label: path === EXTRA_PROJECTS[0].path ? 'test:qa' : 'test:monitor',
            source: 'script' as const,
            scriptName: path === EXTRA_PROJECTS[0].path ? 'test:qa' : 'test:monitor',
            testCount: path === EXTRA_PROJECTS[0].path ? 3 : 6
          }
        ]
  const requested = mockActiveTargets[path]
  return {
    targets,
    activeTargetId: targets.some((t) => t.id === requested) ? requested : targets[0].id
  }
}

function mockUiModeContext(
  path: string,
  targetId: string
): { configurationTargetId: string; recipeMappedToBase: boolean } {
  const targets = mockTargetsState(path).targets
  const requested = targets.find((target) => target.id === targetId)
  const recipeMappedToBase = requested?.source === 'script'
  const configuration = recipeMappedToBase
    ? targets.find(
        (target) =>
          target.source !== 'script' &&
          target.cwd === requested.cwd &&
          target.configPath === requested.configPath &&
          target.packageDir === requested.packageDir
      )
    : requested
  return {
    configurationTargetId: configuration?.id ?? targetId,
    recipeMappedToBase
  }
}

const TREE: TestTree = {
  targetId: 'mock-target-web',
  files: FILES.map(([file, titles]) => ({
    file,
    tests: titles.map((title, i) => ({
      file,
      line: 3 + i * 5,
      column: 3,
      title,
      titlePath: [title],
      projects: PROJECT_NAMES
    }))
  })),
  projectNames: PROJECT_NAMES,
  rootDir: 'tests/e2e',
  totalTests: FILES.reduce((n, [, t]) => n + t.length, 0)
}

/** artboard 06 outcome fixture: one failed test, one flaky */
function outcomeFor(ref: { title: string }): 'expected' | 'unexpected' | 'flaky' {
  if (ref.title === 'applies discount code SPRING24') return 'unexpected'
  if (ref.title === 'retries payment after gateway timeout') return 'flaky'
  return 'expected'
}

const MOCK_PERSISTED_STATUSES: PersistedTestStatus[] = TREE.files.flatMap((file) =>
  file.tests.map((test) => ({
    file: test.file,
    line: test.line,
    title: test.title,
    status:
      outcomeFor(test) === 'unexpected'
        ? ('fail' as const)
        : outcomeFor(test) === 'flaky'
          ? ('flaky' as const)
          : ('pass' as const),
    durationMs: outcomeFor(test) === 'expected' ? 1200 : 6900
  }))
)

/** fixture history replicating artboard 07's data shapes */
const HOUR = 3600_000
const MOCK_RUNS: RunRecord[] = [
  { runNumber: 142, trigger: 'manual', commitHash: '7f3a2c1', passed: 121, failed: 5, flaky: 2, durationMs: 231_000, hoursAgo: 8 },
  { runNumber: 141, trigger: 'ui-mode', commitHash: 'b91d4ee', passed: 128, failed: 0, flaky: 0, durationMs: 218_000, hoursAgo: 12 },
  { runNumber: 140, trigger: 'watch', commitHash: 'b91d4ee', passed: 127, failed: 0, flaky: 1, durationMs: 224_000, hoursAgo: 28 },
  { runNumber: 139, trigger: 'ui-mode', commitHash: '4c8e0af', passed: 126, failed: 2, flaky: 0, durationMs: 220_000, hoursAgo: 31 },
  { runNumber: 138, trigger: 'manual', commitHash: '4c8e0af', passed: 128, failed: 0, flaky: 0, durationMs: 215_000, hoursAgo: 36 },
  // deliberately older than the cluster above so custom date ranges can hit
  // an empty day (zero-result range demo)
  { runNumber: 137, trigger: 'watch', commitHash: '9d2b7c3', passed: 128, failed: 0, flaky: 0, durationMs: 227_000, hoursAgo: 99 },
  { runNumber: 136, trigger: 'manual', commitHash: '9d2b7c3', passed: 120, failed: 6, flaky: 2, durationMs: 242_000, hoursAgo: 103 }
].map((r, i) => ({
  id: 200 - i,
  runNumber: r.runNumber,
  trigger: r.trigger,
  commitHash: r.commitHash,
  startedAt: Date.now() - r.hoursAgo * HOUR,
  finishedAt: Date.now() - r.hoursAgo * HOUR + r.durationMs,
  durationMs: r.durationMs,
  status: r.failed > 0 ? 'failed' : 'passed',
  passed: r.passed,
  failed: r.failed,
  flaky: r.flaky,
  skipped: 0,
  total: r.passed + r.failed + r.flaky
}))

const MOCK_ANALYTICS: HistoryAnalytics = {
  passRatePct: 94.2,
  passRatePriorPct: 93.1,
  avgDurationMs: 222_000,
  avgDurationPriorMs: 234_000,
  flakyCount: 5,
  rangeRuns: 30,
  runsThisWeek: 23,
  weekManual: 18,
  weekWatch: 5,
  series: Array.from({ length: 30 }, (_, i) => {
    const runNumber = 114 + i
    const rate =
      runNumber === 128 ? 88 : runNumber === 121 ? 93 : 96 + ((i * 7) % 4) - (i % 3)
    return {
      runNumber,
      rate,
      failed: runNumber === 128 ? 5 : 0,
      flaky: runNumber === 121 ? 2 : 0
    }
  }),
  flakiest: [
    {
      file: 'checkout.spec.ts',
      line: 18,
      title: 'retries payment after gateway timeout',
      outcomes: ['pass', 'flaky', 'pass', 'pass', 'pass', 'flaky', 'pass', 'pass', 'pass', 'pass'],
      flakyRuns: 2,
      flakyPct: 20
    },
    {
      file: 'profile.spec.ts',
      line: 8,
      title: 'uploads avatar image',
      outcomes: ['pass', 'pass', 'pass', 'flaky', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'],
      flakyRuns: 1,
      flakyPct: 10
    },
    {
      file: 'notifications.spec.ts',
      line: 3,
      title: 'receives push notification badge',
      outcomes: ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'flaky', 'pass', 'pass', 'pass'],
      flakyRuns: 1,
      flakyPct: 10
    }
  ],
  regressions: [
    { file: 'checkout.spec.ts', line: 3, title: 'completes guest checkout with saved address', beforeMs: 2900, afterMs: 4200 },
    { file: 'search.spec.ts', line: 3, title: 'filters results by price facet', beforeMs: 1400, afterMs: 2100 },
    { file: 'auth.spec.ts', line: 13, title: 'resets password from email', beforeMs: 2400, afterMs: 3300 }
  ],
  totalRuns: 143,
  oldestKeptAt: Date.now() - 90 * 24 * HOUR,
  filterCounts: { all: 143, failed: 11, flaky: 19, watch: 36 },
  retentionDays: 90
}

/** date at a wall-clock time relative to today, for stable "yesterday 15:03" rendering */
function daysAgoAt(days: number, hours: number, minutes: number): number {
  const date = new Date()
  date.setDate(date.getDate() - days)
  date.setHours(hours, minutes, 0, 0)
  return date.getTime()
}

const MOCK_FAILURE_TITLE = 'shows error when card is declined'
const MOCK_FAILURE_ERROR = [
  'Error: Timed out 5000ms waiting for',
  'expect(locator).toBeVisible()',
  '',
  "Locator: getByTestId('toast-error')",
  'Expected: visible',
  'Received: hidden',
  '',
  '  at checkout.spec.ts:87:41'
].join('\n')
const MOCK_FAILURE_OUTCOMES = Array.from({ length: 20 }, (_, index) => ({
  runId: 300 + index,
  runNumber: 123 + index,
  status: [3, 8, 16, 19].includes(index) ? ('fail' as const) : ('pass' as const)
}))

/**
 * Per-run evidence shapes for the master-detail inspector preview: every
 * combination the UI must demo — full evidence, trace/report only, nothing
 * retained, retries, flaky recovery, and multi-project splits.
 */
interface MockAttemptShape {
  project: string
  retry: number
  status: string
  artifacts: ArtifactKind[]
  error?: string | null
}

interface MockRunShape {
  attempts: MockAttemptShape[]
  /** run-wide artifacts (report lives at run scope) */
  runArtifacts: ArtifactKind[]
  error?: string | null
}

const GATEWAY_ERROR = 'Error: apiRequestContext.post: gateway timeout after 30000ms'

const MOCK_RUN_SHAPES: Record<number, MockRunShape> = {
  // full evidence + a retried chromium failure (several captures → gallery)
  142: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'failed', artifacts: ['trace', 'screenshot', 'screenshot', 'screenshot', 'diff', 'video'], error: MOCK_FAILURE_ERROR },
      { project: 'chromium', retry: 1, status: 'failed', artifacts: ['trace', 'video'], error: MOCK_FAILURE_ERROR },
      { project: 'firefox', retry: 0, status: 'passed', artifacts: [] },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: ['report'],
    error: MOCK_FAILURE_ERROR
  },
  141: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'passed', artifacts: [] },
      { project: 'firefox', retry: 0, status: 'passed', artifacts: [] },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: ['report']
  },
  // flaky: chromium failed once, recovered on retry — trace/report only
  140: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'failed', artifacts: ['trace'], error: GATEWAY_ERROR },
      { project: 'chromium', retry: 1, status: 'passed', artifacts: [] },
      { project: 'firefox', retry: 0, status: 'passed', artifacts: [] },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: ['report'],
    error: GATEWAY_ERROR
  },
  139: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'failed', artifacts: ['trace'], error: MOCK_FAILURE_ERROR },
      { project: 'firefox', retry: 0, status: 'passed', artifacts: [] },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: ['report'],
    error: MOCK_FAILURE_ERROR
  },
  // nothing retained — evidence pruned by the artifact budget
  138: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'passed', artifacts: [] },
      { project: 'firefox', retry: 0, status: 'passed', artifacts: [] },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: []
  },
  137: {
    attempts: [{ project: 'chromium', retry: 0, status: 'passed', artifacts: ['video'] }],
    runArtifacts: ['report']
  },
  136: {
    attempts: [
      { project: 'chromium', retry: 0, status: 'failed', artifacts: ['trace', 'screenshot'], error: MOCK_FAILURE_ERROR },
      { project: 'firefox', retry: 0, status: 'failed', artifacts: ['trace'], error: MOCK_FAILURE_ERROR },
      { project: 'webkit', retry: 0, status: 'passed', artifacts: [] }
    ],
    runArtifacts: ['report'],
    error: MOCK_FAILURE_ERROR
  }
}

function shapeProjectStatuses(shape: MockRunShape): RunProjectStatus[] {
  const byProject = new Map<string, MockAttemptShape[]>()
  for (const attempt of shape.attempts) {
    const list = byProject.get(attempt.project) ?? []
    list.push(attempt)
    byProject.set(attempt.project, list)
  }
  return [...byProject.entries()].map(([project, list]) => {
    const final = list[list.length - 1]
    const finalPass = final.status === 'passed'
    const earlierFail = list.some((attempt) => attempt.status === 'failed')
    return {
      project,
      status: finalPass ? (earlierFail ? 'flaky' : 'pass') : 'fail'
    }
  })
}

function shapeArtifactKinds(shape: MockRunShape): ArtifactKind[] {
  const kinds = new Set<ArtifactKind>(shape.runArtifacts)
  for (const attempt of shape.attempts) {
    for (const kind of attempt.artifacts) kinds.add(kind)
  }
  return [...kinds]
}

/** a scripted session run reuses the static fixture shape for its outcome */
function sessionShapeFor(ref: { title: string }): MockRunShape {
  const outcome = outcomeFor(ref)
  return MOCK_RUN_SHAPES[outcome === 'unexpected' ? 142 : outcome === 'flaky' ? 140 : 141]
}

interface SessionRun {
  id: number
  runNumber: number
  startedAt: number
  finishedAt: number
}

function sessionRunSummary(run: SessionRun, ref: { title: string }): TestRunSummary {
  const outcome = outcomeFor(ref)
  const shape = sessionShapeFor(ref)
  const status: TestRunSummary['status'] =
    outcome === 'unexpected' ? 'fail' : outcome === 'flaky' ? 'flaky' : 'pass'
  return {
    runId: run.id,
    runNumber: run.runNumber,
    status,
    durationMs: run.finishedAt - run.startedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    trigger: 'manual',
    commitHash: '7f3a2c1',
    projectFilter: 'all',
    attemptCount: shape.attempts.length,
    artifactKinds: shapeArtifactKinds(shape),
    projectStatuses: shapeProjectStatuses(shape),
    firstErrorLine: status === 'pass' ? null : (shape.error?.split('\n')[0] ?? null)
  }
}

const MOCK_INSPECTOR: TestInspectorDetail = {
  latest: {
    runId: MOCK_RUNS[0].id,
    runNumber: MOCK_RUNS[0].runNumber,
    status: 'fail',
    durationMs: 6900,
    startedAt: MOCK_RUNS[0].startedAt,
    finishedAt: MOCK_RUNS[0].finishedAt,
    trigger: MOCK_RUNS[0].trigger,
    commitHash: MOCK_RUNS[0].commitHash
  },
  last20: MOCK_FAILURE_OUTCOMES,
  passRatePct: 80,
  flakyPct: 14.3,
  medianDurationMs: 4100,
  latestFailure: {
    runId: MOCK_RUNS[0].id,
    runNumber: MOCK_RUNS[0].runNumber,
    status: 'fail',
    error: MOCK_FAILURE_ERROR
  },
  runs: MOCK_RUNS.slice(0, 8).map((run) => {
    const shape = MOCK_RUN_SHAPES[run.runNumber]
    const status = run.failed > 0 ? 'fail' : run.flaky > 0 ? 'flaky' : 'pass'
    return {
      runId: run.id,
      runNumber: run.runNumber,
      status,
      durationMs: run.durationMs ?? 0,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      trigger: run.trigger,
      commitHash: run.commitHash,
      projectFilter: 'all',
      attemptCount: shape?.attempts.length ?? 1,
      artifactKinds: shape ? shapeArtifactKinds(shape) : [],
      projectStatuses: shape ? shapeProjectStatuses(shape) : [],
      firstErrorLine:
        status === 'fail' || status === 'flaky'
          ? (shape?.error?.split('\n')[0] ?? null)
          : null
    }
  })
}

const ARTIFACT_FILES: Record<ArtifactKind, { file: string; contentType: string; bytes: number }> = {
  trace: { file: 'trace.zip', contentType: 'application/zip', bytes: 2_516_582 },
  screenshot: { file: 'test-failed-1.png', contentType: 'image/png', bytes: 192_512 },
  video: { file: 'video.webm', contentType: 'video/webm', bytes: 1_258_291 },
  diff: { file: 'diff.png', contentType: 'image/png', bytes: 88_211 },
  report: { file: 'report/index.html', contentType: 'text/html', bytes: 412_003 },
  custom: { file: 'attachment.txt', contentType: 'text/plain', bytes: 1_024 }
}

function mockArtifact(
  runId: number,
  attemptId: number | null,
  kind: ArtifactKind,
  index: number,
  occurrence = 1
): PersistedArtifact {
  const spec = ARTIFACT_FILES[kind]
  // repeated kinds follow Playwright's sequential naming: test-failed-2.png …
  const file =
    occurrence > 1 ? spec.file.replace(/-1(\.[a-z]+)$/, `-${occurrence}$1`) : spec.file
  return {
    id: (attemptId ?? runId * 100) * 10 + index,
    attemptId,
    name: occurrence > 1 ? `${kind} ${occurrence}` : kind,
    kind,
    contentType: spec.contentType,
    path: `/dev/acme/web-app/.wrightbench-artifacts/run-${runId}/${attemptId ?? 'run'}-${file}`,
    fileName: file.split('/').pop() ?? file,
    sizeBytes: spec.bytes + occurrence * 1_024
  }
}

function mockAttempts(runId: number, shape: MockRunShape): PersistedAttempt[] {
  return shape.attempts.map((attempt, index) => {
    const attemptId = runId * 100 + index
    const failed = attempt.status === 'failed'
    return {
      id: attemptId,
      externalId: `attempt-${attemptId}`,
      project: attempt.project,
      retry: attempt.retry,
      workerIndex: index % 4,
      parallelIndex: index % 4,
      startedAt: Date.now() - 3600_000,
      finishedAt: Date.now() - 3600_000 + 6900,
      status: attempt.status,
      durationMs: failed ? 6900 : 1200 + index * 340,
      error: attempt.error ?? null,
      annotations: [],
      steps: [
        { id: attemptId * 10 + 1, externalId: `s${attemptId}-1`, parentExternalId: null, title: 'beforeEach hook', category: 'hook', startedAt: 0, finishedAt: 180, durationMs: 180, error: null },
        { id: attemptId * 10 + 2, externalId: `s${attemptId}-2`, parentExternalId: null, title: 'page.goto(/checkout)', category: 'pw:api', startedAt: 200, finishedAt: 640, durationMs: 440, error: null },
        { id: attemptId * 10 + 3, externalId: `s${attemptId}-3`, parentExternalId: null, title: "click 'Pay now'", category: 'pw:api', startedAt: 700, finishedAt: 910, durationMs: 210, error: null },
        {
          id: attemptId * 10 + 4,
          externalId: `s${attemptId}-4`,
          parentExternalId: null,
          title: 'expect(toast-error).toBeVisible',
          category: 'expect',
          startedAt: 950,
          finishedAt: failed ? 5950 : 1150,
          durationMs: failed ? 5000 : 200,
          error: failed ? (attempt.error ?? null) : null
        }
      ],
      logs: failed
        ? [{ id: attemptId * 10 + 9, stream: 'stderr', text: 'gateway responded 504\n', timestamp: Date.now() }]
        : [],
      artifacts: (() => {
        const seen: Partial<Record<ArtifactKind, number>> = {}
        return attempt.artifacts.map((kind, artifactIndex) => {
          seen[kind] = (seen[kind] ?? 0) + 1
          return mockArtifact(runId, attemptId, kind, artifactIndex, seen[kind])
        })
      })()
    }
  })
}


/** artboard 09's recorded session, verbatim */
const MOCK_CODEGEN_CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('guest applies gift card', async ({ page }) => {",
  "  await page.goto('https://staging.acme.shop/checkout');",
  "  await page.getByTestId('gift-card-input').click();",
  "  await page.getByTestId('gift-card-input').fill('ACME-50-XY');",
  "  await page.getByRole('button', { name: 'Apply' }).click();",
  "  await expect(page.getByText('$50.00 applied')).toBeVisible();",
  '});',
  ''
].join('\n')

const MOCK_CODEGEN_ACTIONS = [
  { kind: 'goto' as const, locator: 'https://staging.acme.shop/checkout', value: null },
  { kind: 'click' as const, locator: "getByTestId('gift-card-input')", value: null },
  { kind: 'fill' as const, locator: "getByTestId('gift-card-input')", value: 'ACME-50-XY' },
  { kind: 'click' as const, locator: "getByRole('button', { name: 'Apply' })", value: null },
  { kind: 'assert' as const, locator: "getByText('$50.00 applied')/toBeVisible", value: null }
]

/** artboard 12's trace library */
const MOCK_TRACES: TraceLibEntry[] = [
  { runId: 200, runNumber: 142, startedAt: daysAgoAt(0, 14, 32), status: 'fail', file: 'checkout.spec.ts', line: 13, title: 'shows error when card is declined', path: '/dev/acme/web-app/test-results/t142-declined/trace.zip', sizeBytes: 2_516_582 },
  { runId: 200, runNumber: 142, startedAt: daysAgoAt(0, 14, 32), status: 'flaky', file: 'checkout.spec.ts', line: 18, title: 'retries payment after gateway timeout', path: '/dev/acme/web-app/test-results/t142-retries/trace.zip', sizeBytes: 3_250_585 },
  { runId: 197, runNumber: 139, startedAt: daysAgoAt(1, 15, 3), status: 'fail', file: 'checkout.spec.ts', line: 13, title: 'shows error when card is declined', path: '/dev/acme/web-app/test-results/t139-declined/trace.zip', sizeBytes: 2_306_867 },
  { runId: 194, runNumber: 136, startedAt: daysAgoAt(3, 14, 19), status: 'fail', file: 'profile.spec.ts', line: 8, title: 'uploads avatar image', path: '/dev/acme/web-app/test-results/t136-avatar/trace.zip', sizeBytes: 1_887_437 }
]

/** artboard 10's settings */
const MOCK_SETTINGS: WrightbenchSettings = {
  theme: 'system',
  envProfiles: [
    {
      name: 'staging',
      env: {
        BASE_URL: 'https://staging.acme.shop',
        API_KEY: 'sk-staging-000',
        STRIPE_KEY: 'pk_test_000',
        FEATURE_FLAGS: 'gift-cards',
        LOCALE: 'en-US',
        RETRIES: '1'
      }
    },
    {
      name: 'production',
      description: 'read-only checks',
      env: {
        BASE_URL: 'https://acme.shop',
        API_KEY: 'sk-live-000',
        LOCALE: 'en-US',
        READ_ONLY: 'true'
      }
    }
  ],
  defaultProfile: 'staging',
  runRetentionDays: 90,
  traceRetentionDays: 14,
  captureMode: 'full',
  artifactBudgetGb: 5,
  density: 'relaxed',
  codeFont: 'jetbrains-mono',
  nodeMode: 'auto',
  nodePath: '',
  workspaceUi: { sidebarCollapsed: false, sidebarWidth: 262, projectViews: {} }
}

export function installMockWrightbench(): void {
  // api-e2e ships "missing" so the switcher's health treatment can be seen
  let mockProjects: ProjectWithHealth[] = [
    { ...EXTRA_PROJECTS[0], health: AVAILABLE },
    { ...EXTRA_PROJECTS[1], health: { state: 'missing', reason: 'Folder not found' } },
    { ...PROJECT, health: AVAILABLE }
  ]
  let listener: ((payload: RunEventPayload) => void) | null = null
  let codegenListener: ((payload: CodegenEventPayload) => void) | null = null
  let mockSettings: WrightbenchSettings = { ...MOCK_SETTINGS }
  let mockRunNumber = 142
  let timers: ReturnType<typeof setTimeout>[] = []
  let pending: TestRef[] = []
  let runActive = false
  /** scripted runs completed this session — the inspector reads them as history */
  const sessionRuns: SessionRun[] = []
  let runStartedAt = 0

  const scheduled: TestRef[] = TREE.files.flatMap((f) =>
    f.tests.flatMap((t) => PROJECT_NAMES.map((project) => ({ ...t, project })))
  )

  // the scripted run follows whichever project it was started for
  let runPath = PROJECT.path
  const emit = (event: RunEventPayload['event']): void => {
    listener?.({
      runId: 'mock-run',
      historyRunId: mockRunNumber,
      runNumber: mockRunNumber,
      path: runPath,
      event
    })
  }

  const attempt = (ref: TestRef) => ({
    ...ref,
    attemptId: `${ref.file}:${ref.line}:${ref.title}|${ref.project}|r0|w0`,
    retry: 0,
    workerIndex: 0,
    parallelIndex: 0
  })

  const endInstance = (ref: TestRef, duration: number): void => {
    const outcome = outcomeFor(ref)
    emit({
      type: 'test-end',
      ...ref,
      status: outcome === 'unexpected' ? 'failed' : 'passed',
      outcome,
      duration,
      finishedAt: Date.now(),
      ...attempt(ref),
      error: outcome === 'unexpected' ? 'expect(received).toBe(expected)' : undefined
    })
  }

  const finishAll = (): void => {
    for (const t of timers) clearTimeout(t)
    timers = []
    if (!runActive) return
    for (const ref of pending) {
      emit({ type: 'test-begin', startedAt: Date.now(), ...attempt(ref) })
      endInstance(ref, 500 + Math.abs(ref.title.length * 137) % 3500)
    }
    pending = []
    runActive = false
    // record before 'finished' so the inspector refetch already sees the run
    sessionRuns.unshift({
      id: mockRunNumber,
      runNumber: mockRunNumber,
      startedAt: runStartedAt,
      finishedAt: Date.now()
    })
    emit({ type: 'end', status: 'failed' })
    emit({ type: 'finished', code: 1 })
  }

  const api: WrightbenchApi = {
    theme: {
      get: async () => {
        const resolved = localStorage.getItem('wrightbench.theme') === 'dark' ? 'dark' : 'light'
        return { preference: resolved, resolved }
      },
      set: async (preference) => {
        localStorage.setItem('wrightbench.theme', preference)
        const resolved = preference === 'dark' ? 'dark' : 'light'
        return { preference, resolved }
      },
      onChanged: () => () => {}
    },
    projects: {
      // web-app last: init() activates the newest project (artboard 04 state)
      list: async () => mockProjects,
      add: async () => mockProjects,
      remove: async (id) => {
        mockProjects = mockProjects.filter((p) => p.id !== id)
        return mockProjects
      },
      onChanged: () => () => {},
      onFilesChanged: () => () => {}
    },
    project: {
      pickFolder: async () => null,
      inspect: async (path): Promise<ProjectInspection> => {
        const detected = {
          ...mockTarget('mock-detected', 0),
          status: 'not-validated' as const,
          diagnostic: null,
          recording: { supported: true, reason: null },
          environmentSetupHints: [],
          specFiles: null,
          projectNames: null,
          configuredProjectNames: null,
          rootDir: null
        }
        return {
          path,
          name: path.split('/').filter(Boolean).at(-1) ?? 'playwright-project',
          configFile: 'playwright.config.ts',
          playwrightVersion: detected.playwrightVersion,
          targets: [detected],
          recommendedTargetId: detected.id
        }
      },
      scaffold: () => Promise.reject(new Error('mock')),
      onProgress: () => () => {},
      openFile: async () => ({ ok: true, code: 0 }),
      reveal: async () => true,
      // web/admin projects demonstrate a base configuration plus run recipe
      targets: async (path) => mockTargetsState(path),
      setActiveTarget: async (path, targetId) => {
        mockActiveTargets[path] = targetId
        return mockTargetsState(path)
      },
      rescanTargets: async (path) => ({ ...mockTargetsState(path), candidates: [] }),
      pickConfigTarget: async () => ({
        cancelled: true,
        error: null,
        inspection: null,
        targets: null
      }),
      // per-path trees so switching projects visibly swaps the sidebar
      testTree: async (path, _envProfile, targetId) => {
        const outcome = (tree: TestTree, testCount: number): TestListOutcome => ({
          status: 'ready',
          tree,
          diagnostic: null,
          target:
            mockTargetsState(path).targets.find((target) => target.id === tree.targetId) ??
            mockTarget(tree.targetId, testCount)
        })
        if (path === EXTRA_PROJECTS[0].path) {
          return outcome(
            {
              targetId: targetId ?? 'mock-target-admin',
              files: [
                {
                  file: 'users.spec.ts',
                  tests: ['invites a member', 'revokes access', 'changes a role'].map(
                    (title, i) => ({
                      file: 'users.spec.ts',
                      line: 4 + i * 6,
                      column: 3,
                      title,
                      titlePath: [title],
                      projects: PROJECT_NAMES
                    })
                  )
                },
                {
                  file: 'billing.spec.ts',
                  tests: ['upgrades the plan', 'downloads an invoice'].map((title, i) => ({
                    file: 'billing.spec.ts',
                    line: 3 + i * 7,
                    column: 3,
                    title,
                    titlePath: [title],
                    projects: PROJECT_NAMES
                  }))
                }
              ],
              projectNames: PROJECT_NAMES,
              rootDir: 'tests',
              totalTests: 5
            },
            5
          )
        }
        if (path === EXTRA_PROJECTS[1].path) {
          return outcome(
            {
              targetId: targetId ?? 'mock-target-api',
              files: [
                {
                  file: 'health.spec.ts',
                  tests: ['responds 200 on /health', 'rejects bad tokens'].map((title, i) => ({
                    file: 'health.spec.ts',
                    line: 5 + i * 5,
                    column: 3,
                    title,
                    titlePath: [title],
                    projects: ['chromium']
                  }))
                }
              ],
              projectNames: ['chromium'],
              rootDir: 'api/tests',
              totalTests: 2
            },
            2
          )
        }
        return outcome({ ...TREE, targetId: targetId ?? TREE.targetId }, TREE.totalTests)
      }
    },
    run: {
      start: async (config) => {
        runActive = true
        runPath = config.path
        mockRunNumber += 1
        runStartedAt = Date.now()
        pending = [...scheduled]
        emit({ type: 'begin', total: scheduled.length, workers: 4, scheduled })
        // ~60% complete quickly, a few keep running, the rest stay queued
        const quick = pending.splice(0, Math.floor(scheduled.length * 0.6))
        quick.forEach((ref, i) => {
          timers.push(
            setTimeout(() => {
              emit({ type: 'test-begin', startedAt: Date.now(), ...attempt(ref) })
              endInstance(ref, 400 + ((i * 271) % 4200))
            }, 50 + i * 30)
          )
        })
        const runningNow = pending.splice(0, 3)
        runningNow.forEach((ref, i) => {
          timers.push(
            setTimeout(
              () => emit({ type: 'test-begin', startedAt: Date.now(), ...attempt(ref) }),
              300 + i * 200
            )
          )
          pending.unshift(ref) // still owed an end event on finishAll
        })
        return {
          runId: 'mock-run',
          historyRunId: mockRunNumber,
          runNumber: mockRunNumber,
          commitHash: '7f3a2c1'
        }
      },
      stop: async () => {
        finishAll()
        return true
      },
      onEvent: (l) => {
        listener = l
        return () => {
          listener = null
        }
      }
    },
    watch: {
      start: async () => true,
      stop: async () => true,
      onChanged: () => () => {}
    },
    uimode: {
      // resolves with a blank page so the tab's integration bar + theme-matched
      // frame can be pixel-checked in a plain browser (webview renders empty)
      start: async ({ path, targetId }) => {
        if (window.location.hash === '#preview-uimode-error') {
          throw new Error(
            "Error invoking remote method 'uimode:start': Error: UI Mode server exited before it became reachable — Error: Cannot find module '/workspace/node_modules/playwright/lib/program.js'"
          )
        }
        const context = mockUiModeContext(path, targetId)
        return {
          sessionId: 'mock-ui-session',
          targetId,
          ...context,
          launchMode: 'embedded' as const,
          url: 'about:blank',
          port: 43117,
          profile: null,
          playwrightVersion: PROJECT.playwrightVersion ?? null,
          recording: { supported: true, reason: null }
        }
      },
      restart: async (config) => api.uimode.start(config),
      openExternal: async ({ path, targetId }) => {
        const context = mockUiModeContext(path, targetId)
        return {
          sessionId: 'mock-ui-external-session',
          targetId,
          ...context,
          launchMode: 'external' as const,
          profile: null,
          playwrightVersion: PROJECT.playwrightVersion ?? null,
          recording: { supported: false, reason: 'External UI Mode runs are not recorded.' }
        }
      },
      stop: async () => true,
      onEvent: () => () => {}
    },
    settings: {
      get: async () => mockSettings,
      update: async (patch) => {
        mockSettings = { ...mockSettings, ...patch }
        return mockSettings
      },
      // artboard 10: 1.8 GB total → 36% of the 5 GB budget
      storage: async () => ({
        dbBytes: 0,
        artifactBytes: 1_932_735_283,
        artifactCount: 118,
        traceBytes: 1_181_116_006,
        videoBytes: 536_870_912,
        otherBytes: 214_748_365,
        totalRuns: 143,
        oldestKeptAt: Date.now() - 90 * 24 * HOUR
      }),
      clearArtifacts: async () => ({ removedRuns: 0, removedArtifacts: 0, freedBytes: 0 }),
      nodeInfo: async () => ({
        autoPath: '~/.fnm/node-versions/v20.12.2/bin/node',
        autoVersion: 'v20.12.2'
      }),
      onChanged: () => () => {}
    },
    codegen: {
      start: async (config) => {
        codegenListener?.({
          path: config.path,
          event: {
            type: 'ready',
            inspectorUrl: 'http://127.0.0.1:1/',
            pageUrl: config.url ?? 'about:blank',
            browserVersion: '127.0',
            viewport: config.viewport
          }
        })
        // the artboard's recorded session arrives as one live update
        setTimeout(() => {
          codegenListener?.({
            path: config.path,
            event: { type: 'update', code: MOCK_CODEGEN_CODE, actions: MOCK_CODEGEN_ACTIONS }
          })
        }, 60)
        return true
      },
      command: async () => true,
      stop: async () => MOCK_CODEGEN_CODE,
      save: async () => ({ ok: true, code: 0 }),
      onEvent: (l) => {
        codegenListener = l
        return () => {
          codegenListener = null
        }
      }
    },
    report: {
      // never resolves — the preview shows the theme-matched placeholder
      start: () => new Promise(() => {}),
      serveRun: () => new Promise(() => {}),
      stop: async () => true,
      info: async () => ({ exists: true, generatedAt: daysAgoAt(0, 14, 32) }),
      openBrowser: async () => true,
      export: async () => ({ ok: true, code: 0 })
    },
    traces: {
      list: async () => MOCK_TRACES,
      // resolves to an inert stand-in page (after a beat of the loading
      // state) so the run-detail trace chrome and enlarge toggle are demoable
      serve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return {
          url: `data:text/html,${encodeURIComponent(
            '<body style="margin:0;height:100vh;display:grid;place-items:center;font:12px monospace;color:#9a9994;background:#fff">mock trace viewer</body>'
          )}`
        }
      },
      stop: async () => true,
      pickFile: async () => null
    },
    history: {
      runs: async (_path, range) =>
        MOCK_RUNS.filter(
          (run) =>
            (range.from === null || run.startedAt >= range.from) &&
            (range.to === null || run.startedAt <= range.to)
        ),
      runTests: async (_path, runId) => {
        const run = MOCK_RUNS.find((candidate) => candidate.id === runId)
        if (!run) return []
        const shape = MOCK_RUN_SHAPES[run.runNumber]
        return [
          {
            file: 'checkout.spec.ts',
            line: 18,
            title: 'completes guest checkout with saved address',
            status: run.failed > 0 ? ('fail' as const) : ('pass' as const),
            durationMs: run.durationMs ?? 1200,
            attemptCount: shape?.attempts.length ?? 1,
            artifactKinds: shape ? shapeArtifactKinds(shape) : [],
            projectStatuses: shape
              ? shapeProjectStatuses(shape)
              : [
                  {
                    project: 'chromium',
                    status: run.failed > 0 ? ('fail' as const) : ('pass' as const)
                  }
                ],
            firstErrorLine: run.failed > 0 ? 'Expected “Order confirmed” to be visible' : null
          }
        ]
      },
      analytics: async (_path, range) => {
        const selected = MOCK_RUNS.filter(
          (run) =>
            (range.from === null || run.startedAt >= range.from) &&
            (range.to === null || run.startedAt <= range.to)
        )
        const isAllTime = range.from === null && range.to === null
        const executed = selected.reduce(
          (total, run) => total + run.passed + run.failed + run.flaky,
          0
        )
        const durations = selected
          .map((run) => run.durationMs)
          .filter((duration): duration is number => duration !== null && duration > 0)
        return {
          ...MOCK_ANALYTICS,
          passRatePct:
            executed > 0
              ? (selected.reduce((total, run) => total + run.passed, 0) / executed) * 100
              : null,
          passRatePriorPct: null,
          avgDurationMs:
            durations.length > 0
              ? durations.reduce((total, duration) => total + duration, 0) / durations.length
              : null,
          avgDurationPriorMs: null,
          // The detailed trend fixtures represent the retained all-time history.
          // Bounded preview ranges intentionally omit them rather than showing
          // analytics calculated from runs outside the selected calendar window.
          flakyCount: isAllTime ? MOCK_ANALYTICS.flakyCount : 0,
          rangeRuns: selected.length,
          series: selected
            .slice(0, 30)
            .reverse()
            .map((run) => ({
              runNumber: run.runNumber,
              rate:
                run.passed + run.failed + run.flaky > 0
                  ? (run.passed / (run.passed + run.failed + run.flaky)) * 100
                  : null,
              failed: run.failed,
              flaky: run.flaky
            })),
          flakiest: isAllTime ? MOCK_ANALYTICS.flakiest : [],
          regressions: isAllTime ? MOCK_ANALYTICS.regressions : []
        }
      },
      latestTestStatuses: async (path) =>
        path === PROJECT.path ? MOCK_PERSISTED_STATUSES : [],
      testInspector: async (_path, ref) => {
        // never-run empty-state demo: notifications specs have no history
        if (ref.file === 'notifications.spec.ts') return null
        // scripted runs from this session land on top, like real history
        const recorded = sessionRuns.map((run) => sessionRunSummary(run, ref))
        if (ref.title === MOCK_FAILURE_TITLE) {
          return { ...MOCK_INSPECTOR, runs: [...recorded, ...MOCK_INSPECTOR.runs] }
        }
        return {
          ...MOCK_INSPECTOR,
          latest: {
            ...MOCK_INSPECTOR.latest,
            status: 'pass',
            durationMs: 1200
          },
          last20: MOCK_INSPECTOR.last20.map((cell) => ({ ...cell, status: 'pass' })),
          passRatePct: 100,
          flakyPct: 0,
          medianDurationMs: 1100,
          latestFailure: null,
          runs: [
            ...recorded,
            ...MOCK_INSPECTOR.runs.map((run) => ({
              ...run,
              status: 'pass' as const,
              firstErrorLine: null,
              projectStatuses: run.projectStatuses.map((entry) => ({
                ...entry,
                status: 'pass' as const
              }))
            }))
          ]
        }
      },
      testRunDetail: async (_path, runId, ref): Promise<TestRunDetail> => {
        const session = sessionRuns.find((candidate) => candidate.id === runId)
        if (session) {
          const outcome = outcomeFor(ref)
          const shape = sessionShapeFor(ref)
          return {
            run: {
              id: session.id,
              runNumber: session.runNumber,
              trigger: 'manual',
              commitHash: '7f3a2c1',
              startedAt: session.startedAt,
              finishedAt: session.finishedAt,
              durationMs: session.finishedAt - session.startedAt,
              status: 'failed',
              passed: 54,
              failed: 3,
              flaky: 3,
              skipped: 0,
              total: 60
            },
            test: {
              ...ref,
              status: outcome === 'unexpected' ? 'fail' : outcome === 'flaky' ? 'flaky' : 'pass',
              durationMs: outcome === 'expected' ? 1200 : 6900,
              error: outcome === 'unexpected' ? (shape.error ?? null) : null
            },
            captureMode: 'full',
            attempts: mockAttempts(session.id, shape),
            runArtifacts: shape.runArtifacts.map((kind, index) =>
              mockArtifact(session.id, null, kind, index)
            )
          }
        }
        const run = MOCK_RUNS.find((candidate) => candidate.id === runId) ?? MOCK_RUNS[0]
        const failing = ref.title === MOCK_FAILURE_TITLE
        const base = MOCK_RUN_SHAPES[run.runNumber]
        // other tests reuse the same evidence shapes with all-pass attempts
        const shape: MockRunShape | undefined = failing
          ? base
          : base && {
              attempts: base.attempts.map((attempt) => ({
                ...attempt,
                status: 'passed',
                error: null
              })),
              runArtifacts: base.runArtifacts
            }
        return {
          run,
          test: {
            ...ref,
            status: failing ? 'fail' : 'pass',
            durationMs: failing ? 6900 : 1200,
            error: failing ? (shape?.error ?? null) : null
          },
          captureMode: 'full',
          attempts: shape ? mockAttempts(run.id, shape) : [],
          runArtifacts: shape
            ? shape.runArtifacts.map((kind, index) => mockArtifact(run.id, null, kind, index))
            : []
        }
      }
    },
    attachments: {
      open: async () => true,
      // distinct stand-ins per artifact (varied sizes) so the gallery,
      // lightbox navigation, and letterboxing can be pixel-checked
      serve: async (_projectPath, _runId, artifactId) => {
        const sizes: [number, number][] = [
          [800, 500],
          [1280, 720],
          [560, 840]
        ]
        const [w, h] = sizes[artifactId % sizes.length]
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
          `<rect width="${w}" height="${h}" fill="#e4e3df"/>` +
          `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="monospace" ` +
          `font-size="16" fill="#9a9994">mock capture #${artifactId} — ${w}×${h}</text></svg>`
        return {
          url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
          contentType: 'image/svg+xml'
        }
      }
    },
    getPathForFile: () => ''
  }

  window.wrightbench = api
  ;(window as unknown as { __mockFinishRun: () => void }).__mockFinishRun = finishAll
}

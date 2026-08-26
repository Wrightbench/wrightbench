// UI Mode ingest/recorder/reporter tests. Runs with a throwaway HOME (see
// run-tests.mjs) so ~/.wrightbench state is fully isolated.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const main = require('./.build/main.cjs')
const Database = require('better-sqlite3')

const FIXTURE = readFileSync(new URL('./fixtures/uievents-1.62.ndjson', import.meta.url), 'utf8')
const FIXTURE_SID = 'fixture-capture'
const PROJECT = '/w/demo'

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL  ${name}`)
    console.error(err)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const home = homedir()
assert.ok(!home.includes('Users/') || home.includes('wb-test-home'), 'must run with isolated HOME')
const dbPath = join(home, 'test-history.db')
const legacy = new Database(dbPath)
legacy.exec(`
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    commit_hash TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    flaky INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0
  );
  PRAGMA user_version = 1;
`)
legacy.close()
main.openHistoryDb(dbPath)

const fixtureLines = FIXTURE.trim().split('\n')

await test('schema v1 migrates additively to attempt-level history', () => {
  const raw = new Database(dbPath, { readonly: true })
  const version = raw.pragma('user_version', { simple: true })
  assert.equal(version, 2)
  const runColumns = new Set(raw.prepare(`PRAGMA table_info(runs)`).all().map((row) => row.name))
  assert.ok(runColumns.has('project_filter'))
  assert.ok(runColumns.has('capture_mode'))
  assert.ok(runColumns.has('artifact_dir'))
  assert.ok(runColumns.has('report_dir'))
  const tables = new Set(
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name)
  )
  assert.ok(tables.has('test_attempts'))
  assert.ok(tables.has('test_steps'))
  assert.ok(tables.has('test_logs'))
  assert.ok(tables.has('run_artifacts'))
  raw.close()
})

// ---------- wire parsing (adapter) ----------

await test('parseUiEventLine accepts every captured 1.62 line', () => {
  for (const line of fixtureLines) {
    const event = main.parseUiEventLine(line, FIXTURE_SID)
    assert.ok(event !== null, `line rejected: ${line.slice(0, 80)}`)
  }
})

await test('parseUiEventLine rejects foreign sessions, versions, junk', () => {
  const line = fixtureLines[1]
  assert.equal(main.parseUiEventLine(line, 'other-session'), null)
  const wrongVersion = JSON.stringify({ ...JSON.parse(line), v: 99 })
  assert.equal(main.parseUiEventLine(wrongVersion, FIXTURE_SID), null)
  assert.equal(main.parseUiEventLine('not json', FIXTURE_SID), null)
  assert.equal(main.parseUiEventLine('', FIXTURE_SID), null)
  assert.equal(
    main.parseUiEventLine(JSON.stringify({ v: 1, sid: FIXTURE_SID, type: 'mystery' }), FIXTURE_SID),
    null
  )
})

await test('parseUiEventLine caps error text and drops relative attachment paths', () => {
  const big = JSON.stringify({
    v: 1,
    sid: 's',
    type: 'test-end',
    status: 'failed',
    outcome: 'unexpected',
    duration: 5,
    file: 'a.spec.ts',
    line: 3,
    title: 't',
    project: 'chromium',
    error: 'x'.repeat(50_000),
    attachments: [
      { name: 'trace', contentType: 'application/zip', path: 'relative/trace.zip' },
      { name: 'shot', contentType: 'image/png', path: '/abs/shot.png' }
    ]
  })
  const event = main.parseUiEventLine(big, 's')
  assert.ok(event.error.length <= 4000)
  assert.equal(event.attachments.length, 1)
  assert.equal(event.attachments[0].path, '/abs/shot.png')
})

await test('parseUiEventLine preserves exact declaration identity fields', () => {
  const event = main.parseUiEventLine(
    JSON.stringify({
      v: 2,
      sid: 'identity-session',
      type: 'begin',
      total: 1,
      scheduled: [
        {
          file: 'dup.spec.ts',
          line: 5,
          column: 7,
          title: 'can login',
          titlePath: ['admin', 'can login'],
          project: 'chromium'
        }
      ]
    }),
    'identity-session'
  )
  assert.equal(event.scheduled[0].column, 7)
  assert.deepEqual(event.scheduled[0].titlePath, ['admin', 'can login'])
})

// ---------- version gating (adapter) ----------

await test('recording support gate: 1.62 yes; old/unknown/2.x no, with message', () => {
  assert.equal(main.recordingSupportForVersion('1.62.1').supported, true)
  assert.equal(main.recordingSupportForVersion('1.44.0').supported, true)
  const old = main.recordingSupportForVersion('1.39.0')
  assert.equal(old.supported, false)
  assert.match(old.reason, /not supported for Playwright v1\.39\.0/)
  assert.equal(main.recordingSupportForVersion('2.0.0').supported, false)
  assert.equal(main.recordingSupportForVersion(null).supported, false)
  assert.match(main.recordingSupportForVersion(null).reason, /could not be detected/)
})

// ---------- recorder → history rows ----------

function feedRecorder(lines, projectPath, sid, events) {
  const recorder = new main.UiRunRecorder(projectPath, sid, (e) => events.push(e), async () => '7f3a2c1')
  for (const line of lines) {
    const event = main.parseUiEventLine(line, sid)
    if (event) recorder.handleEvent(event)
  }
  return recorder
}

await test('captured session → exactly two history rows with runner semantics', async () => {
  const events = []
  const recorder = feedRecorder(fixtureLines, PROJECT, FIXTURE_SID, events)
  await recorder.flush()

  const runs = main.listRuns(PROJECT, 'all', 10)
  assert.equal(runs.length, 2, 'one row per real run — discovery adds nothing')
  const [runB, runA] = runs // newest first

  // run A: 2 tests × (chromium, firefox), all passed, trace attachments
  assert.equal(runA.trigger, 'ui-mode')
  assert.equal(runA.runNumber, 1)
  assert.equal(runA.total, 2, 'aggregated per test, not per project instance')
  assert.equal(runA.passed, 2)
  assert.equal(runA.status, 'passed')
  assert.equal(runA.commitHash, '7f3a2c1')

  // run B: forced timeout failure
  assert.equal(runB.runNumber, 2)
  assert.equal(runB.failed, 1)
  assert.equal(runB.status, 'failed')

  const raw = new Database(dbPath, { readonly: true })
  const filters = raw
    .prepare(`SELECT project_filter FROM runs WHERE project_path = ? ORDER BY id`)
    .all(PROJECT)
  assert.deepEqual(
    filters.map((r) => r.project_filter),
    ['chromium,firefox', 'chromium']
  )
  const durations = raw
    .prepare(
      `SELECT duration_ms FROM test_results WHERE run_id = ? AND file='example.spec.ts' AND line=8`
    )
    .get(runA.id)
  assert.equal(durations.duration_ms, 1377, 'max duration across projects')
  const failedRow = raw
    .prepare(`SELECT error FROM test_results WHERE run_id = ? AND status='fail'`)
    .get(runB.id)
  assert.match(failedRow.error, /Test timeout of 1ms exceeded/)
  const attempts = raw
    .prepare(`SELECT COUNT(*) AS n FROM test_attempts WHERE run_id IN (?, ?)`)
    .get(runA.id, runB.id)
  assert.equal(attempts.n, 5, 'v1 captures migrate into attempt rows')
  raw.close()

  // This historical capture points at files on another machine. The v1
  // compatibility reader preserves its results, but never records a mutable
  // or missing path as immutable Wrightbench evidence.
  const traces = main.listTraceAttachments(PROJECT, 50)
  assert.equal(traces.length, 0)

  const begins = events.filter((e) => e.type === 'run-begin')
  const ends = events.filter((e) => e.type === 'run-end')
  assert.deepEqual(
    begins.map((e) => e.runNumber),
    [1, 2]
  )
  assert.equal(ends.length, 2)
  assert.equal(ends[0].passed, 2)
  assert.equal(ends[1].failed, 1)
  assert.ok(ends[1].durationMs >= 0)
})

await test('discovery-only stream (no begin) records nothing', async () => {
  const events = []
  const recorder = feedRecorder([], '/w/empty', 's-empty', events)
  recorder.handleEvent(
    main.parseUiEventLine(
      JSON.stringify({ v: 1, sid: 's-empty', type: 'test-begin', file: 'a', line: 1, title: 't', project: '' }),
      's-empty'
    )
  )
  await recorder.flush()
  assert.equal(main.listRuns('/w/empty', 'all', 10).length, 0)
  assert.equal(events.length, 0)
})

await test('flaky retry semantics: passing retry keeps failed attempt error/attachments', async () => {
  const sid = 's-flaky'
  const legacyTrace = join(home, 'legacy-flaky-trace.zip')
  writeFileSync(legacyTrace, 'trace fixture')
  const lines = [
    { v: 1, sid, type: 'begin', total: 1, scheduled: [{ file: 'f.spec.ts', line: 5, title: 'flaky', project: 'chromium' }] },
    { v: 1, sid, type: 'test-end', status: 'failed', outcome: 'unexpected', duration: 100, retry: 0, error: 'boom', attachments: [{ name: 'trace', contentType: 'application/zip', path: legacyTrace }], file: 'f.spec.ts', line: 5, title: 'flaky', project: 'chromium' },
    { v: 1, sid, type: 'test-end', status: 'passed', outcome: 'flaky', duration: 80, retry: 1, file: 'f.spec.ts', line: 5, title: 'flaky', project: 'chromium' },
    { v: 1, sid, type: 'end', status: 'passed' }
  ].map((o) => JSON.stringify(o))
  const events = []
  const recorder = feedRecorder(lines, '/w/flaky', sid, events)
  await recorder.flush()
  const [run] = main.listRuns('/w/flaky', 'all', 10)
  assert.equal(run.flaky, 1)
  assert.equal(run.passed, 0)
  const raw = new Database(dbPath, { readonly: true })
  const row = raw.prepare(`SELECT status, error FROM test_results WHERE run_id = ?`).get(run.id)
  assert.equal(row.status, 'flaky')
  assert.equal(row.error, 'boom', 'failed attempt error survives the passing retry')
  const att = raw.prepare(`SELECT path FROM attachments WHERE run_id = ?`).get(run.id)
  assert.notEqual(att.path, legacyTrace)
  assert.ok(att.path.includes('.wrightbench/artifacts/'))
  assert.ok(existsSync(att.path))
  raw.close()

  const detail = main.testRunDetail('/w/flaky', run.id, {
    file: 'f.spec.ts',
    line: 5,
    title: 'flaky'
  })
  assert.ok(detail)
  assert.equal(detail.attempts.length, 2)
  assert.equal(detail.attempts[0].status, 'failed')
  assert.equal(detail.attempts[1].status, 'passed')
  assert.equal(detail.attempts[0].artifacts.length, 1)
  assert.equal(detail.attempts[0].artifacts[0].kind, 'trace')

  const authorized = main.artifactFileForRun(
    '/w/flaky',
    run.id,
    detail.attempts[0].artifacts[0].id
  )
  assert.equal(authorized.path, detail.attempts[0].artifacts[0].path)
  assert.equal(
    main.artifactFileForRun(
      '/w/another-project',
      run.id,
      detail.attempts[0].artifacts[0].id
    ),
    null,
    'artifact lookup is scoped to its owning project and run'
  )
})

await test('interrupted session finalizes the open run — never left running', async () => {
  const sid = 's-int'
  const lines = [
    { v: 1, sid, type: 'begin', total: 2, scheduled: [
      { file: 'i.spec.ts', line: 1, title: 'one', project: 'chromium' },
      { file: 'i.spec.ts', line: 9, title: 'two', project: 'chromium' }
    ] },
    { v: 1, sid, type: 'test-end', status: 'passed', outcome: 'expected', duration: 42, file: 'i.spec.ts', line: 1, title: 'one', project: 'chromium' }
    // no 'end' — server died / project switched / app quit
  ].map((o) => JSON.stringify(o))
  const events = []
  const recorder = feedRecorder(lines, '/w/interrupted', sid, events)
  await recorder.flush()
  await recorder.finalizeInterrupted()
  const [run] = main.listRuns('/w/interrupted', 'all', 10)
  assert.equal(run.status, 'interrupted')
  assert.equal(run.passed, 1, 'partial results persisted')
  assert.equal(run.total, 1, 'only executed tests recorded')
  const end = events.find((e) => e.type === 'run-end')
  assert.equal(end.status, 'interrupted')
})

// ---------- channel tail (file transport) ----------

await test('channel tails live appends, surviving partial and multibyte writes', async () => {
  const sid = 'chan-1'
  const events = []
  const channel = new main.UiSessionChannel('/w/chan', sid, (e) => events.push(e))
  channel.start()
  assert.ok(existsSync(channel.file), 'session file created under ~/.wrightbench/ui-events')

  const title = 'emoji 🎭 title'
  const lines =
    [
      { v: 1, sid, type: 'begin', total: 1, scheduled: [{ file: 'c.spec.ts', line: 2, title, project: 'chromium' }] },
      { v: 1, sid, type: 'test-end', status: 'passed', outcome: 'expected', duration: 7, file: 'c.spec.ts', line: 2, title, project: 'chromium' },
      { v: 1, sid, type: 'end', status: 'passed' }
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  const bytes = Buffer.from(lines, 'utf8')
  // split inside the emoji's utf-8 bytes AND mid-line
  const cut = bytes.indexOf(Buffer.from('🎭')) + 2
  appendFileSync(channel.file, bytes.subarray(0, cut))
  await sleep(450)
  assert.equal(events.length, 0, 'incomplete line must not be parsed')
  appendFileSync(channel.file, bytes.subarray(cut))
  await waitFor(() => events.some((e) => e.type === 'run-end'), 'run-end from tailed file')
  await channel.stop()
  assert.ok(!existsSync(channel.file), 'stop removes the session file')
  const [run] = main.listRuns('/w/chan', 'all', 10)
  assert.equal(run.passed, 1)
  const raw = new Database(dbPath, { readonly: true })
  const row = raw.prepare(`SELECT title FROM test_results WHERE run_id = ?`).get(run.id)
  assert.equal(row.title, title, 'multibyte title intact across the split')
  raw.close()
})

await test('immediate channel stop drains a complete run before finalizing', async () => {
  const sid = 'chan-immediate-stop'
  const project = '/w/immediate-stop'
  const events = []
  const channel = new main.UiSessionChannel(project, sid, (e) => events.push(e))
  channel.start()
  const lines =
    [
      {
        v: 1,
        sid,
        type: 'begin',
        total: 1,
        scheduled: [
          { file: 'instant.spec.ts', line: 4, title: 'finishes', project: 'chromium' }
        ]
      },
      {
        v: 1,
        sid,
        type: 'test-end',
        status: 'passed',
        outcome: 'expected',
        duration: 11,
        file: 'instant.spec.ts',
        line: 4,
        title: 'finishes',
        project: 'chromium'
      },
      { v: 1, sid, type: 'end', status: 'passed' }
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  appendFileSync(channel.file, lines)
  await channel.stop()

  const [run] = main.listRuns(project, 'all', 10)
  assert.ok(run, 'the drained begin/end pair creates a history row')
  assert.equal(run.status, 'passed')
  assert.equal(run.passed, 1)
  assert.equal(events.filter((e) => e.type === 'run-end').length, 1)
})

// ---------- cross-surface execution ownership ----------

await test('CLI ownership stops UI Mode first and blocks it until release', async () => {
  const stopped = []
  main.setUiModeStopper(async (path) => {
    stopped.push(path)
  })
  const release = await main.beginCliExecution('/w/owned')
  assert.deepEqual(stopped, ['/w/owned'])
  assert.equal(main.isCliExecutionActive('/w/owned'), true)
  assert.throws(() => main.assertUiModeAvailable('/w/owned'), /Tests run is in progress/)
  await assert.rejects(main.beginCliExecution('/w/owned'), /Tests run is already in progress/)
  release()
  assert.equal(main.isCliExecutionActive('/w/owned'), false)
  assert.doesNotThrow(() => main.assertUiModeAvailable('/w/owned'))
  main.setUiModeStopper(async () => {})
})

await test('sweep removes stale session files, keeps fresh ones', () => {
  const dir = main.uiEventsDir()
  mkdirSync(dir, { recursive: true })
  const stale = join(dir, 'stale.ndjson')
  const fresh = join(dir, 'fresh.ndjson')
  writeFileSync(stale, '')
  writeFileSync(fresh, '')
  const old = (Date.now() - 30 * 60 * 60 * 1000) / 1000
  utimesSync(stale, old, old)
  main.sweepUiEventFiles()
  assert.ok(!existsSync(stale))
  assert.ok(existsSync(fresh))
})

// ---------- analytics + filters include ui-mode runs ----------

await test('analytics count ui-mode runs (weekly split labels them manual)', () => {
  const analytics = main.historyAnalytics(PROJECT, 30)
  assert.equal(analytics.totalRuns, 2)
  assert.equal(analytics.runsThisWeek, 2)
  // documented decision: the "N manual · M watch" caption buckets ui-mode
  // with manual because it is user-initiated and not watch-triggered
  assert.equal(analytics.weekManual, 2)
  assert.equal(analytics.weekWatch, 0)
  assert.equal(analytics.filterCounts.all, 2)
  assert.equal(analytics.filterCounts.failed, 1)
  assert.equal(main.listRuns(PROJECT, 'watch', 10).length, 0, 'ui-mode is not watch')
  assert.equal(main.listRuns(PROJECT, 'failed', 10).length, 1)
})

await test('Reports calendar range filters rows and every analytics surface', () => {
  const emptyRange = { from: 0, to: 1 }
  const runs = main.listRuns(PROJECT, 'all', 10, emptyRange)
  const analytics = main.historyAnalytics(PROJECT, 30, emptyRange)
  assert.equal(runs.length, 0)
  assert.equal(analytics.rangeRuns, 0)
  assert.equal(analytics.series.length, 0)
  assert.equal(analytics.passRatePct, null)
  assert.equal(analytics.avgDurationMs, null)
  assert.equal(analytics.flakyCount, 0)
  assert.deepEqual(analytics.flakiest, [])
  assert.deepEqual(analytics.regressions, [])
  assert.equal(analytics.totalRuns, 2, 'retention context remains independent of the calendar')
})

await test('Reports flakiness uses Playwright retry outcomes, not pass/fail alternation', () => {
  const project = '/w/native-flakiness'
  const nativeStatuses = ['pass', 'pass', 'pass', 'flaky']
  const alternatingStatuses = ['pass', 'fail', 'pass', 'fail']

  for (let index = 0; index < nativeStatuses.length; index += 1) {
    const startedAt = Date.now() + index * 100
    const record = main.createRun(project, 'manual', null, startedAt, 'all')
    main.finishRunRecord(record.id, {
      finishedAt: startedAt + 20,
      status: alternatingStatuses[index] === 'fail' ? 'failed' : 'passed',
      results: [
        {
          file: 'native.spec.ts',
          line: 1,
          title: 'passes on retry',
          status: nativeStatuses[index],
          durationMs: 10,
          error: null
        },
        {
          file: 'alternating.spec.ts',
          line: 1,
          title: 'alternates without retries',
          status: alternatingStatuses[index],
          durationMs: 10,
          error: alternatingStatuses[index] === 'fail' ? 'expected value' : null
        }
      ]
    })
  }

  const analytics = main.historyAnalytics(project, 30)
  assert.equal(analytics.flakyCount, 1)
  assert.equal(analytics.flakiest.length, 1)
  assert.equal(analytics.flakiest[0].title, 'passes on retry')
  assert.deepEqual(analytics.flakiest[0].outcomes, ['pass', 'pass', 'pass', 'flaky'])
  assert.equal(analytics.flakiest[0].flakyRuns, 1)
  assert.equal(analytics.flakiest[0].flakyPct, 25)
})

// ---------- reporter transports ----------

const reporterFile = main.reporterPath()

function runReporterChild(env) {
  const script = `
    const R = require(${JSON.stringify(reporterFile)})
    const r = new R()
    r.onBegin({ rootDir: '/w', workers: 1 }, { allTests: () => [] })
    r.onEnd({ status: 'passed' })
  `
  return spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    encoding: 'utf8'
  })
}

await test('reporter default transport: WBEVT on stdout, no session file needed', () => {
  const out = runReporterChild({ WRIGHTBENCH_UI_EVENTS_FILE: '', WRIGHTBENCH_UI_SESSION_ID: '' })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /WBEVT \{"type":"begin"/)
  assert.match(out.stdout, /WBEVT \{"type":"end","status":"passed"\}/)
})

await test('reporter emits column and nested titlePath for declaration identity', () => {
  const script = `
    const R = require(${JSON.stringify(reporterFile)})
    const r = new R()
    const project = { name: 'chromium' }
    const root = { type: 'root', title: '', parent: null, project: () => project }
    const projectSuite = { type: 'project', title: 'chromium', parent: root, project: () => project }
    const fileSuite = { type: 'file', title: 'dup.spec.ts', parent: projectSuite, project: () => project }
    const describe = { type: 'describe', title: 'admin', parent: fileSuite, project: () => project }
    const test = {
      id: 'stable-test',
      title: 'can login',
      location: { file: '/w/dup.spec.ts', line: 5, column: 7 },
      parent: describe
    }
    r.onBegin({ rootDir: '/w', workers: 1 }, { allTests: () => [test] })
  `
  const out = spawnSync(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WRIGHTBENCH_UI_EVENTS_FILE: '',
      WRIGHTBENCH_UI_SESSION_ID: ''
    },
    encoding: 'utf8'
  })
  assert.equal(out.status, 0, out.stderr)
  const begin = JSON.parse(out.stdout.trim().replace(/^WBEVT /, ''))
  assert.equal(begin.scheduled[0].column, 7)
  assert.deepEqual(begin.scheduled[0].titlePath, ['admin', 'can login'])
})

await test('reporter UI transport: NDJSON to the session file, stdout silent', () => {
  const file = join(home, 'reporter-ui-events.ndjson')
  writeFileSync(file, '')
  const out = runReporterChild({
    WRIGHTBENCH_UI_EVENTS_FILE: file,
    WRIGHTBENCH_UI_SESSION_ID: 'sid-x'
  })
  assert.equal(out.status, 0, out.stderr)
  assert.ok(!out.stdout.includes('WBEVT'), 'UI sessions must not leak WBEVT into stdout')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const end = JSON.parse(lines[1])
  assert.equal(end.v, 2)
  assert.equal(end.sid, 'sid-x')
  assert.equal(end.type, 'end')
})

await test('reporter ignores a relative session file path (falls back to stdout)', () => {
  const out = runReporterChild({
    WRIGHTBENCH_UI_EVENTS_FILE: 'relative.ndjson',
    WRIGHTBENCH_UI_SESSION_ID: 'sid-x'
  })
  assert.match(out.stdout, /WBEVT/)
})

// ---------- env building ----------

await test('projectRunEnv applies fixed Node PATH without injecting stored profiles', () => {
  const wbDir = main.wrightbenchDir()
  mkdirSync(wbDir, { recursive: true })
  writeFileSync(
    join(wbDir, 'settings.json'),
    JSON.stringify({
      envProfiles: [{ name: 'staging', env: { FOO: 'bar', PATH: '/custom/bin' } }],
      defaultProfile: 'staging',
      nodeMode: 'fixed',
      nodePath: '/opt/node/bin/node'
    })
  )
  const env = main.projectRunEnv()
  assert.equal(env.FOO, undefined)
  assert.equal(env.PLAYWRIGHT_HTML_OPEN, 'never')
  assert.equal(env.PATH, '/opt/node/bin')
  // what run:start does so project/recipe env can never fake a UI session
  for (const key of main.UI_SESSION_ENV_KEYS) env[key] = ''
  assert.equal(env.PW_TEST_REPORTER, '')
  assert.equal(env.WRIGHTBENCH_UI_EVENTS_FILE, '')
  // and what uimode.ts appends for real sessions wins over project values
  const uiEnv = {
    ...env,
    ...main.uiSessionEnv('/r.cjs', '/e.ndjson', 'sid', '/inline-attachments')
  }
  assert.equal(uiEnv.PW_TEST_REPORTER, '/r.cjs')
})

main.closeHistoryDb()
console.log(failures === 0 ? '\nall uisession tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

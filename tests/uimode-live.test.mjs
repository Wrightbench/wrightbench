// End-to-end: the production uimode.ts session manager against the demo
// fixture project's own Playwright (needs ~/Downloads/demo + network, run via
// `node tests/run-tests.mjs --live`). Drives the test server over its ws
// protocol exactly like Playwright's UI frontend does — Wrightbench itself
// never opens a second client; this stands in for the embedded webview.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const main = require('./.build/main.cjs')

const DEMO = join(process.env.HOME ?? '', 'Downloads', 'demo')
if (!existsSync(join(DEMO, 'node_modules', '@playwright', 'test'))) {
  console.log(`fixture project not found at ${DEMO} — skipping live test`)
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'wb-live-'))
main.openHistoryDb(join(tmp, 'history.db'))

const events = []
main.setUiModeEventSink((payload) => events.push(payload))

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
async function waitFor(fn, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// -- minimal test-server client (what the embedded UI frontend speaks) --
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let lastId = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id) {
      const cb = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) cb.reject(new Error(msg.error))
      else cb.resolve(msg.result)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++lastId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  return { ws, call, open }
}

let info = null
const demoTarget = main.synthesizeLegacyTarget()
const demoProject = {
  id: 'live-demo',
  name: 'demo',
  path: DEMO,
  addedAt: new Date(0).toISOString(),
  targets: [demoTarget],
  activeTargetId: demoTarget.id
}
const request = (profile = null) =>
  main.resolveUiModeRequest(
    { path: DEMO, targetId: demoTarget.id, profile },
    [demoProject]
  )

await test('startUiMode serves the direct embedded URL with recording enabled', async () => {
  info = await main.startUiMode(request())
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/trace\/uiMode\.html\?ws=/)
  assert.equal(info.playwrightVersion, '1.62.1')
  assert.equal(info.recording.supported, true)
  const readyState = events.find((p) => p.event.type === 'state' && p.event.state === 'ready')
  assert.ok(readyState, 'ready state broadcast')
})

await test('second start joins the same session (no second server)', async () => {
  const again = await main.startUiMode(request())
  assert.equal(again.sessionId, info.sessionId)
  assert.equal(again.port, info.port)
})

const wsUrl = decodeURIComponent(info.url.split('?ws=')[1])
const client = connect(wsUrl)
await client.open
await client.call('initialize', { interceptStdio: true, watchTestDirs: false })
await client.call('runGlobalSetup', {})

await test('discovery (listTests) creates no history rows', async () => {
  const result = await client.call('listTests', { projects: [], locations: [] })
  assert.equal(result.status, 'passed')
  await sleep(700)
  assert.equal(main.listRuns(DEMO, 'all', 10).length, 0)
})

await test('a single-test UI run records exactly that test as run #1', async () => {
  const result = await client.call('runTests', {
    projects: ['chromium'],
    locations: [],
    grep: 'has title 1',
    trace: 'off',
    reuseContext: false
  })
  assert.equal(result.status, 'passed')
  const run = await waitFor(
    () => main.listRuns(DEMO, 'all', 10).find((r) => r.runNumber === 1),
    'run #1 in history'
  )
  assert.equal(run.trigger, 'ui-mode')
  assert.equal(run.total, 1)
  assert.equal(run.passed, 1)
  assert.equal(run.status, 'passed')
  const begin = events.find((p) => p.event.type === 'run-begin')
  const end = events.find((p) => p.event.type === 'run-end')
  assert.equal(begin.event.runNumber, 1)
  assert.equal(end.event.passed, 1)
})

await test('repeating the run (watch-style) creates a separate record', async () => {
  await client.call('runTests', {
    projects: ['chromium'],
    locations: [],
    grep: 'has title 1',
    trace: 'off',
    reuseContext: false
  })
  const run = await waitFor(
    () => main.listRuns(DEMO, 'all', 10).find((r) => r.runNumber === 2),
    'run #2 in history'
  )
  assert.equal(run.trigger, 'ui-mode')
  assert.equal(main.listRuns(DEMO, 'all', 10).length, 2)
})

await test('a failing UI run persists a display-ready error', async () => {
  const result = await client.call('runTests', {
    projects: ['chromium'],
    locations: [],
    grep: 'has title 1',
    trace: 'off',
    timeout: 1,
    reuseContext: false
  })
  assert.equal(result.status, 'failed')
  const run = await waitFor(
    () => main.listRuns(DEMO, 'all', 10).find((r) => r.runNumber === 3),
    'run #3 in history'
  )
  assert.equal(run.failed, 1)
  assert.equal(run.status, 'failed')
  const Database = require('better-sqlite3')
  const raw = new Database(join(tmp, 'history.db'), { readonly: true })
  const detail = raw
    .prepare(`SELECT error FROM test_results WHERE run_id = ? AND status='fail'`)
    .get(run.id)
  raw.close()
  assert.match(detail.error, /Test timeout of 1ms exceeded/)
  assert.ok(!detail.error.includes('\u001b'), 'ANSI stripped — display-ready')
})

await test('stopping mid-run finalizes the row as interrupted', async () => {
  // all projects (6 instances) so the stop lands before the run finishes
  const running = client.call('runTests', {
    projects: [],
    locations: [],
    trace: 'off',
    reuseContext: false
  })
  await waitFor(
    () => events.some((p) => p.event.type === 'run-begin' && p.event.runNumber === 4),
    'run #4 begin'
  )
  await assert.rejects(
    main.prepareUiModeForCliRun(DEMO),
    /UI Mode run is in progress/,
    'the Tests runner must not interrupt an active UI Mode run'
  )
  await client.call('stopTests', {})
  await running
  const run = await waitFor(() => {
    const row = main.listRuns(DEMO, 'all', 10).find((r) => r.runNumber === 4)
    return row && row.status !== 'running' ? row : null
  }, 'run #4 finalized')
  assert.equal(run.status, 'interrupted')
})

await test('restart replaces the session; old server dies, env profile respawns', async () => {
  const oldSession = info.sessionId
  const restarted = await main.restartUiMode(request())
  assert.notEqual(restarted.sessionId, oldSession)
  assert.match(restarted.url, /uiMode\.html\?ws=/)
  assert.ok(
    events.some((p) => p.event.type === 'state' && p.event.state === 'restarting'),
    'restarting state broadcast'
  )
  // the first server's ws endpoint must be gone
  const dead = await waitFor(
    () =>
      fetch(info.url, { signal: AbortSignal.timeout(1000) }).then(
        () => false,
        () => true
      ),
    'old server down'
  )
  assert.ok(dead, 'old server no longer reachable')
  info = restarted
})

await test('stopUiMode kills the server and removes the session file', async () => {
  const sessionFile = join(main.uiEventsDir(), `${info.sessionId}.ndjson`)
  assert.ok(existsSync(sessionFile), 'session file exists while live')
  assert.equal(await main.stopUiMode(DEMO), true)
  assert.ok(!existsSync(sessionFile), 'session file removed on stop')
  const dead = await waitFor(
    () =>
      fetch(info.url, { signal: AbortSignal.timeout(1000) }).then(
        () => false,
        () => true
      ),
    'server down'
  )
  assert.ok(dead)
  assert.ok(
    events.some((p) => p.event.type === 'state' && p.event.state === 'stopped'),
    'stopped state broadcast'
  )
})

await test('history rows never end up stuck running', () => {
  for (const run of main.listRuns(DEMO, 'all', 50)) {
    assert.notEqual(run.status, 'running')
  }
})

await test('no Wrightbench files were created inside the user repository', () => {
  const { readdirSync } = require('node:fs')
  const entries = readdirSync(DEMO)
  for (const entry of entries) {
    assert.ok(!/wrightbench|\.ndjson$|reporter\.cjs/i.test(entry), `unexpected file: ${entry}`)
  }
  // playwright.config.ts untouched (no wrapper configs, no rewrites)
  const config = readdirSync(DEMO).filter((e) => e.startsWith('playwright.config'))
  assert.deepEqual(config, ['playwright.config.ts'])
})

client.ws.close()
await main.stopAllUiModeSessions()
main.closeHistoryDb()
rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nall live tests passed' : `\n${failures} live test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

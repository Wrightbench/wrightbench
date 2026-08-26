// Project registry health, removal, and filesystem observation tests.
// Runs with a throwaway HOME (see run-tests.mjs) so ~/.wrightbench is isolated.
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const main = require('./.build/main.cjs')

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
async function waitFor(fn, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(80)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const home = homedir()
assert.ok(home.includes('wb-test-home'), 'must run with isolated HOME')
const work = join(home, 'work')
mkdirSync(work, { recursive: true })

// ---------- health checks ----------

await test('available: an existing readable directory', () => {
  const dir = join(work, 'healthy')
  mkdirSync(dir, { recursive: true })
  assert.deepEqual(main.projectHealth(dir), { state: 'available', reason: null })
})

await test('missing: a path that does not exist', () => {
  const health = main.projectHealth(join(work, 'nope'))
  assert.equal(health.state, 'missing')
  assert.equal(health.reason, 'Folder not found')
})

await test('unreadable: a path that is a file, not a directory', () => {
  const file = join(work, 'a-file.txt')
  writeFileSync(file, 'x')
  const health = main.projectHealth(file)
  assert.equal(health.state, 'unreadable')
  assert.equal(health.reason, 'Path is not a folder')
})

await test('unreadable: a directory without read permission', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    console.log('      (skipped: chmod-based check not reliable here)')
    return
  }
  const dir = join(work, 'locked')
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o000)
  try {
    const health = main.projectHealth(dir)
    assert.equal(health.state, 'unreadable')
  } finally {
    chmodSync(dir, 0o755)
  }
})

// ---------- registry removal ----------

const projectsJson = join(home, '.wrightbench', 'projects.json')

function seedRegistry(entries) {
  mkdirSync(join(home, '.wrightbench'), { recursive: true })
  writeFileSync(projectsJson, JSON.stringify(entries, null, 2))
}

await test('removeProject drops exactly the id, keeps other entries', () => {
  const a = join(work, 'proj-a')
  const b = join(work, 'proj-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  seedRegistry([
    { id: 'id-a', name: 'alpha', path: a, addedAt: 'x' },
    { id: 'id-b', name: 'beta', path: b, addedAt: 'x' }
  ])
  const after = main.removeProject('id-a')
  assert.deepEqual(after.map((p) => p.id), ['id-b'])
  assert.equal(after[0].health.state, 'available')
  assert.deepEqual(main.loadProjects().map((p) => p.id), ['id-b'])
})

await test('removal by id never confuses two projects with the same name', () => {
  const a = join(work, 'same-1')
  const b = join(work, 'same-2')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  seedRegistry([
    { id: 'twin-1', name: 'twin', path: a, addedAt: 'x' },
    { id: 'twin-2', name: 'twin', path: b, addedAt: 'x' }
  ])
  const after = main.removeProject('twin-1')
  assert.deepEqual(after.map((p) => p.id), ['twin-2'])
  assert.equal(after[0].path, b)
})

await test('unrecognized projects.json entries survive removal', () => {
  const a = join(work, 'proj-a')
  seedRegistry([
    { note: 'future-field-entry', keep: true },
    { id: 'id-a', name: 'alpha', path: a, addedAt: 'x' }
  ])
  main.removeProject('id-a')
  const raw = JSON.parse(readFileSync(projectsJson, 'utf8'))
  assert.deepEqual(raw, [{ note: 'future-field-entry', keep: true }])
})

await test('corrupt projects.json is refused, never overwritten', () => {
  writeFileSync(projectsJson, '{not json')
  assert.throws(() => main.removeProject('id-a'), /unreadable/)
  assert.equal(readFileSync(projectsJson, 'utf8'), '{not json')
})

await test('removal touches only Wrightbench state — the project dir is intact', () => {
  const dir = join(work, 'untouchable')
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'tests', 'a.spec.ts'), 'test')
  writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}')
  const before = statSync(join(dir, 'tests', 'a.spec.ts')).mtimeMs
  seedRegistry([{ id: 'keepme', name: 'untouchable', path: dir, addedAt: 'x' }])
  main.removeProject('keepme')
  assert.ok(existsSync(join(dir, 'tests', 'a.spec.ts')))
  assert.ok(existsSync(join(dir, 'playwright.config.ts')))
  assert.equal(statSync(join(dir, 'tests', 'a.spec.ts')).mtimeMs, before)
})

await test('test inspector summarizes outcomes and removal preserves those history rows', () => {
  const dir = join(work, 'with-history')
  mkdirSync(dir, { recursive: true })
  main.openHistoryDb(join(home, 'projects-test.db'))
  const firstStarted = Date.now() - 1000
  const record = main.createRun(dir, 'manual', 'abc1234', firstStarted, 'all')
  main.finishRunRecord(record.id, {
    finishedAt: firstStarted + 10,
    status: 'passed',
    results: [
      { file: 'a.spec.ts', line: 1, title: 't', status: 'pass', durationMs: 10, error: null }
    ]
  })
  const secondStarted = Date.now()
  const second = main.createRun(dir, 'ui-mode', 'def5678', secondStarted, 'all')
  main.finishRunRecord(second.id, {
    finishedAt: secondStarted + 30,
    status: 'failed',
    results: [
      {
        file: 'a.spec.ts',
        line: 1,
        title: 't',
        status: 'fail',
        durationMs: 30,
        error: 'Error: expected visible'
      }
    ]
  })

  const inspector = main.testInspector(dir, { file: 'a.spec.ts', line: 1, title: 't' })
  assert.equal(inspector.latest.runNumber, 2)
  assert.equal(inspector.latest.status, 'fail')
  assert.equal(inspector.latest.trigger, 'ui-mode')
  assert.deepEqual(inspector.last20.map((cell) => cell.status), ['pass', 'fail'])
  assert.equal(inspector.passRatePct, 50)
  assert.equal(inspector.flakyPct, 0, 'pass/fail alternation is not Playwright flakiness')
  assert.equal(inspector.medianDurationMs, 20)
  assert.equal(inspector.latestFailure.runId, second.id)
  assert.equal(main.testInspector(dir, { file: 'missing.spec.ts', line: 1, title: 'x' }), null)
  assert.deepEqual(main.latestTestStatuses(dir), [
    { file: 'a.spec.ts', line: 1, title: 't', status: 'fail', durationMs: 30 }
  ])

  seedRegistry([{ id: 'hist', name: 'with-history', path: dir, addedAt: 'x' }])
  main.removeProject('hist')
  const runs = main.listRuns(dir, 'all', 10)
  assert.equal(runs.length, 2, 'history.db rows survive registry removal')
  assert.deepEqual(main.historyRunTests(dir, second.id), [
    {
      file: 'a.spec.ts',
      line: 1,
      title: 't',
      status: 'fail',
      durationMs: 30,
      attemptCount: 0,
      artifactKinds: [],
      projectStatuses: [],
      firstErrorLine: 'Error: expected visible'
    }
  ])
  assert.equal(main.latestTestStatuses(dir)[0].status, 'fail')
  main.closeHistoryDb()
})

// ---------- filesystem observation ----------

const changedBatches = []
const fileEvents = []
main.setProjectObservationSink({
  onProjectsChanged: (projects) => changedBatches.push(projects),
  onFilesChanged: (path) => fileEvents.push({ path, at: Date.now() })
})

const observedDir = join(work, 'observed')
mkdirSync(join(observedDir, 'tests'), { recursive: true })
writeFileSync(join(observedDir, 'playwright.config.ts'), 'export default {}')
writeFileSync(join(observedDir, 'tests', 'one.spec.ts'), 'test one')
seedRegistry([{ id: 'obs', name: 'observed', path: observedDir, addedAt: 'x' }])
const synced = main.syncProjectObservation()
assert.equal(synced[0].health.state, 'available')
await sleep(400) // let chokidar settle before mutating

await test('a burst of spec edits produces one debounced invalidation', async () => {
  fileEvents.length = 0
  writeFileSync(join(observedDir, 'tests', 'one.spec.ts'), 'test one edited')
  writeFileSync(join(observedDir, 'tests', 'two.spec.ts'), 'test two')
  writeFileSync(join(observedDir, 'tests', 'two.spec.ts'), 'test two edited')
  await waitFor(() => fileEvents.length > 0, 'debounced files-changed')
  await sleep(900) // a second event would land within the next debounce window
  assert.equal(fileEvents.length, 1, `expected one debounced event, got ${fileEvents.length}`)
  assert.equal(fileEvents[0].path, observedDir)
})

await test('noisy directories are ignored', async () => {
  fileEvents.length = 0
  mkdirSync(join(observedDir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(observedDir, 'node_modules', 'pkg', 'x.spec.ts'), 'noise')
  mkdirSync(join(observedDir, 'test-results'), { recursive: true })
  writeFileSync(join(observedDir, 'test-results', 'out.spec.ts'), 'noise')
  await sleep(1200)
  assert.equal(fileEvents.length, 0, 'generated dirs must not trigger refreshes')
})

await test('deleting the project root reports missing', async () => {
  changedBatches.length = 0
  rmSync(observedDir, { recursive: true, force: true })
  const batch = await waitFor(
    () => changedBatches.find((b) => b.find((p) => p.id === 'obs')?.health.state === 'missing'),
    'missing health broadcast'
  )
  assert.equal(batch.find((p) => p.id === 'obs').health.reason, 'Folder not found')
})

await test('recreating the root flips health back to available and invalidates', async () => {
  changedBatches.length = 0
  fileEvents.length = 0
  mkdirSync(join(observedDir, 'tests'), { recursive: true })
  writeFileSync(join(observedDir, 'tests', 'one.spec.ts'), 'test back')
  await waitFor(
    () => changedBatches.find((b) => b.find((p) => p.id === 'obs')?.health.state === 'available'),
    'available health broadcast (recovery poll)',
    10_000
  )
  await waitFor(() => fileEvents.some((e) => e.path === observedDir), 'tree invalidation on recovery')
})

await test('revalidateProjects is a no-op when nothing changed', () => {
  changedBatches.length = 0
  main.revalidateProjects()
  assert.equal(changedBatches.length, 0)
})

await test('unobserved after removal: no further events for the path', async () => {
  main.removeProject('obs')
  main.syncProjectObservation()
  fileEvents.length = 0
  writeFileSync(join(observedDir, 'tests', 'later.spec.ts'), 'test later')
  await sleep(1200)
  assert.equal(fileEvents.length, 0)
})

main.stopProjectObservation()
console.log(failures === 0 ? '\nall projects tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

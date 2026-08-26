// Focused main-process tests for the UI Mode history integration.
//
//   node tests/run-tests.mjs           # unit/ingest tests (isolated HOME)
//   node tests/run-tests.mjs --live    # + end-to-end against the demo fixture
//
// Bundles src/main via esbuild, then runs under `ELECTRON_RUN_AS_NODE=1
// electron` so better-sqlite3 loads with the ABI it was built for (see
// AGENTS.md). The unit run gets a throwaway HOME so nothing touches real
// ~/.wrightbench state; the live run keeps the real HOME (it exercises the
// same paths the app itself uses) but records into an injected temp db.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const live = process.argv.includes('--live')

const bundle = spawnSync(
  join(root, 'node_modules', '.bin', 'esbuild'),
  [
    join(here, 'main-entry.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${join(here, '.build', 'main.cjs')}`,
    '--external:electron',
    '--external:better-sqlite3',
    `--alias:@shared=${join(root, 'src', 'shared')}`
  ],
  { stdio: 'inherit' }
)
if (bundle.status !== 0) process.exit(bundle.status ?? 1)

const runStoreBundle = spawnSync(
  join(root, 'node_modules', '.bin', 'esbuild'),
  [
    join(here, 'run-store-entry.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${join(here, '.build', 'run-store.cjs')}`,
    `--alias:@shared=${join(root, 'src', 'shared')}`
  ],
  { stdio: 'inherit' }
)
if (runStoreBundle.status !== 0) process.exit(runStoreBundle.status ?? 1)

const electron = join(root, 'node_modules', '.bin', 'electron')

function runTest(file, env) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(electron, [join(here, file)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: join(root, 'node_modules'),
      ...env
    }
  })
  return result.status === 0
}

let ok = true

const codegenHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
ok = runTest('codegen.test.mjs', { HOME: codegenHome, USERPROFILE: codegenHome }) && ok
rmSync(codegenHome, { recursive: true, force: true })

const isolatedHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
ok = runTest('uisession.test.mjs', { HOME: isolatedHome, USERPROFILE: isolatedHome }) && ok
rmSync(isolatedHome, { recursive: true, force: true })

const projectsHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
// Electron-as-Node can inherit a very small native watch descriptor pool on
// macOS even when the invoking shell's ulimit is high. Polling keeps this
// filesystem-observation test deterministic; production still uses events.
ok =
  runTest('projects.test.mjs', {
    HOME: projectsHome,
    USERPROFILE: projectsHome,
    CHOKIDAR_USEPOLLING: '1'
  }) && ok
rmSync(projectsHome, { recursive: true, force: true })

const sidebarHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
ok = runTest('sidebar.test.mjs', { HOME: sidebarHome, USERPROFILE: sidebarHome }) && ok
rmSync(sidebarHome, { recursive: true, force: true })

const runStoreHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
ok = runTest('run-store.test.mjs', { HOME: runStoreHome, USERPROFILE: runStoreHome }) && ok
rmSync(runStoreHome, { recursive: true, force: true })

const targetsHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
// polling for the same reason as projects.test.mjs (deterministic fs events)
ok =
  runTest('targets.test.mjs', {
    HOME: targetsHome,
    USERPROFILE: targetsHome,
    CHOKIDAR_USEPOLLING: '1'
  }) && ok
rmSync(targetsHome, { recursive: true, force: true })

const uiTargetHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
ok =
  runTest('uimode-target.test.mjs', {
    HOME: uiTargetHome,
    USERPROFILE: uiTargetHome
  }) && ok
rmSync(uiTargetHome, { recursive: true, force: true })

if (live) {
  ok = runTest('codegen-live.test.mjs', {}) && ok
  const appBuild = spawnSync(join(root, 'node_modules', '.bin', 'electron-vite'), ['build'], {
    stdio: 'inherit',
    cwd: root,
    env: process.env
  })
  ok = appBuild.status === 0 && ok
  ok = runTest('codegen-electron-live.test.mjs', {}) && ok
  ok = runTest('uimode-live.test.mjs', {}) && ok
  const liveHome = mkdtempSync(join(tmpdir(), 'wb-test-home-'))
  // real-Playwright target discovery; skips itself unless WRIGHTBENCH_PW_MODULES is set
  ok = runTest('targets-live.test.mjs', { HOME: liveHome, USERPROFILE: liveHome }) && ok
  rmSync(liveHome, { recursive: true, force: true })
} else {
  console.log('\n(skipping codegen-live.test.mjs — pass --live with WRIGHTBENCH_RECORD_PROJECT=<Playwright project>)')
  console.log('(skipping codegen-electron-live.test.mjs — same flag/project; opens Wrightbench and a headed browser)')
  console.log('\n(skipping uimode-live.test.mjs — pass --live to run it against the demo fixture)')
  console.log('(skipping targets-live.test.mjs — pass --live with WRIGHTBENCH_PW_MODULES=<node_modules with @playwright/test>)')
}

process.exit(ok ? 0 : 1)

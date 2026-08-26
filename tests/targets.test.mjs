// Harness-target discovery tests: script analysis, passive scan, launcher
// resolution, list parsing/classification (injected exec), a real spawn
// integration pipeline against a controlled fake @playwright/test package,
// persistence/migration, and target-aware refresh.
//
// Runs with a throwaway HOME (see run-tests.mjs) so ~/.wrightbench is isolated.
// Nothing here touches the network or downloads packages; the "real"
// integration uses a local fake CLI that mimics `test --list --reporter=json`.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
const work = join(home, 'fixtures')
mkdirSync(work, { recursive: true })

await test('compatibility: imports require Playwright 1.56.0 or newer within 1.x', () => {
  assert.equal(main.MINIMUM_PLAYWRIGHT_VERSION, '1.56.0')
  assert.equal(main.LATEST_VERIFIED_PLAYWRIGHT_VERSION, '1.62.1')
  assert.equal(main.playwrightCompatibility('1.55.1').supported, false)
  assert.equal(main.playwrightCompatibility('1.55.1').reason, 'too-old')
  assert.equal(main.playwrightCompatibility('1.56.0').supported, true)
  assert.equal(main.playwrightCompatibility('1.62.1').supported, true)
  assert.equal(main.playwrightCompatibility('1.63.0-next').supported, true)
  assert.equal(main.playwrightCompatibility('2.0.0').reason, 'unsupported-major')
  assert.equal(main.playwrightCompatibility(null).reason, 'missing')
})

await test('scaffold: five exact verified releases plus isolated experimental tags', async () => {
  assert.deepEqual(main.VERIFIED_PLAYWRIGHT_VERSIONS, [
    '1.62.1',
    '1.61.1',
    '1.60.0',
    '1.59.1',
    '1.58.2'
  ])
  assert.deepEqual(main.EXPERIMENTAL_PLAYWRIGHT_TAGS, ['latest', 'next'])
  assert.equal(main.PLAYWRIGHT_SCAFFOLD_OPTIONS.length, 7)
  assert.equal(main.PLAYWRIGHT_SCAFFOLD_OPTIONS[0].recommended, true)

  assert.deepEqual(main.scaffoldInstallPlan('1.61.1'), {
    value: '1.61.1',
    experimental: false,
    args: ['install', '--save-dev', '--save-exact', '@playwright/test@1.61.1']
  })
  assert.deepEqual(main.scaffoldInstallPlan('next'), {
    value: 'next',
    experimental: true,
    args: ['install', '--save-dev', '--save-exact', '@playwright/test@next']
  })
  assert.equal(main.scaffoldInstallPlan('1.57.0'), null)
  assert.equal(main.scaffoldInstallPlan('latest --ignore-scripts'), null)

  const rejected = join(work, 'rejected-scaffold-version')
  mkdirSync(rejected, { recursive: true })
  const result = await main.scaffoldProject(rejected, '1.57.0', () => {})
  assert.deepEqual(result, {
    ok: false,
    code: null,
    error: 'unsupported Playwright scaffold version'
  })
  assert.equal(existsSync(join(rejected, 'package.json')), false)
})

/** write a tree of files ({ 'rel/path': content }) under root */
function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

// ---- canned JSON report builders (shapes captured from real Playwright) ----

/** one spec entry */
function spec(file, title, line, column, projects) {
  return { title, file, line, column, tests: projects.map((p) => ({ projectName: p })) }
}

/**
 * Playwright ≥1.5x shape: one file suite per file; describes nested as
 * sub-suites; each spec carries every project in tests[].
 */
function reportModern(rootDir, projects, fileSuites, errors = []) {
  return {
    config: {
      rootDir,
      projects: projects.map((p) =>
        typeof p === 'string' ? { name: p, testDir: rootDir } : p
      )
    },
    suites: fileSuites,
    errors
  }
}

function fileSuite(file, specs, subSuites = []) {
  return { title: file, file, specs, suites: subSuites }
}

function describeSuite(file, title, specs, subSuites = []) {
  return { title, file, specs, suites: subSuites }
}

const execOk = (report, noise = '') => async () => ({
  code: 0,
  stdout: `${noise}${JSON.stringify(report)}\n`,
  stderr: '',
  timedOut: false,
  spawnError: null,
  stdoutTruncated: false
})

/** a target descriptor for direct listTarget calls */
function targetFor(fixture, overrides = {}) {
  return {
    id: 't-test',
    cwd: '.',
    configPath: 'playwright.config.js',
    packageDir: '.',
    launcher: 'npm',
    scriptEnv: {},
    extraArgs: [],
    ...overrides
  }
}

/** a fixture with a resolvable fake @playwright/test (resolution precedes exec) */
function fixtureWithFakePlaywright(name, files = {}, version = '1.62.1') {
  const root = join(work, name)
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name, private: true, devDependencies: { '@playwright/test': `^${version}` } }),
    'node_modules/@playwright/test/package.json': JSON.stringify({ name: '@playwright/test', version }),
    'node_modules/@playwright/test/cli.js': FAKE_CLI,
    ...files
  })
  return root
}

/**
 * Fake CLI mimicking `playwright test --list --reporter=json`: behavior per
 * config comes from wb-fake.json next to it. Exercises the real spawn path
 * (node + resolved cli.js + structured argv + env) without any network.
 */
const FAKE_CLI = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const listIndex = args.indexOf('--list')
if (args[0] !== 'test' || listIndex === -1 || (separator !== -1 && listIndex > separator)) {
  console.error('fake cli: unsupported invocation: ' + args.join(' '))
  process.exit(9)
}
const cfgArg = args.find((a) => a.startsWith('--config='))
const configPath = cfgArg ? cfgArg.slice('--config='.length) : null
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'wb-fake.json'), 'utf8'))
const key = configPath ? path.basename(configPath) : '(default)'
const entry = spec[key] || spec['(default)']
if (!entry) {
  console.error('fake cli: no behavior for ' + key)
  process.exit(9)
}
if (entry.requireEnv && !process.env[entry.requireEnv]) {
  console.error('Error: Please provide a correct ' + entry.requireEnv + ' environment value (qa|staging)')
  process.exit(1)
}
if (entry.echoEnv && process.env[entry.echoEnv]) {
  process.stdout.write('env ' + entry.echoEnv + '=' + process.env[entry.echoEnv] + '\\n')
}
if (entry.noise) process.stdout.write(entry.noise + '\\n')
if (entry.stderr) process.stderr.write(entry.stderr + '\\n')
let report = entry.report
if (report && entry.rootDirFromCwd) report = Object.assign({}, report, { config: Object.assign({}, report.config, { rootDir: process.cwd() }) })
if (report) process.stdout.write(JSON.stringify(report) + '\\n')
process.exit(entry.exitCode || 0)
`

/** write per-config behavior for the fake CLI in a fixture */
function fakeBehavior(root, spec) {
  writeFileSync(join(root, 'node_modules/@playwright/test/wb-fake.json'), JSON.stringify(spec))
}

// =====================================================================
// A. package-script analysis (fixtures 12, 13, 14)
// =====================================================================

await test('script: plain "playwright test" adopts with no extra context', () => {
  const a = main.analyzeScript('playwright test')
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.env, {})
  assert.equal(a.configArg, null)
  assert.deepEqual(a.args, [])
})

await test('script: inline env assignment is preserved (fixture 12)', () => {
  const a = main.analyzeScript('TEST_ENV=qa playwright test -c playwright.qa.config.ts')
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.env, { TEST_ENV: 'qa' })
  assert.equal(a.configArg, 'playwright.qa.config.ts')
})

await test('script: compact -cFILE is selected config context, never free argv', () => {
  const a = main.analyzeScript('playwright test -cconfigs/qa.ts --grep @smoke')
  assert.equal(a.kind, 'playwright-test')
  assert.equal(a.configArg, 'configs/qa.ts')
  assert.deepEqual(a.args, ['--grep', '@smoke'])
})

await test('script: cross-env assignments are preserved (fixture 13)', () => {
  const a = main.analyzeScript(
    'cross-env TEST_ENV=qa BASE_URL=https://qa.acme.dev playwright test --config=playwright.qa.config.ts'
  )
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.env, { TEST_ENV: 'qa', BASE_URL: 'https://qa.acme.dev' })
  assert.equal(a.configArg, 'playwright.qa.config.ts')
  assert.deepEqual(a.args, [])
})

await test('script: cross-env-shell remains opaque', () => {
  const a = main.analyzeScript('cross-env-shell TEST_ENV=qa playwright test --project=chromium')
  assert.equal(a.kind, 'opaque')
  assert.match(a.reason, /cross-env-shell/)
})

await test('script: npx/yarn/pnpm wrappers and fixed args survive', () => {
  const a = main.analyzeScript('npx playwright test --project=chromium --workers=2')
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.args, ['--project=chromium', '--workers=2'])
  const b = main.analyzeScript('pnpm exec playwright test')
  assert.equal(b.kind, 'playwright-test')
  const c = main.analyzeScript('yarn playwright test')
  assert.equal(c.kind, 'playwright-test')
})

await test('script: package-manager run aliases are not direct Playwright invocations', () => {
  for (const script of [
    'pnpm run playwright test',
    'yarn run playwright test',
    'bun run playwright test',
    'npx exec playwright test'
  ]) {
    assert.equal(main.analyzeScript(script).kind, 'unrelated', script)
  }
})

await test('script: Wrightbench-owned reporter, trace, and output overrides are dropped', () => {
  const a = main.analyzeScript(
    'playwright test --reporter=junit --trace retain-on-failure --output=repo-results --project=firefox'
  )
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.args, ['--project=firefox'])

  for (const script of [
    'playwright test --reporter',
    'playwright test --trace=',
    'playwright test --output --grep @smoke'
  ]) {
    assert.equal(main.analyzeScript(script).kind, 'opaque', script)
  }
})

await test('script: the -- separator preserves custom argv verbatim', () => {
  const a = main.analyzeScript(
    'playwright test --project=chromium -- --build-path=./out --reporter=custom-value --trace=custom --output custom --list --ui'
  )
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.args, [
    '--project=chromium',
    '--',
    '--build-path=./out',
    '--reporter=custom-value',
    '--trace=custom',
    '--output',
    'custom',
    '--list',
    '--ui'
  ])
})

await test('script: opaque wrappers are classified, never interpreted (fixture 14)', () => {
  // Only a Playwright executable at the launch position is interpreted here;
  // the scan promotes test-ish scripts in Playwright packages to the
  // opaque-launcher state without mistaking ordinary arguments for commands.
  assert.equal(main.analyzeScript('node tools/prepare-and-run-tests.js').kind, 'unrelated')
  assert.equal(main.analyzeScript('node tools/prepare-and-run-tests.js playwright test').kind, 'unrelated')
  assert.equal(main.analyzeScript('npm run seed && playwright test').kind, 'unrelated')
  assert.equal(main.analyzeScript('TEST_ENV=$STAGE playwright test').kind, 'opaque')
  assert.equal(main.analyzeScript('playwright test | tee out.log').kind, 'opaque')
  assert.equal(main.analyzeScript('playwright test|tee out.log').kind, 'opaque')
  assert.equal(main.analyzeScript('playwright>results.log').kind, 'opaque')
})

await test('script: Playwright-branded filenames and extension ids are unrelated', () => {
  for (const script of [
    'code --uninstall-extension ms-playwright.playwright && code --install-extension playwright-*.vsix',
    'code --uninstall-extension ms-playwright.playwright',
    'code-insiders --uninstall-extension ms-playwright.playwright && code-insiders --install-extension playwright-*.vsix',
    'code-insiders --uninstall-extension ms-playwright.playwright',
    'echo playwright',
    'code --install-extension playwright',
    'node tool.js playwright'
  ]) {
    assert.equal(main.analyzeScript(script).kind, 'unrelated', script)
  }
})

await test('script: quoted grep regex operators remain structured arguments', () => {
  const monitor = main.analyzeScript(
    'playwright test --project=chromium --grep @monitor --grep-invert "@stateful|@destructive|@visual"'
  )
  assert.equal(monitor.kind, 'playwright-test')
  assert.deepEqual(monitor.args, [
    '--project=chromium',
    '--grep',
    '@monitor',
    '--grep-invert',
    '@stateful|@destructive|@visual'
  ])

  const singleQuoted = main.analyzeScript("playwright test --grep '@smoke|@checkout'")
  assert.equal(singleQuoted.kind, 'playwright-test')
  assert.deepEqual(singleQuoted.args, ['--grep', '@smoke|@checkout'])
})

await test('script: real shell composition and expansion remain opaque', () => {
  const unsafe = [
    'playwright test | tee out.log',
    'playwright test && npm run cleanup',
    'playwright test; npm run cleanup',
    'playwright test > results.log',
    'playwright test $(node choose-tests.js)',
    'playwright test "$TEST_PATTERN"',
    'playwright test "`node choose-tests.js`"'
  ]
  for (const script of unsafe) {
    assert.equal(main.analyzeScript(script).kind, 'opaque', script)
  }
})

await test('script: UI/list/help/version and non-test playwright scripts are not targets', () => {
  for (const script of [
    'playwright test --ui',
    'playwright test --ui-port=0',
    'playwright test --list',
    'playwright test --help',
    'playwright test -h',
    'playwright test --version',
    'playwright test -V'
  ]) {
    assert.equal(main.analyzeScript(script).kind, 'playwright-other', script)
  }
  const configuredUi = main.analyzeScript(
    'playwright test --ui --config=config/ui.playwright.ts'
  )
  assert.equal(configuredUi.kind, 'playwright-other')
  assert.equal(configuredUi.configArg, 'config/ui.playwright.ts')
  assert.equal(main.analyzeScript('playwright show-report').kind, 'playwright-other')
  assert.equal(main.analyzeScript('vitest run').kind, 'unrelated')
})

await test('script: quoted values tokenize; unbalanced quotes are opaque', () => {
  const a = main.analyzeScript("BASE_URL='https://qa.acme.dev' playwright test")
  assert.equal(a.kind, 'playwright-test')
  assert.deepEqual(a.env, { BASE_URL: 'https://qa.acme.dev' })
  for (const script of [
    "playwright test 'unbalanced",
    "FOO=bar playwright test 'unbalanced",
    "cross-env FOO=bar playwright test 'unbalanced",
    "npx playwright test 'unbalanced"
  ]) {
    assert.equal(main.analyzeScript(script).kind, 'opaque', script)
  }
  assert.equal(main.analyzeScript('code "playwright').kind, 'unrelated')
})

await test('script: recipe classification keeps meaningful context only', () => {
  assert.equal(main.hasRecipeContext({}, ['--project=chromium', '--headed', '--debug']), false)
  assert.equal(main.hasRecipeContext({}, ['--project', 'chromium']), false)
  assert.equal(main.hasRecipeContext({ TEST_ENV: 'qa' }, ['--project=chromium']), true)
  assert.equal(main.hasRecipeContext({}, ['--project=chromium', '--grep', '@monitor']), true)
  assert.equal(main.hasRecipeContext({}, ['--project=chromium', '--', '--tenant=qa']), true)
  assert.equal(main.hasReservedRunArgs(['--config=outside.ts']), true)
  assert.equal(main.hasReservedRunArgs(['-coutside.ts']), true)
  assert.equal(main.hasReservedRunArgs(['--list=ignored']), true)
  assert.equal(main.hasReservedRunArgs(['--help=ignored']), true)
  assert.equal(main.hasReservedRunArgs(['--version=ignored']), true)
  assert.equal(main.hasReservedRunArgs(['--grep', '@monitor', '--', '--config=custom-value']), false)
})

// =====================================================================
// B. path normalization pure units (fixture 25)
// =====================================================================

await test('windows-style separators normalize to POSIX (fixture 25)', () => {
  assert.equal(main.toPosixRelative('tests\\e2e\\a.spec.ts'), 'tests/e2e/a.spec.ts')
  assert.equal(main.toPosixRelative(''), '.')
  assert.equal(main.resolveConfigArg('packages\\web', '.\\configs\\pw.config.ts'), 'packages/web/configs/pw.config.ts')
  assert.equal(main.resolveConfigArg('.', './e2e/playwright.config.ts'), 'e2e/playwright.config.ts')
  assert.equal(main.resolveConfigArg('apps/web', '../shared/pw.config.ts'), 'apps/shared/pw.config.ts')
  // escaping the workspace root is unresolvable — never remapped inside
  assert.equal(main.resolveConfigArg('.', '../shared/pw.config.ts'), null)
  assert.equal(main.resolveConfigArg('a', '../../pw.config.ts'), null)
  // Absolute config arguments must not be reinterpreted using the host OS's
  // path grammar when a project was authored on another platform.
  assert.equal(main.resolveConfigArg('.', '/tmp/playwright.config.ts'), null)
  assert.equal(main.resolveConfigArg('.', 'C:\\work\\playwright.config.ts'), null)
  assert.equal(main.resolveConfigArg('.', '\\\\server\\share\\playwright.config.ts'), null)
})

// =====================================================================
// C. passive scan (fixtures 1, 7, 8, 9, 14, 24 at the scan level)
// =====================================================================

await test('scan: conventional root config becomes one candidate (fixture 1)', () => {
  const root = join(work, 'scan-conventional')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '^1.62.1' } }),
    'playwright.config.ts': 'export default {}',
    'tests/a.spec.ts': 'test'
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 1)
  assert.equal(scan.candidates[0].configPath, 'playwright.config.ts')
  assert.equal(scan.candidates[0].cwd, '.')
  assert.equal(scan.candidates[0].source, 'config')
})

await test('import inspection is passive, configuration-only, and launch-critical', async () => {
  const root = join(work, 'inspect-lean-import')
  const launchMarker = join(root, 'cli-was-launched')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'lean-import',
      private: true,
      devDependencies: { '@playwright/test': '^1.62.1' },
      scripts: { 'test:smoke': 'playwright test --grep smoke' }
    }),
    'playwright.config.ts': 'export default {}',
    'node_modules/@playwright/test/package.json': JSON.stringify({
      name: '@playwright/test',
      version: '1.62.1'
    }),
    'node_modules/@playwright/test/cli.js': `require('node:fs').writeFileSync(${JSON.stringify(launchMarker)}, 'launched')`,
    'packages/toolkit/package.json': JSON.stringify({
      name: 'toolkit',
      devDependencies: { '@playwright/test': '^1.62.1' }
    })
  })

  const inspection = await main.inspectProject(root)
  assert.equal(existsSync(launchMarker), false, 'import never executes the Playwright CLI')
  assert.equal(inspection.playwrightVersion, '1.62.1')
  assert.equal(inspection.targets.length, 1, 'recipes and redundant dependency defaults stay hidden')
  assert.equal(inspection.targets[0].source, 'config')
  assert.equal(inspection.targets[0].configPath, 'playwright.config.ts')
  assert.equal(inspection.targets[0].status, 'not-validated')
  assert.deepEqual(inspection.targets[0].recording, { supported: true, reason: null })

  const cached = main.cachedDiscovery(root)
  assert.ok(cached, 'the complete trusted scan is cached for projects:add')
  assert.ok(cached.targets.some((target) => target.source === 'script'))
  assert.equal(cached.suppressedTargetIds.length, 1)

  const importTarget = main.resolveImportTarget(
    root,
    cached,
    inspection.recommendedTargetId
  )
  assert.equal(importTarget.source, 'config')
  assert.equal(importTarget.playwrightVersion, '1.62.1')

  writeFileSync(
    join(root, 'node_modules/@playwright/test/package.json'),
    JSON.stringify({ name: '@playwright/test', version: '1.55.1' })
  )
  assert.throws(
    () => main.resolveImportTarget(root, cached, inspection.recommendedTargetId),
    /too old.*1\.56\.0/s,
    'projects:add rejects an installed Playwright below the product minimum'
  )
  writeFileSync(
    join(root, 'node_modules/@playwright/test/package.json'),
    JSON.stringify({ name: '@playwright/test', version: '1.62.1' })
  )

  const recipe = cached.targets.find((target) => target.source === 'script')
  assert.ok(recipe)
  assert.throws(
    () => main.resolveImportTarget(root, cached, recipe.id),
    /valid Playwright configuration/,
    'a renderer cannot import a hidden recipe as the base configuration'
  )

  rmSync(join(root, 'node_modules/@playwright/test'), { recursive: true, force: true })
  assert.throws(
    () => main.resolveImportTarget(root, cached, inspection.recommendedTargetId),
    /Install project dependencies, then retry detection/,
    'projects:add rechecks the local dependency instead of trusting stale inspection data'
  )
})

await test('scan: nested workspace package config is found from the root (fixture 7)', () => {
  const root = join(work, 'scan-monorepo')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    'pnpm-lock.yaml': '',
    'packages/web/package.json': JSON.stringify({ name: 'web', devDependencies: { '@playwright/test': '^1.62.1' } }),
    'packages/web/playwright.config.ts': 'export default {}',
    'packages/web/e2e/a.spec.ts': 'test',
    'packages/lib/package.json': JSON.stringify({ name: 'lib' })
  })
  const scan = main.scanWorkspace(root)
  const web = scan.candidates.find((c) => c.cwd === 'packages/web')
  assert.ok(web, 'nested package candidate found')
  assert.equal(web.configPath, 'packages/web/playwright.config.ts')
  assert.equal(web.packageDir, 'packages/web')
  assert.equal(web.launcher, 'pnpm', 'lockfile at the root decides the launcher')
})

await test('scan: multiple configs are separate candidates (fixture 8)', () => {
  const root = join(work, 'scan-multi')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x' }),
    'playwright.config.ts': 'export default {}',
    'playwright.qa.config.ts': 'export default {}',
    'e2e/playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  const configs = scan.candidates.map((c) => c.configPath).sort()
  assert.deepEqual(configs, [
    'e2e/playwright.config.ts',
    'playwright.config.ts',
    'playwright.qa.config.ts'
  ])
})

await test('discovery: reports safe env setup hints without reading template values', () => {
  const root = join(work, 'env-template-metadata')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'mono' }),
    '.env.example': 'ROOT_SECRET=must-not-be-read',
    'packages/e2e/playwright.config.ts': 'export default {}',
    'packages/e2e/.env.example': 'CLIENT_SECRET=must-not-cross-ipc',
    'packages/e2e/.env.sample': 'BASE_URL=https://example.test',
    'packages/e2e/.env.template': 'TENANT_ID=replace-me',
    'packages/e2e/custom.env.example': 'CUSTOM=not-a-conventional-template'
  })
  const hints = main.environmentSetupHintsFor(root, {
    cwd: 'packages/e2e',
    configPath: 'packages/e2e/playwright.config.ts',
    packageDir: 'packages/e2e'
  })
  assert.deepEqual(hints, [
    {
      templatePath: 'packages/e2e/.env.example',
      destinationPath: 'packages/e2e/.env'
    },
    {
      templatePath: 'packages/e2e/.env.sample',
      destinationPath: 'packages/e2e/.env'
    },
    {
      templatePath: 'packages/e2e/.env.template',
      destinationPath: 'packages/e2e/.env'
    }
  ])
  assert.ok(
    hints.every((hint) => !JSON.stringify(hint).includes('SECRET=')),
    'returns paths, never values'
  )
})

await test('discovery: env hints search package context and stop when .env already exists', () => {
  const root = join(work, 'env-template-package-context')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'mono' }),
    'packages/e2e/config/playwright.config.ts': 'export default {}',
    'packages/e2e/.env.example': 'BASE_URL=https://example.test'
  })
  const target = {
    cwd: 'packages/e2e',
    configPath: 'packages/e2e/config/playwright.config.ts',
    packageDir: 'packages/e2e'
  }
  assert.deepEqual(main.environmentSetupHintsFor(root, target), [
    {
      templatePath: 'packages/e2e/.env.example',
      destinationPath: 'packages/e2e/.env'
    }
  ])

  writeFiles(root, { 'packages/e2e/.env': 'REAL_SECRET=not-inspected' })
  assert.deepEqual(main.environmentSetupHintsFor(root, target), [])
})

await test('discovery: env hints reject template and directory symlinks outside workspace', () => {
  const root = join(work, 'env-template-symlink-safety')
  const outside = join(work, 'env-template-outside')
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'mono' }),
    'packages/e2e/playwright.config.ts': 'export default {}'
  })
  writeFiles(outside, {
    '.env.example': 'OUTSIDE_SECRET=must-not-be-discovered',
    'playwright.config.ts': 'export default {}'
  })
  symlinkSync(join(outside, '.env.example'), join(root, 'packages/e2e/.env.example'))
  symlinkSync(outside, join(root, 'escaped'))

  assert.deepEqual(
    main.environmentSetupHintsFor(root, {
      cwd: 'packages/e2e',
      configPath: 'packages/e2e/playwright.config.ts',
      packageDir: 'packages/e2e'
    }),
    []
  )
  assert.deepEqual(
    main.environmentSetupHintsFor(root, {
      cwd: 'escaped',
      configPath: 'escaped/playwright.config.ts',
      packageDir: 'escaped'
    }),
    []
  )
})

await test('scan: safe script context stays distinct while exact plain duplicates collapse (fixture 9)', () => {
  const root = join(work, 'scan-scripts')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:e2e': 'playwright test',
        'test:qa': 'cross-env TEST_ENV=qa playwright test --config=playwright.qa.config.ts'
      }
    }),
    'playwright.config.ts': 'export default {}',
    'playwright.qa.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  // test:e2e adds nothing beyond the conventional config → collapsed;
  // test:qa carries env, so it remains alongside the independently valid
  // plain config instead of silently replacing it.
  const qa = scan.candidates.find((c) => c.scriptName === 'test:qa')
  assert.ok(qa, 'qa script candidate exists')
  assert.equal(qa.configPath, 'playwright.qa.config.ts')
  assert.deepEqual(qa.scriptEnv, { TEST_ENV: 'qa' })
  assert.ok(!scan.candidates.some((c) => c.scriptName === 'test:e2e'), 'no-context script collapsed')
  assert.ok(
    scan.candidates.some((c) => c.source === 'config' && c.configPath === 'playwright.qa.config.ts'),
    'plain config remains available for full-suite discovery'
  )
  assert.ok(
    scan.candidates.some((c) => c.source === 'config' && c.configPath === 'playwright.config.ts'),
    'conventional config candidate remains'
  )
})

await test('scan: distinct argv contexts survive while semantic duplicates collapse', () => {
  const root = join(work, 'scan-variants')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        test: 'cross-env ENV=qa npx playwright test',
        'test:api': 'cross-env ENV=qa npx playwright test --grep @API --workers=1 --project=API',
        'test:smoke': 'cross-env ENV=qa npx playwright test --grep @Smoke',
        'test:smoke-copy': 'cross-env ENV=qa npx playwright test --grep @Smoke',
        'test:staging': 'cross-env ENV=staging npx playwright test',
        smoke: 'playwright test --grep @smoke'
      }
    }),
    'playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  const names = scan.candidates.map((c) => c.scriptName ?? c.configPath).sort()
  assert.deepEqual(names, [
    'playwright.config.ts',
    'smoke',
    'test',
    'test:api',
    'test:smoke',
    'test:staging'
  ])
  const general = scan.candidates.find((c) => c.scriptName === 'test')
  assert.deepEqual(general.extraArgs, [])
  assert.ok(
    !scan.candidates.some((c) => c.scriptName === 'test:smoke-copy'),
    'identical env and argv collapse to one labeled target'
  )
})

await test('scan: an args-only script remains alongside the full-suite config', () => {
  const root = join(work, 'scan-argsonly')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: { smoke: 'playwright test --grep @smoke' }
    }),
    'playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 2)
  assert.ok(scan.candidates.some((c) => c.source === 'config'), 'the plain config remains')
  assert.ok(scan.candidates.some((c) => c.scriptName === 'smoke'), 'the filtered context remains')
})

await test('scan: a script with an absolute config stays opaque', () => {
  const root = join(work, 'scan-absolute-config')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: { 'test:e2e': 'playwright test --config=/tmp/playwright.config.ts' }
    })
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 0)
  assert.deepEqual(scan.opaqueScripts, [
    {
      packageDir: '.',
      scriptName: 'test:e2e',
      reason: 'references a config outside this folder'
    }
  ])
})

await test('scan: project aliases and headed/debug modes are not separate inventories', () => {
  const root = join(work, 'scan-run-modes')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:chromium': 'playwright test --project=chromium',
        'test:headed': 'playwright test --headed --project=chromium',
        'test:debug': 'playwright test --debug --project=chromium',
        'test:visual': 'playwright test --project=chromium --grep @visual'
      }
    }),
    'playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.deepEqual(
    scan.candidates.map((candidate) => candidate.scriptName ?? candidate.configPath),
    ['playwright.config.ts', 'test:visual']
  )
})

await test('scan: non-run test modes expose a referenced custom config without a recipe', () => {
  const root = join(work, 'scan-non-run-config')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:list': 'playwright test --list --config=config/list.ts'
      }
    }),
    'config/list.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.deepEqual(
    scan.candidates.map((candidate) => [
      candidate.source,
      candidate.scriptName,
      candidate.configPath
    ]),
    [['config', null, 'config/list.ts']]
  )
})

await test('scan: a config-less script in a hoisted package still contributes its base config', () => {
  const root = join(work, 'scan-hoisted-script')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'root' }),
    'packages/web/package.json': JSON.stringify({
      name: 'web',
      scripts: { 'test:chromium': 'playwright test --project=chromium' }
    })
  })
  const scan = main.scanWorkspace(root)
  const web = scan.candidates.filter((candidate) => candidate.cwd === 'packages/web')
  assert.equal(web.length, 1)
  assert.equal(web[0].source, 'config')
  assert.equal(web[0].configPath, null)
})

await test('scan: duplicate script aliases do not consume the candidate cap', () => {
  const root = join(work, 'scan-alias-cap')
  rmSync(root, { recursive: true, force: true })
  const scripts = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `test:chromium:${index}`,
      'playwright test --project=chromium'
    ])
  )
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x', scripts }),
    'playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 1)
  assert.equal(scan.candidates[0].configPath, 'playwright.config.ts')
  assert.equal(scan.truncated, false)
})

await test('scan: implicit library packages cannot crowd a later explicit config out of the cap', () => {
  const libraryWorkspaces = Array.from(
    { length: 30 },
    (_, index) => `packages/a-library-${String(index).padStart(2, '0')}`
  )
  const libraryFiles = Object.fromEntries(
    libraryWorkspaces.map((packageDir, index) => [
      `${packageDir}/package.json`,
      JSON.stringify({
        name: `library-${index}`,
        devDependencies: { '@playwright/test': '^1.62.1' }
      })
    ])
  )
  const root = fixtureWithFakePlaywright('scan-implicit-cap-priority', {
    'package.json': JSON.stringify({
      name: 'mono',
      private: true,
      workspaces: [...libraryWorkspaces, 'packages/z-e2e']
    }),
    ...libraryFiles,
    'packages/z-e2e/package.json': JSON.stringify({ name: 'e2e', private: true }),
    'packages/z-e2e/playwright.config.ts': 'export default {}'
  })

  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 24)
  assert.equal(scan.truncated, true)
  assert.ok(
    scan.candidates.some(
      (candidate) => candidate.configPath === 'packages/z-e2e/playwright.config.ts'
    ),
    'the later explicit config replaces an implicit candidate at the cap'
  )
  assert.equal(
    scan.candidates.filter((candidate) => candidate.implicitConfigless).length,
    23
  )
})

await test('scan: script-only custom configs also surface as configurations', () => {
  const root = join(work, 'scan-script-config')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:qa': 'TEST_ENV=qa playwright test -cconfig/qa.ts --grep @smoke'
      }
    }),
    'config/qa.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.ok(
    scan.candidates.some(
      (candidate) => candidate.source === 'config' && candidate.configPath === 'config/qa.ts'
    ),
    'the complete config inventory is independent from the filtered recipe'
  )
  const recipe = scan.candidates.find((candidate) => candidate.scriptName === 'test:qa')
  assert.ok(recipe)
  assert.equal(recipe.configPath, 'config/qa.ts')
  assert.deepEqual(recipe.extraArgs, ['--grep', '@smoke'])
})

await test('scan: a quoted grep alternation is adopted instead of reported opaque', () => {
  const root = join(work, 'scan-quoted-grep')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:monitor':
          'playwright test --project=chromium --grep @monitor --grep-invert "@stateful|@destructive|@visual"'
      }
    }),
    'playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  const monitor = scan.candidates.find((c) => c.scriptName === 'test:monitor')
  assert.ok(monitor, 'quoted regex script becomes a harness candidate')
  assert.deepEqual(monitor.extraArgs, [
    '--project=chromium',
    '--grep',
    '@monitor',
    '--grep-invert',
    '@stateful|@destructive|@visual'
  ])
  assert.ok(!scan.opaqueScripts.some((s) => s.scriptName === 'test:monitor'))
})

await test('scan: opaque scripts are reported, not adopted (fixture 14)', () => {
  const root = join(work, 'scan-opaque')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      devDependencies: { '@playwright/test': '^1.62.1' },
      scripts: { 'test:e2e': 'node tools/prepare-and-run-tests.js playwright test' }
    }),
    'tools/prepare-and-run-tests.js': 'run'
  })
  const scan = main.scanWorkspace(root)
  assert.ok(
    !scan.candidates.some((candidate) => candidate.source === 'script'),
    'the custom wrapper never becomes a runnable recipe'
  )
  assert.equal(scan.opaqueScripts.length, 1)
  assert.equal(scan.opaqueScripts[0].scriptName, 'test:e2e')
})

await test('scan: unrelated Playwright-branded VS Code scripts stay silent', () => {
  const root = join(work, 'scan-playwright-brand-only')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'playwright-vscode-like',
      devDependencies: { '@playwright/test': '^1.62.1' },
      scripts: {
        code:
          'code --uninstall-extension ms-playwright.playwright && code --install-extension playwright-*.vsix',
        uncode: 'code --uninstall-extension ms-playwright.playwright',
        'code-insiders':
          'code-insiders --uninstall-extension ms-playwright.playwright && code-insiders --install-extension playwright-*.vsix',
        'uncode-insiders': 'code-insiders --uninstall-extension ms-playwright.playwright',
        'test:custom': 'node tools/prepare-and-run-tests.js',
        'test:pipeline': 'npm run prep && playwright test'
      }
    })
  })
  const scan = main.scanWorkspace(root)
  assert.deepEqual(scan.opaqueScripts, [
    {
      packageDir: '.',
      scriptName: 'test:custom',
      reason: 'is a custom launcher Wrightbench cannot analyze'
    },
    {
      packageDir: '.',
      scriptName: 'test:pipeline',
      reason: 'is a custom launcher Wrightbench cannot analyze'
    }
  ])
})

await test('scan and config picker reject symlinks that escape the workspace', async () => {
  const outside = fixtureWithFakePlaywright('symlink-outside', {
    'playwright.config.js': 'module.exports = {}'
  })
  const root = join(work, 'symlink-workspace')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, { 'package.json': JSON.stringify({ name: 'inside' }) })
  symlinkSync(outside, join(root, 'linked'), 'dir')

  const scan = main.scanWorkspace(root)
  assert.ok(
    !scan.candidates.some((candidate) => candidate.configPath?.startsWith('linked/')),
    'passive scanning never crosses the canonical workspace boundary'
  )
  const picked = main.buildUserConfigTarget(root, join(root, 'linked', 'playwright.config.js'))
  assert.match(picked.error, /outside this workspace/)

  const result = await main.listTarget(
    {
      workspaceRoot: root,
      target: targetFor(root, {
        cwd: 'linked',
        packageDir: 'linked',
        configPath: 'linked/playwright.config.js'
      }),
      profileEnv: {}
    },
    async () => {
      throw new Error('escaped targets must be rejected before execution')
    }
  )
  assert.equal(result.status, 'unsupported-launcher')
  assert.match(result.diagnostic.summary, /outside the imported workspace/)
})

await test('scan: scripts whose spaced or compact -c escapes are surfaced, never adopted', () => {
  const root = join(work, 'scan-escape')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: {
        'test:shared': 'playwright test -c ../shared/playwright.config.ts',
        'test:compact': 'playwright test -c../shared/playwright.config.ts'
      }
    })
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 0)
  assert.equal(scan.opaqueScripts.length, 2)
  for (const script of scan.opaqueScripts) assert.match(script.reason, /outside this folder/)
})

await test('scan: node_modules and generated dirs are never scanned', () => {
  const root = join(work, 'scan-ignored')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x' }),
    'playwright.config.ts': 'export default {}',
    'node_modules/dep/playwright.config.ts': 'export default {}',
    'test-results/playwright.config.ts': 'export default {}',
    'dist/playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 1)
  assert.equal(scan.candidates[0].configPath, 'playwright.config.ts')
})

await test('scan: paths containing spaces survive intact (fixture 24)', () => {
  const root = join(work, 'space project')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x' }),
    'My Tests/playwright.config.ts': 'export default {}'
  })
  const scan = main.scanWorkspace(root)
  assert.equal(scan.candidates.length, 1)
  assert.equal(scan.candidates[0].configPath, 'My Tests/playwright.config.ts')
})

// =====================================================================
// D. launcher resolution
// =====================================================================

await test('launcher: packageManager beats lockfile, lockfile beats fallback', () => {
  const root = join(work, 'launch')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x', packageManager: 'bun@1.1.0' }),
    'yarn.lock': ''
  })
  assert.equal(main.detectLauncher(root, root), 'bun')
  writeFiles(root, { 'package.json': JSON.stringify({ name: 'x' }) })
  assert.equal(main.detectLauncher(root, root), 'yarn')
  const nested = join(root, 'packages', 'a')
  writeFiles(root, { 'packages/a/package.json': JSON.stringify({ name: 'a' }) })
  assert.equal(main.detectLauncher(nested, root), 'yarn', 'walks up to the workspace root')
  assert.equal(main.launcherFromPackageManagerField('pnpm@9.0.0'), 'pnpm')
  assert.equal(main.launcherFromPackageManagerField('weird@1'), null)
})

// =====================================================================
// E. parsing + classification with injected exec
//    (fixtures 2, 3, 4, 5, 6, 17, 18, 19, 20, 21, 25-report)
// =====================================================================

const parseFixture = fixtureWithFakePlaywright('parse-host')

await test('list: .test.ts files come straight from the report — no Wrightbench glob (fixture 2)', async () => {
  const rootDir = parseFixture
  const report = reportModern(rootDir, ['chromium'], [
    fileSuite('checkout.test.ts', [spec('checkout.test.ts', 'adds to cart', 4, 1, ['chromium'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.tree.files.map((f) => f.file), ['checkout.test.ts'])
})

await test('list: custom *.e2e.ts from testMatch is listed (fixture 3)', async () => {
  const report = reportModern(parseFixture, ['api'], [
    fileSuite('flows/login.e2e.ts', [spec('flows/login.e2e.ts', 'logs in', 3, 1, ['api'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.status, 'ready')
  assert.equal(result.tree.files[0].file, 'flows/login.e2e.ts')
  assert.equal(result.testCount, 1)
})

await test('list: deeply nested files keep unambiguous relative paths (fixture 4)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('a/deep/one/spec.spec.ts', [spec('a/deep/one/spec.spec.ts', 't', 1, 1, ['chromium'])]),
    fileSuite('b/deep/two/spec.spec.ts', [spec('b/deep/two/spec.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.deepEqual(result.tree.files.map((f) => f.file).sort(), [
    'a/deep/one/spec.spec.ts',
    'b/deep/two/spec.spec.ts'
  ])
})

await test('list: top-level testDir → rootDir "." (fixture 5)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('root.spec.ts', [spec('root.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.rootDir, '.')
  assert.equal(result.tree.rootDir, '.')
})

await test('list: test roots outside the imported workspace are explicitly unsupported', async () => {
  const outsideRoot = join(work, 'shared-tests-outside-import')
  const report = reportModern(outsideRoot, ['chromium'], [
    fileSuite('outside.spec.ts', [spec('outside.spec.ts', 'outside', 2, 5, ['chromium'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.status, 'unsupported-launcher')
  assert.equal(result.tree, null)
  assert.match(result.diagnostic.suggestion, /containing workspace/i)
})

await test('list: per-project testDirs use the report rootDir, never projects[0].testDir (fixture 6)', async () => {
  const report = reportModern(
    parseFixture,
    [
      { name: 'logged-in', testDir: join(parseFixture, 'tests', 'logged-in') },
      { name: 'logged-out', testDir: join(parseFixture, 'tests', 'logged-out') }
    ],
    [
      fileSuite('tests/logged-in/a.spec.ts', [
        spec('tests/logged-in/a.spec.ts', 'a', 1, 1, ['logged-in'])
      ]),
      fileSuite('tests/logged-out/b.spec.ts', [
        spec('tests/logged-out/b.spec.ts', 'b', 1, 1, ['logged-out'])
      ])
    ]
  )
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.rootDir, '.', 'rootDir is the common ancestor, relative to cwd')
  assert.deepEqual(result.tree.files.map((f) => f.file).sort(), [
    'tests/logged-in/a.spec.ts',
    'tests/logged-out/b.spec.ts'
  ])
})

await test('list: stdout noise with braces before the report parses (fixture 17)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('a.spec.ts', [spec('a.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  const noise = 'config noise { with braces }\n{ not json either\nwebServer: { port: 3000 }\n'
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report, noise)
  )
  assert.equal(result.status, 'ready')
  assert.equal(result.testCount, 1)
})

await test('list: Wrightbench-owned flags stay before a custom -- separator', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('a.spec.ts', [spec('a.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  let seenArgs = null
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, {
        extraArgs: ['--project=chromium', '--', '--build-path=./out', '--reporter=custom-value']
      }),
      profileEnv: {}
    },
    async (request) => {
      seenArgs = request.args
      return {
        code: 0,
        stdout: JSON.stringify(report) + '\n',
        stderr: '',
        timedOut: false,
        spawnError: null,
        stdoutTruncated: false
      }
    }
  )
  assert.equal(result.status, 'ready')
  const separator = seenArgs.indexOf('--')
  assert.ok(seenArgs.indexOf('--list') < separator)
  assert.ok(seenArgs.indexOf('--reporter=json') < separator)
  assert.ok(seenArgs.findIndex((arg) => arg.startsWith('--config=')) < separator)
  assert.deepEqual(seenArgs.slice(separator), [
    '--',
    '--build-path=./out',
    '--reporter=custom-value'
  ])
})

await test('list: private UI-session environment is blanked after script/profile merge', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('a.spec.ts', [spec('a.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  const poisonedScriptEnv = Object.fromEntries(
    main.UI_SESSION_ENV_KEYS.map((key) => [key, `script-${key}`])
  )
  const poisonedProfileEnv = Object.fromEntries(
    main.UI_SESSION_ENV_KEYS.map((key) => [key, `profile-${key}`])
  )
  let seenEnv = null
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, { scriptEnv: poisonedScriptEnv }),
      profileEnv: { ...poisonedProfileEnv, PROFILE_ONLY: 'kept' }
    },
    async (request) => {
      seenEnv = request.env
      return {
        code: 0,
        stdout: JSON.stringify(report) + '\n',
        stderr: '',
        timedOut: false,
        spawnError: null,
        stdoutTruncated: false
      }
    }
  )
  assert.equal(result.status, 'ready')
  for (const key of main.UI_SESSION_ENV_KEYS) assert.equal(seenEnv[key], '', key)
  assert.equal(seenEnv.PROFILE_ONLY, 'kept')
  assert.equal(seenEnv.FORCE_COLOR, '0')
})

await test('list: effective projects come from surviving declarations, not the whole config', async () => {
  const report = reportModern(parseFixture, ['chromium', 'firefox', 'webkit'], [
    fileSuite('monitor.spec.ts', [
      spec('monitor.spec.ts', 'monitor endpoint', 3, 1, ['chromium'])
    ])
  ])
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, {
        extraArgs: ['--project=chromium', '--grep', '@monitor']
      }),
      profileEnv: {}
    },
    execOk(report)
  )
  assert.deepEqual(result.projectNames, ['chromium'])
  assert.deepEqual(result.configuredProjectNames, ['chromium', 'firefox', 'webkit'])
  assert.deepEqual(result.tree.projectNames, ['chromium'])
})

await test('list: zero tests is a successful empty discovery, exit 1 and all (fixture 18)', async () => {
  const report = { config: { rootDir: parseFixture, projects: [] }, suites: [], errors: [{ message: 'Error: No tests found' }] }
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({ code: 1, stdout: JSON.stringify(report) + '\n', stderr: '', timedOut: false, spawnError: null, stdoutTruncated: false })
  )
  assert.equal(result.status, 'empty')
  assert.equal(result.testCount, 0)
  assert.equal(result.diagnostic, null)
  assert.ok(result.tree, 'empty still yields a (zero-file) tree')
})

await test('list: an empty filtered recipe reports only its fixed project', async () => {
  const report = {
    config: {
      rootDir: parseFixture,
      projects: [{ name: 'chromium' }, { name: 'firefox' }, { name: 'webkit' }]
    },
    suites: [],
    errors: [{ message: 'Error: No tests found' }]
  }
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, { extraArgs: ['--project=firefox', '--grep', '@missing'] }),
      profileEnv: {}
    },
    async () => ({
      code: 1,
      stdout: JSON.stringify(report) + '\n',
      stderr: '',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'empty')
  assert.deepEqual(result.projectNames, ['firefox'])
  assert.deepEqual(result.configuredProjectNames, ['chromium', 'firefox', 'webkit'])
})

await test('list: a successful zero-declaration report keeps the fixed project', async () => {
  const report = reportModern(parseFixture, ['chromium', 'firefox', 'webkit'], [
    fileSuite('empty.spec.ts', [])
  ])
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, { extraArgs: ['--project=webkit', '--grep', '@missing'] }),
      profileEnv: {}
    },
    execOk(report)
  )
  assert.equal(result.status, 'empty')
  assert.equal(result.testCount, 0)
  assert.deepEqual(result.projectNames, ['webkit'])
  assert.deepEqual(result.tree.projectNames, ['webkit'])
  assert.deepEqual(result.configuredProjectNames, ['chromium', 'firefox', 'webkit'])
})

await test('list: loaded config with a failing test module has an actionable diagnostic', async () => {
  const report = {
    config: { rootDir: parseFixture, projects: [{ name: 'chromium' }] },
    suites: [fileSuite('ok.spec.ts', [spec('ok.spec.ts', 't', 1, 1, ['chromium'])])],
    errors: [{ message: "Error: Cannot find module 'MISSING_HELPER'" }]
  }
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({ code: 1, stdout: JSON.stringify(report) + '\n', stderr: '', timedOut: false, spawnError: null, stdoutTruncated: false })
  )
  assert.equal(result.status, 'test-load-failed')
  assert.equal(result.tree, null)
  assert.equal(
    result.diagnostic.summary,
    'Playwright loaded the configuration but could not load its tests'
  )
  assert.match(result.diagnostic.detail, /MISSING_HELPER/)
  assert.match(result.diagnostic.suggestion, /documented build or setup step/)
  assert.match(result.diagnostic.suggestion, /will not run project setup commands automatically/)
})

await test('list: arbitrary JSON noise followed by a crash is never an empty suite', async () => {
  assert.equal(main.parseListReport('{}\n'), null, 'a generic object is not a Playwright report')
  assert.equal(
    main.parseListReport('{"config":{},"suites":[]}\n'),
    null,
    'partial lookalike JSON is not a complete Playwright report'
  )
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: '{}\n',
      stderr: 'Error: config crashed after logging JSON',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'invalid-config')
  assert.equal(result.tree, null)
  assert.equal(result.diagnostic.summary, 'The Playwright configuration failed to load')
})

await test('list: Playwright’s empty pre-error JSON config remains invalid-config', async () => {
  const report = {
    config: { rootDir: '', projects: [], configFile: '' },
    suites: [],
    errors: [{ message: "SyntaxError: Unexpected token '}' in playwright.config.ts" }]
  }
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: JSON.stringify(report) + '\n',
      stderr: '',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'invalid-config')
  assert.equal(result.tree, null)
  assert.equal(result.diagnostic.summary, 'The Playwright configuration failed to load')
  assert.match(result.diagnostic.detail, /SyntaxError/)
})

await test('list: a non-module test-load error does not suggest running setup', async () => {
  const report = {
    config: { rootDir: parseFixture, projects: [{ name: 'chromium' }] },
    suites: [],
    errors: [{ message: 'SyntaxError: Unexpected token in tests/broken.spec.ts' }]
  }
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: JSON.stringify(report) + '\n',
      stderr: '',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'test-load-failed')
  assert.equal(result.tree, null)
  assert.match(result.diagnostic.detail, /SyntaxError/)
  assert.equal(result.diagnostic.suggestion, 'Fix the reported test-module error, then retry.')
  assert.doesNotMatch(result.diagnostic.suggestion, /build|setup/)
})

await test('list: script and profile environment values are redacted from diagnostics', async () => {
  const result = await main.listTarget(
    {
      workspaceRoot: parseFixture,
      target: targetFor(parseFixture, { scriptEnv: { SCRIPT_TOKEN: 'script-secret' } }),
      profileEnv: { API_TOKEN: 'profile-secret' }
    },
    async () => ({
      code: 1,
      stdout: 'script-secret\n',
      stderr: 'Error: API token profile-secret is invalid',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'invalid-config')
  assert.equal(result.tree, null)
  assert.equal(result.diagnostic.summary, 'The Playwright configuration failed to load')
  const diagnostic = JSON.stringify(result.diagnostic)
  assert.ok(!diagnostic.includes('script-secret'))
  assert.ok(!diagnostic.includes('profile-secret'))
  assert.match(diagnostic, /\[redacted\]/)
})

await test('list: parameterized tests on one line stay distinct declarations (fixture 19)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('param.spec.ts', [
      spec('param.spec.ts', 'param 1', 12, 3, ['chromium']),
      spec('param.spec.ts', 'param 2', 12, 3, ['chromium'])
    ])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.testCount, 2)
  const titles = result.tree.files[0].tests.map((t) => t.title).sort()
  assert.deepEqual(titles, ['param 1', 'param 2'])
})

await test('list: one declaration across projects counts once — modern shape (fixture 20)', async () => {
  const report = reportModern(parseFixture, ['chromium', 'firefox'], [
    fileSuite('multi.spec.ts', [spec('multi.spec.ts', 'shared', 5, 1, ['chromium', 'firefox'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.testCount, 1)
  assert.deepEqual(result.tree.files[0].tests[0].projects.sort(), ['chromium', 'firefox'])
})

await test('list: one declaration across projects counts once — legacy repeated-suite shape (fixture 20)', async () => {
  // Playwright ~1.4x repeats the whole file suite once per project
  const report = {
    config: { rootDir: parseFixture, projects: [{ name: 'chromium' }, { name: 'firefox' }] },
    suites: [
      describeSuite('multi.spec.ts', 'multi.spec.ts', [], [
        describeSuite('multi.spec.ts', 'outer', [spec('multi.spec.ts', 'shared', 5, 1, ['chromium'])])
      ]),
      describeSuite('multi.spec.ts', 'multi.spec.ts', [], [
        describeSuite('multi.spec.ts', 'outer', [spec('multi.spec.ts', 'shared', 5, 1, ['firefox'])])
      ])
    ],
    errors: []
  }
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.testCount, 1)
  const decl = result.tree.files[0].tests[0]
  assert.deepEqual(decl.projects.sort(), ['chromium', 'firefox'])
  assert.deepEqual(decl.titlePath, ['outer', 'shared'], 'describe nesting retained')
})

await test('list: duplicate leaf titles in different describes stay distinct (fixture 21)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('dup.spec.ts', [], [
      describeSuite('dup.spec.ts', 'checkout', [], [
        describeSuite('dup.spec.ts', 'guest', [spec('dup.spec.ts', 'duplicate title', 5, 5, ['chromium'])]),
        describeSuite('dup.spec.ts', 'member', [spec('dup.spec.ts', 'duplicate title', 8, 5, ['chromium'])])
      ])
    ])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.testCount, 2)
  const paths = result.tree.files[0].tests.map((t) => t.titlePath.join(' › ')).sort()
  assert.deepEqual(paths, ['checkout › guest › duplicate title', 'checkout › member › duplicate title'])
  const ids = result.tree.files[0].tests.map((t) => main.declIdentity('t-test', t))
  assert.equal(new Set(ids).size, 2, 'declIdentity distinguishes them')
})

await test('list: backslash report paths normalize to POSIX in the tree (fixture 25)', async () => {
  const report = reportModern(parseFixture, ['chromium'], [
    fileSuite('tests\\e2e\\win.spec.ts', [spec('tests\\e2e\\win.spec.ts', 't', 1, 1, ['chromium'])])
  ])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    execOk(report)
  )
  assert.equal(result.tree.files[0].file, 'tests/e2e/win.spec.ts')
})

await test('list: missing-env stderr classifies as needs-context (fixture 11, unit)', async () => {
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: '',
      stderr: 'Error: Please provide a correct TEST_ENV environment value (qa|staging)\n    at Object.<anonymous> (gated.config.js:1:34)',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'needs-context')
  assert.match(result.diagnostic.detail, /TEST_ENV/)
  assert.ok(result.diagnostic.suggestion, 'suggests choosing a profile')
})

await test('list: missing authentication storage state requires manual project setup', async () => {
  const projectError = '❌ Storage state file does not exist!'
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: '',
      stderr: projectError,
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'setup-required')
  assert.equal(result.tree, null)
  assert.equal(result.diagnostic.summary, 'This configuration requires project authentication setup')
  assert.equal(result.diagnostic.detail, projectError, 'preserves the project error verbatim')
  assert.match(result.diagnostic.suggestion, /documented setup or authentication step/)
  assert.match(result.diagnostic.suggestion, /Wrightbench will not run .* automatically/)
})

await test('list: loaded suite missing Playwright storage state is setup-required', async () => {
  const projectError =
    'Error reading storage state from .playwright/auth/user.json:\nENOENT: no such file or directory'
  const report = reportModern(parseFixture, ['chromium'], [], [{ message: projectError }])
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: JSON.stringify(report) + '\n',
      stderr: '',
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'setup-required')
  assert.equal(result.diagnostic.detail, 'Error reading storage state from .playwright/auth/user.json:')
  assert.match(result.diagnostic.output, /ENOENT: no such file or directory/)
})

await test('list: unrelated missing files are not mistaken for authentication setup', () => {
  assert.equal(main.looksLikeMissingAuthState('Cannot find module ../generated/client'), false)
  assert.equal(main.looksLikeMissingAuthState('ENOENT: no such file or directory, open fixture.json'), false)
  assert.equal(main.looksLikeMissingAuthState('Storage state file is malformed'), false)
})

await test('list: syntax/config crash classifies as invalid-config (fixture 16, unit)', async () => {
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: '',
      stderr: "SyntaxError: Unexpected token '}'\n    at compileSourceTextModule",
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'invalid-config')
})

await test('list: timeout classifies as timed-out', async () => {
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({ code: null, stdout: '', stderr: '', timedOut: true, spawnError: null, stdoutTruncated: false })
  )
  assert.equal(result.status, 'timed-out')
})

await test('list: dependencies-missing when no local Playwright resolves (fixture 15)', async () => {
  const root = join(work, 'no-deps')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({ name: 'x', devDependencies: { '@playwright/test': '^1.62.1' } }),
    'playwright.config.ts': 'export default {}'
  })
  const result = await main.listTarget(
    { workspaceRoot: root, target: targetFor(root, { configPath: 'playwright.config.ts' }), profileEnv: {} },
    async () => {
      throw new Error('exec must not be reached when resolution fails')
    }
  )
  assert.equal(result.status, 'dependencies-missing')
  assert.match(result.diagnostic.suggestion, /npm install/)
})

// =====================================================================
// F. integration: real spawn through the fake CLI
//    (fixtures 1, 11, 16, 17, 18, 24; opaque never executed for 14)
// =====================================================================

await test('integration: scan → target → real spawn → parsed tree (fixture 1)', async () => {
  const root = fixtureWithFakePlaywright('integ-conventional', {
    'playwright.config.js': 'module.exports = {}',
    'tests/checkout.spec.ts': 'test'
  })
  fakeBehavior(root, {
    'playwright.config.js': {
      noise: 'Some config log { braces } before the report',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['chromium', 'firefox'], [
        fileSuite('tests/checkout.spec.ts', [
          spec('tests/checkout.spec.ts', 'completes guest checkout', 3, 1, ['chromium', 'firefox'])
        ])
      ]),
      exitCode: 0
    }
  })
  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.equal(discovery.candidates.length, 1)
  const candidate = discovery.candidates[0]
  assert.equal(candidate.status, 'ready')
  assert.equal(candidate.testCount, 1)
  assert.deepEqual(candidate.projectNames, ['chromium', 'firefox'])
  assert.equal(candidate.playwrightVersion, '1.62.1')
  assert.equal(discovery.recommendedTargetId, candidate.id)
})

await test('integration: env-gated config retries successfully with profile env (fixture 11)', async () => {
  const root = fixtureWithFakePlaywright('integ-gated', {
    'playwright.qa.config.ts': 'gated'
  })
  fakeBehavior(root, {
    'playwright.qa.config.ts': {
      requireEnv: 'TEST_ENV',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['qa'], [
        fileSuite('qa/a.spec.ts', [spec('qa/a.spec.ts', 'qa test', 2, 1, ['qa'])])
      ]),
      exitCode: 0
    }
  })
  const target = targetFor(root, { configPath: 'playwright.qa.config.ts' })
  const without = await main.listTarget({ workspaceRoot: root, target, profileEnv: {} })
  assert.equal(without.status, 'needs-context')
  assert.match(without.diagnostic.detail, /TEST_ENV/)
  const withEnv = await main.listTarget({
    workspaceRoot: root,
    target,
    profileEnv: { TEST_ENV: 'qa' }
  })
  assert.equal(withEnv.status, 'ready')
  assert.equal(withEnv.testCount, 1)
})

await test('integration: empty dependency-only package is hidden beside an env-gated config', async () => {
  const root = fixtureWithFakePlaywright('integ-library-and-gated-e2e', {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/e2e-tests/package.json': JSON.stringify({
      name: 'e2e-tests',
      private: true,
      devDependencies: { '@playwright/test': '^1.62.1' }
    }),
    'packages/e2e-tests/playwright.config.ts': 'export default {}',
    'packages/playwright-toolkit/package.json': JSON.stringify({
      name: 'playwright-toolkit',
      devDependencies: { '@playwright/test': '^1.62.1' }
    })
  })
  fakeBehavior(root, {
    'playwright.config.ts': {
      requireEnv: 'MS_AUTH_EMAIL',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['default'], [
        fileSuite('tests/a.spec.ts', [spec('tests/a.spec.ts', 'requires auth', 1, 1, ['default'])])
      ])
    },
    '(default)': {
      rootDirFromCwd: true,
      report: {
        config: { rootDir: 'PLACEHOLDER', projects: [] },
        suites: [],
        errors: [{ message: 'Error: No tests found' }]
      },
      exitCode: 1
    }
  })

  const scan = main.scanWorkspace(root)
  const implicitLibrary = scan.candidates.find(
    (candidate) => candidate.cwd === 'packages/playwright-toolkit'
  )
  assert.ok(implicitLibrary, 'dependency-only library is considered before validation')
  assert.equal(implicitLibrary.implicitConfigless, true)

  const scanOnly = await main.discoverTargets(root, null, { validate: false })
  assert.equal(scanOnly.candidates.length, 2, 'unvalidated discovery does not guess that it is empty')
  assert.deepEqual(scanOnly.suppressedTargetIds, [])

  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.equal(discovery.candidates.length, 1)
  assert.equal(discovery.targets.length, 1)
  assert.equal(discovery.candidates[0].configPath, 'packages/e2e-tests/playwright.config.ts')
  assert.equal(discovery.candidates[0].status, 'needs-context')
  assert.equal(discovery.recommendedTargetId, discovery.candidates[0].id)
  assert.deepEqual(discovery.suppressedTargetIds, [main.candidateToTarget(implicitLibrary).id])
  assert.deepEqual(
    main
      .mergeTargets(
        [{ ...main.candidateToTarget(implicitLibrary), testCount: 0 }],
        discovery.targets,
        discovery.suppressedTargetIds
      )
      .map((target) => target.id),
    discovery.targets.map((target) => target.id),
    'a registered false target is pruned by the validated suppression result'
  )

  // Import persists only the validated target inventory. A later ordinary
  // file event uses scan-only discovery and must not resurrect the toolkit
  // merely because dependency inference sees it again.
  const registryPath = join(homedir(), '.wrightbench', 'projects.json')
  mkdirSync(dirname(registryPath), { recursive: true })
  writeFileSync(registryPath, '[]')
  main.addProject({
    name: 'library-and-gated-e2e',
    path: root,
    targets: discovery.targets,
    suppressedTargetIds: discovery.suppressedTargetIds,
    activeTargetId: discovery.recommendedTargetId
  })
  const refreshed = await main.rescanRegisteredTargets(root, null, false)
  assert.deepEqual(refreshed.targets.map((target) => target.id), [discovery.targets[0].id])
  assert.deepEqual(refreshed.candidates.map((candidate) => candidate.id), [discovery.targets[0].id])
})

await test('integration: a config-less dependency target stays when it lists tests', async () => {
  const root = fixtureWithFakePlaywright('integ-configless-with-tests', {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'packages/e2e-tests/package.json': JSON.stringify({ name: 'e2e-tests', private: true }),
    'packages/e2e-tests/playwright.config.ts': 'export default {}',
    'packages/configless-tests/package.json': JSON.stringify({
      name: 'configless-tests',
      devDependencies: { '@playwright/test': '^1.62.1' }
    })
  })
  fakeBehavior(root, {
    'playwright.config.ts': {
      requireEnv: 'TEST_ENV',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['qa'], [
        fileSuite('tests/qa.spec.ts', [spec('tests/qa.spec.ts', 'qa', 1, 1, ['qa'])])
      ])
    },
    '(default)': {
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['default'], [
        fileSuite('tests/default.spec.ts', [
          spec('tests/default.spec.ts', 'config-less test', 1, 1, ['default'])
        ])
      ])
    }
  })

  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.equal(discovery.candidates.length, 2)
  const configless = discovery.candidates.find((candidate) => candidate.configPath === null)
  assert.ok(configless)
  assert.equal(configless.status, 'ready')
  assert.equal(configless.testCount, 1)
  assert.equal(discovery.recommendedTargetId, configless.id)

  const registryPath = join(homedir(), '.wrightbench', 'projects.json')
  mkdirSync(dirname(registryPath), { recursive: true })
  writeFileSync(registryPath, '[]')
  main.addProject({ name: 'configless-with-tests', path: root, targets: discovery.targets })
  const refreshed = await main.rescanRegisteredTargets(root, null, false)
  assert.equal(refreshed.targets.length, 2, 'scan-only refresh keeps a registered config-less suite')
})

await test('integration: a lone empty config-less dependency target stays visible', async () => {
  const root = fixtureWithFakePlaywright('integ-lone-empty-configless')
  fakeBehavior(root, {
    '(default)': {
      rootDirFromCwd: true,
      report: {
        config: { rootDir: 'PLACEHOLDER', projects: [] },
        suites: [],
        errors: [{ message: 'Error: No tests found' }]
      },
      exitCode: 1
    }
  })

  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.equal(discovery.candidates.length, 1)
  assert.equal(discovery.candidates[0].configPath, null)
  assert.equal(discovery.candidates[0].status, 'empty')
  assert.equal(discovery.recommendedTargetId, discovery.candidates[0].id)
})

await test('integration: an empty script-derived config-less base stays beside an explicit config', async () => {
  const root = fixtureWithFakePlaywright('integ-script-derived-empty-configless', {
    'package.json': JSON.stringify({
      name: 'mono',
      private: true,
      workspaces: ['packages/script-suite', 'packages/e2e-tests']
    }),
    'packages/script-suite/package.json': JSON.stringify({
      name: 'script-suite',
      scripts: { test: 'playwright test' },
      devDependencies: { '@playwright/test': '^1.62.1' }
    }),
    'packages/e2e-tests/package.json': JSON.stringify({ name: 'e2e-tests', private: true }),
    'packages/e2e-tests/playwright.config.ts': 'export default {}'
  })
  fakeBehavior(root, {
    'playwright.config.ts': {
      requireEnv: 'TEST_ENV',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['qa'], [
        fileSuite('tests/qa.spec.ts', [spec('tests/qa.spec.ts', 'qa', 1, 1, ['qa'])])
      ])
    },
    '(default)': {
      rootDirFromCwd: true,
      report: {
        config: { rootDir: 'PLACEHOLDER', projects: [] },
        suites: [],
        errors: [{ message: 'Error: No tests found' }]
      },
      exitCode: 1
    }
  })

  const scan = main.scanWorkspace(root)
  const scriptBase = scan.candidates.find(
    (candidate) => candidate.cwd === 'packages/script-suite' && candidate.source === 'config'
  )
  assert.ok(scriptBase)
  assert.equal(scriptBase.implicitConfigless, false)

  const discovery = await main.discoverTargets(root, null, { validate: true })
  const retained = discovery.candidates.find((candidate) => candidate.id === main.candidateToTarget(scriptBase).id)
  assert.ok(retained)
  assert.equal(retained.status, 'empty')
  assert.deepEqual(discovery.suppressedTargetIds, [])
})

await test('integration: a script-derived default suppresses an empty dependency-only library', async () => {
  const root = fixtureWithFakePlaywright('integ-script-default-and-library', {
    'package.json': JSON.stringify({
      name: 'mono',
      private: true,
      workspaces: ['packages/script-suite', 'packages/playwright-toolkit']
    }),
    'packages/script-suite/package.json': JSON.stringify({
      name: 'script-suite',
      scripts: { test: 'playwright test' },
      devDependencies: { '@playwright/test': '^1.62.1' }
    }),
    'packages/playwright-toolkit/package.json': JSON.stringify({
      name: 'playwright-toolkit',
      devDependencies: { '@playwright/test': '^1.62.1' }
    })
  })
  fakeBehavior(root, {
    '(default)': {
      rootDirFromCwd: true,
      report: {
        config: { rootDir: 'PLACEHOLDER', projects: [] },
        suites: [],
        errors: [{ message: 'Error: No tests found' }]
      },
      exitCode: 1
    }
  })

  const scan = main.scanWorkspace(root)
  const scriptBase = scan.candidates.find(
    (candidate) => candidate.cwd === 'packages/script-suite'
  )
  const library = scan.candidates.find(
    (candidate) => candidate.cwd === 'packages/playwright-toolkit'
  )
  assert.ok(scriptBase)
  assert.ok(library)
  assert.equal(scriptBase.implicitConfigless, false)
  assert.equal(library.implicitConfigless, true)

  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.deepEqual(discovery.candidates.map((candidate) => candidate.cwd), [
    'packages/script-suite'
  ])
  assert.deepEqual(discovery.suppressedTargetIds, [main.candidateToTarget(library).id])
})

await test('integration: explicit config validates before more than twelve implicit libraries', async () => {
  const libraryWorkspaces = Array.from(
    { length: 13 },
    (_, index) => `packages/a-library-${String(index).padStart(2, '0')}`
  )
  const libraryFiles = Object.fromEntries(
    libraryWorkspaces.map((packageDir, index) => [
      `${packageDir}/package.json`,
      JSON.stringify({
        name: `library-${index}`,
        devDependencies: { '@playwright/test': '^1.62.1' }
      })
    ])
  )
  const root = fixtureWithFakePlaywright('integ-validation-priority', {
    'package.json': JSON.stringify({
      name: 'mono',
      private: true,
      workspaces: [...libraryWorkspaces, 'packages/z-e2e']
    }),
    ...libraryFiles,
    'packages/z-e2e/package.json': JSON.stringify({ name: 'e2e', private: true }),
    'packages/z-e2e/playwright.config.ts': 'export default {}'
  })
  fakeBehavior(root, {
    'playwright.config.ts': {
      requireEnv: 'MS_AUTH_EMAIL',
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['default'], [
        fileSuite('tests/auth.spec.ts', [
          spec('tests/auth.spec.ts', 'requires auth', 1, 1, ['default'])
        ])
      ])
    },
    '(default)': {
      rootDirFromCwd: true,
      report: {
        config: { rootDir: 'PLACEHOLDER', projects: [] },
        suites: [],
        errors: [{ message: 'Error: No tests found' }]
      },
      exitCode: 1
    }
  })

  const scan = main.scanWorkspace(root)
  const explicitScanIndex = scan.candidates.findIndex(
    (candidate) => candidate.configPath === 'packages/z-e2e/playwright.config.ts'
  )
  assert.ok(explicitScanIndex > 12, 'fixture discovers the explicit config after the validation cap')

  const discovery = await main.discoverTargets(root, null, { validate: true })
  const explicit = discovery.candidates.find(
    (candidate) => candidate.configPath === 'packages/z-e2e/playwright.config.ts'
  )
  assert.ok(explicit)
  assert.equal(explicit.status, 'needs-context')
  assert.equal(discovery.recommendedTargetId, explicit.id)
})

await test('integration: script env is applied, profile env wins on conflict', async () => {
  const root = fixtureWithFakePlaywright('integ-scriptenv', {
    'playwright.qa.config.ts': 'gated'
  })
  fakeBehavior(root, {
    'playwright.qa.config.ts': {
      requireEnv: 'TEST_ENV',
      rootDirFromCwd: true,
      echoEnv: 'TEST_ENV',
      report: { config: { rootDir: 'x', projects: [] }, suites: [], errors: [{ message: 'Error: No tests found' }] },
      exitCode: 1
    }
  })
  const target = targetFor(root, {
    configPath: 'playwright.qa.config.ts',
    scriptEnv: { TEST_ENV: 'qa' }
  })
  const scriptOnly = await main.listTarget({ workspaceRoot: root, target, profileEnv: {} })
  assert.equal(scriptOnly.status, 'empty', 'script env satisfied the gate')
  const overridden = await main.listTarget({
    workspaceRoot: root,
    target,
    profileEnv: { TEST_ENV: 'staging' }
  })
  assert.equal(overridden.status, 'empty')
})

await test('integration: config syntax failure surfaces invalid-config (fixture 16)', async () => {
  const root = fixtureWithFakePlaywright('integ-broken', {
    'playwright.config.js': 'broken'
  })
  fakeBehavior(root, {
    'playwright.config.js': {
      stderr: "SyntaxError: Unexpected token '}' in playwright.config.js",
      exitCode: 1
    }
  })
  const result = await main.listTarget({
    workspaceRoot: root,
    target: targetFor(root),
    profileEnv: {}
  })
  assert.equal(result.status, 'invalid-config')
  assert.match(result.diagnostic.detail, /SyntaxError/)
})

await test('integration: zero-test project reports empty, not failed (fixture 18)', async () => {
  const root = fixtureWithFakePlaywright('integ-empty', {
    'playwright.config.js': 'module.exports = {}'
  })
  fakeBehavior(root, {
    'playwright.config.js': {
      rootDirFromCwd: true,
      report: { config: { rootDir: 'PLACEHOLDER', projects: [{ name: 'chromium' }] }, suites: [], errors: [{ message: 'Error: No tests found' }] },
      exitCode: 1
    }
  })
  const result = await main.listTarget({
    workspaceRoot: root,
    target: targetFor(root),
    profileEnv: {}
  })
  assert.equal(result.status, 'empty')
  assert.equal(result.testCount, 0)
})

await test('integration: paths with spaces list through structured argv (fixture 24)', async () => {
  const root = fixtureWithFakePlaywright('integ space dir', {
    'My Tests/playwright.config.js': 'module.exports = {}'
  })
  fakeBehavior(root, {
    'playwright.config.js': {
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['chromium'], [
        fileSuite('My Tests/a b.spec.ts', [spec('My Tests/a b.spec.ts', 'with spaces', 1, 1, ['chromium'])])
      ]),
      exitCode: 0
    }
  })
  const result = await main.listTarget({
    workspaceRoot: root,
    target: targetFor(root, { configPath: 'My Tests/playwright.config.js' }),
    profileEnv: {}
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.tree.files[0].file, 'My Tests/a b.spec.ts')
})

await test('integration: discovery never executes an opaque wrapper script (fixture 14)', async () => {
  const marker = join(work, 'opaque-executed.marker')
  rmSync(marker, { force: true })
  const root = fixtureWithFakePlaywright('integ-opaque', {
    'playwright.config.js': 'module.exports = {}',
    'tools/prepare-and-run-tests.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
  })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'integ-opaque',
      devDependencies: { '@playwright/test': '^1.62.1' },
      scripts: { 'test:e2e': 'node tools/prepare-and-run-tests.js' }
    })
  })
  fakeBehavior(root, {
    'playwright.config.js': {
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['chromium'], [
        fileSuite('a.spec.ts', [spec('a.spec.ts', 't', 1, 1, ['chromium'])])
      ]),
      exitCode: 0
    }
  })
  const discovery = await main.discoverTargets(root, null, { validate: true })
  assert.ok(!existsSync(marker), 'the wrapper script must never run')
  assert.equal(discovery.opaqueScripts.length, 1)
  assert.equal(discovery.candidates.length, 1, 'the conventional config still validated')
  assert.equal(discovery.candidates[0].status, 'ready')
})

// =====================================================================
// G. persistence, migration, active target, user config
//    (fixtures 10, 23; target merge; runnable guards)
// =====================================================================

const projectsJson = join(home, '.wrightbench', 'projects.json')

function seedRegistry(entries) {
  mkdirSync(join(home, '.wrightbench'), { recursive: true })
  writeFileSync(projectsJson, JSON.stringify(entries, null, 2))
}

await test('scan → add/load preserves sanitized recipe argv and custom contract', () => {
  const root = join(work, 'persist-owned-flags')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, {
    'package.json': JSON.stringify({
      name: 'persist-owned-flags',
      scripts: {
        'test:smoke':
          'playwright test --reporter line --trace=retain-on-failure --output repo-results --grep @smoke -- --reporter=custom --trace=custom --output custom --list'
      }
    }),
    'playwright.config.ts': 'export default {}'
  })

  const scan = main.scanWorkspace(root)
  const scanned = scan.candidates.find((candidate) => candidate.scriptName === 'test:smoke')
  assert.ok(scanned, 'the sanitized recipe is discovered')
  assert.deepEqual(scanned.extraArgs, [
    '--grep',
    '@smoke',
    '--',
    '--reporter=custom',
    '--trace=custom',
    '--output',
    'custom',
    '--list'
  ])

  const target = main.candidateToTarget(scanned)
  seedRegistry([])
  main.addProject({
    name: 'persist-owned-flags',
    path: root,
    targets: scan.candidates.map(main.candidateToTarget),
    activeTargetId: target.id
  })
  const loadedProject = main.loadProjects().find((project) => project.path === root)
  assert.ok(loadedProject)
  const loaded = main
    .projectTargets(loadedProject)
    .targets.find((candidate) => candidate.id === target.id)
  assert.ok(loaded, 'the recipe survives persistence sanitization')
  assert.deepEqual(loaded.extraArgs, scanned.extraArgs)
})

await test('migration: legacy projects.json entries gain a default target, nothing lost (fixture 23)', () => {
  const legacyDir = join(work, 'legacy-project')
  rmSync(legacyDir, { recursive: true, force: true })
  writeFiles(legacyDir, { 'playwright.config.ts': 'export default {}' })
  seedRegistry([
    { note: 'unrecognized-entry', keep: true },
    {
      id: 'legacy-1',
      name: 'legacy',
      path: legacyDir,
      addedAt: '2024-01-01T00:00:00.000Z',
      playwrightVersion: '1.46.1',
      nodeVersion: 'v20.12.2',
      testCount: 128
    }
  ])
  main.migrateProjectsFile()
  const raw = JSON.parse(readFileSync(projectsJson, 'utf8'))
  assert.deepEqual(raw[0], { note: 'unrecognized-entry', keep: true }, 'unknown entries verbatim')
  const migrated = raw[1]
  assert.equal(migrated.id, 'legacy-1', 'id preserved — history stays attached')
  assert.equal(migrated.addedAt, '2024-01-01T00:00:00.000Z')
  assert.equal(migrated.testCount, 128, 'cached metadata preserved')
  assert.equal(migrated.targets.length, 1)
  assert.equal(migrated.targets[0].cwd, '.')
  assert.equal(migrated.targets[0].configPath, 'playwright.config.ts', 'enriched from disk')
  assert.equal(migrated.activeTargetId, migrated.targets[0].id)
  // idempotent
  main.migrateProjectsFile()
  assert.deepEqual(JSON.parse(readFileSync(projectsJson, 'utf8')), raw)
})

await test('migration: a legacy entry whose folder is gone still gets a pure default target', () => {
  seedRegistry([
    { id: 'gone-1', name: 'gone', path: join(work, 'does-not-exist'), addedAt: 'x' }
  ])
  main.migrateProjectsFile()
  const raw = JSON.parse(readFileSync(projectsJson, 'utf8'))
  assert.equal(raw[0].targets.length, 1, 'entry never deleted on migration failure')
  assert.equal(raw[0].targets[0].configPath, null, 'default resolution — the legacy behavior')
})

await test('migration: legacy aliases become a base config while meaningful recipes survive', () => {
  const base = {
    ...main.synthesizeLegacyTarget(),
    configPath: 'playwright.config.ts',
    label: 'playwright.config.ts',
    playwrightVersion: '1.58.2'
  }
  const headed = {
    ...base,
    id: main.targetIdFor({
      cwd: '.',
      configPath: 'playwright.config.ts',
      source: 'script',
      scriptName: 'test:headed'
    }),
    source: 'script',
    scriptName: 'test:headed',
    label: 'test:headed',
    extraArgs: ['--project=chromium', '--headed'],
    testCount: 12
  }
  const monitor = {
    ...headed,
    id: main.targetIdFor({
      cwd: '.',
      configPath: 'playwright.config.ts',
      source: 'script',
      scriptName: 'test:monitor'
    }),
    scriptName: 'test:monitor',
    label: 'test:monitor',
    extraArgs: ['--project=chromium', '--grep', '@monitor'],
    testCount: 4
  }
  seedRegistry([
    { keep: 'unknown' },
    {
      id: 'recipes-1',
      name: 'recipes',
      path: join(work, 'recipes'),
      addedAt: 'x',
      targets: [headed, monitor],
      activeTargetId: headed.id,
      testCount: 12
    }
  ])
  main.migrateProjectsFile()
  const first = JSON.parse(readFileSync(projectsJson, 'utf8'))
  assert.deepEqual(first[0], { keep: 'unknown' })
  const migrated = first[1]
  assert.deepEqual(
    migrated.targets.map((target) => [target.source, target.scriptName]),
    [
      ['config', null],
      ['script', 'test:monitor']
    ]
  )
  assert.equal(migrated.targets[0].testCount, null, 'filtered alias count is not copied to full suite')
  assert.equal(migrated.activeTargetId, migrated.targets[0].id)
  assert.equal(migrated.testCount, null, 'project cache follows the remapped full suite')
  main.migrateProjectsFile()
  assert.deepEqual(JSON.parse(readFileSync(projectsJson, 'utf8')), first, 'migration is idempotent')
})

await test('projectTargets synthesizes in memory for unmigrated entries', () => {
  const { targets, activeTargetId } = main.projectTargets({
    id: 'x',
    name: 'x',
    path: '/nowhere',
    addedAt: 'x'
  })
  assert.equal(targets.length, 1)
  assert.equal(targets[0].configPath, null)
  assert.equal(activeTargetId, targets[0].id)
})

await test('target ids are deterministic and identity-scoped', () => {
  const a = main.targetIdFor({ cwd: '.', configPath: 'playwright.config.ts', source: 'config', scriptName: null })
  const b = main.targetIdFor({ cwd: '.', configPath: 'playwright.config.ts', source: 'config', scriptName: null })
  const c = main.targetIdFor({ cwd: '.', configPath: 'playwright.qa.config.ts', source: 'config', scriptName: null })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

await test('mergeTargets: a custom-named root config never displaces the legacy default target', () => {
  const legacy = main.synthesizeLegacyTarget()
  const custom = {
    ...legacy,
    id: main.targetIdFor({ cwd: '.', configPath: 'playwright.smoke.config.ts', source: 'config', scriptName: null }),
    configPath: 'playwright.smoke.config.ts',
    label: 'playwright.smoke.config.ts'
  }
  const merged = main.mergeTargets([legacy], [custom])
  // default resolution would never load the custom-named config — both stay
  assert.deepEqual(merged.map((t) => t.id).sort(), [legacy.id, custom.id].sort())
})

await test('list: a SyntaxError mentioning process.env is invalid-config, not needs-context', async () => {
  const result = await main.listTarget(
    { workspaceRoot: parseFixture, target: targetFor(parseFixture), profileEnv: {} },
    async () => ({
      code: 1,
      stdout: '',
      stderr: "SyntaxError: Unexpected token '}'\n  baseURL: process.env.BASE_URL ??\n    at compileSourceTextModule",
      timedOut: false,
      spawnError: null,
      stdoutTruncated: false
    })
  )
  assert.equal(result.status, 'invalid-config')
})

await test('mergeTargets: rescan upgrades the legacy default and keeps user targets', () => {
  const legacy = main.synthesizeLegacyTarget()
  const user = { ...legacy, id: 'u-1', source: 'user', configPath: 'custom/pw.config.ts', label: 'custom/pw.config.ts' }
  const discoveredRoot = {
    ...legacy,
    id: main.targetIdFor({ cwd: '.', configPath: 'playwright.config.ts', source: 'config', scriptName: null }),
    configPath: 'playwright.config.ts',
    label: 'playwright.config.ts'
  }
  const merged = main.mergeTargets([legacy, user], [discoveredRoot])
  assert.deepEqual(merged.map((t) => t.id).sort(), [discoveredRoot.id, 'u-1'].sort())
})

await test('mergeTargets: stale script recipes are pruned after reclassification', () => {
  const config = {
    ...main.synthesizeLegacyTarget(),
    id: main.targetIdFor({
      cwd: '.',
      configPath: 'playwright.config.ts',
      source: 'config',
      scriptName: null
    }),
    configPath: 'playwright.config.ts',
    label: 'playwright.config.ts'
  }
  const staleRecipe = {
    ...config,
    id: main.targetIdFor({
      cwd: '.',
      configPath: 'playwright.config.ts',
      source: 'script',
      scriptName: 'test:headed'
    }),
    source: 'script',
    scriptName: 'test:headed',
    extraArgs: ['--headed', '--project=chromium']
  }
  assert.deepEqual(main.mergeTargets([config, staleRecipe], [config]).map((t) => t.id), [config.id])
})

await test('re-adding a workspace preserves custom targets and the active selection', () => {
  const root = join(work, 'readd-project')
  const base = main.synthesizeLegacyTarget()
  const user = {
    ...base,
    id: 'user-custom',
    source: 'user',
    configPath: 'configs/custom.pw.ts',
    label: 'configs/custom.pw.ts',
    testCount: 7,
    playwrightVersion: '1.48.2'
  }
  const discovered = {
    ...base,
    id: main.targetIdFor({
      cwd: '.',
      configPath: 'playwright.config.ts',
      source: 'config',
      scriptName: null
    }),
    configPath: 'playwright.config.ts',
    label: 'playwright.config.ts',
    testCount: 12,
    playwrightVersion: '1.62.1'
  }
  seedRegistry([
    {
      id: 'stable-project-id',
      name: 'before',
      path: root,
      addedAt: '2024-01-01T00:00:00.000Z',
      targets: [user],
      activeTargetId: user.id,
      testCount: 7,
      playwrightVersion: '1.48.2'
    }
  ])

  const projects = main.addProject({
    name: 'after',
    path: root,
    targets: [discovered],
    activeTargetId: discovered.id,
    testCount: 12,
    playwrightVersion: '1.62.1'
  })
  const readded = projects.find((project) => project.path === root)
  assert.equal(readded.id, 'stable-project-id')
  assert.deepEqual(readded.targets.map((target) => target.id).sort(), [user.id, discovered.id].sort())
  assert.equal(readded.activeTargetId, user.id, 're-import does not reset the saved target')
  assert.equal(readded.testCount, 7, 'project summary follows the preserved active target')
  assert.equal(readded.playwrightVersion, '1.48.2')
})

await test('active target persists and rescan preserves the selection (fixture 8 flow)', async () => {
  const root = fixtureWithFakePlaywright('multi-target-project', {
    'playwright.config.js': 'module.exports = {}',
    'playwright.qa.config.js': 'module.exports = {}'
  })
  const behavior = (file, count) => ({
    rootDirFromCwd: true,
    report: reportModern('PLACEHOLDER', ['chromium'],
      Array.from({ length: count }, (_, i) =>
        fileSuite(`${file}-${i}.spec.ts`, [spec(`${file}-${i}.spec.ts`, 't', 1, 1, ['chromium'])])
      )
    ),
    exitCode: 0
  })
  fakeBehavior(root, {
    'playwright.config.js': behavior('main', 2),
    'playwright.qa.config.js': behavior('qa', 3)
  })
  seedRegistry([{ id: 'multi-1', name: 'multi', path: root, addedAt: 'x' }])
  const rescan = await main.rescanRegisteredTargets(root, null, true)
  assert.equal(rescan.targets.length, 2, 'both configs are separate targets')
  const qa = rescan.targets.find((t) => t.configPath === 'playwright.qa.config.js')
  assert.ok(qa)

  const state = main.setActiveTarget(root, qa.id)
  assert.equal(state.activeTargetId, qa.id)
  assert.equal(JSON.parse(readFileSync(projectsJson, 'utf8'))[0].activeTargetId, qa.id)

  // the tree lists the ACTIVE target only — no merged union
  const outcome = await main.listTestsForProject(root, null, null)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.tree.totalTests, 3)
  assert.equal(outcome.target.id, qa.id)

  // an explicit targetId overrides the active selection
  const other = rescan.targets.find((t) => t.configPath === 'playwright.config.js')
  const explicit = await main.listTestsForProject(root, null, other.id)
  assert.equal(explicit.tree.totalTests, 2)

  // a second rescan keeps the user's active selection
  const again = await main.rescanRegisteredTargets(root, null, false)
  assert.equal(again.activeTargetId, qa.id)
})

await test('user-selected config: containment + package resolution (fixture 10)', async () => {
  const root = fixtureWithFakePlaywright('user-config', {
    'configs/pw.custom.ts': 'export default {}'
  })
  const built = main.buildUserConfigTarget(root, join(root, 'configs', 'pw.custom.ts'))
  assert.ok(built.target, 'inside the workspace builds a target')
  assert.equal(built.target.configPath, 'configs/pw.custom.ts')
  assert.equal(built.target.source, 'user')
  assert.equal(built.target.cwd, '.', 'nearest package root owns the cwd')
  assert.equal(built.target.playwrightVersion, '1.62.1')

  const outside = main.buildUserConfigTarget(root, join(work, 'somewhere-else.config.ts'))
  assert.ok(outside.error, 'outside the workspace is rejected')
  const badExt = main.buildUserConfigTarget(root, join(root, 'configs', 'pw.custom.ts') + '.json')
  assert.ok(badExt.error, 'unsupported extension is rejected')

  // validate + persist + list, end to end
  fakeBehavior(root, {
    'pw.custom.ts': {
      rootDirFromCwd: true,
      report: reportModern('PLACEHOLDER', ['custom'], [
        fileSuite('x.spec.ts', [spec('x.spec.ts', 'custom listed', 1, 1, ['custom'])])
      ]),
      exitCode: 0
    }
  })
  seedRegistry([{ id: 'user-1', name: 'user-config', path: root, addedAt: 'x' }])
  main.applyDiscoveredTargets(root, [built.target], built.target.id)
  const outcome = await main.listTestsForProject(root, null, null)
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.target.id, built.target.id)
  assert.equal(outcome.tree.files[0].tests[0].title, 'custom listed')
})

await test('sanitizeTarget rejects traversal/absolute paths from edited files', () => {
  const base = main.synthesizeLegacyTarget()
  assert.equal(main.sanitizeTarget({ ...base, cwd: '../outside' }), null)
  assert.equal(main.sanitizeTarget({ ...base, configPath: '/etc/passwd' }), null)
  assert.equal(main.sanitizeTarget({ ...base, configPath: 'C:/x/pw.config.ts' }), null)
  assert.equal(main.sanitizeTarget({ ...base, scriptEnv: { TOKEN: 'bad\u0000value' } }), null)
  assert.equal(main.sanitizeTarget({ ...base, extraArgs: ['--config=outside.ts'] }), null)
  assert.equal(main.sanitizeTarget({ ...base, extraArgs: ['--ui'] }), null)
  const manyArgs = Array.from({ length: 40 }, (_, index) => `--flag-${index}`)
  assert.deepEqual(
    main.sanitizeTarget({ ...base, extraArgs: manyArgs }).extraArgs,
    manyArgs,
    'accepted recipe argv is never silently truncated'
  )
  assert.ok(main.sanitizeTarget({ ...base, configPath: 'My Tests/pw.config.ts' }), 'spaces are fine')
})

await test('run request requires the exact active target and resolves env server-side', () => {
  const root = join(work, 'run-request-boundary')
  const active = {
    ...main.synthesizeLegacyTarget(),
    scriptEnv: {
      SCRIPT_ONLY: 'kept',
      SHARED: 'script',
      PW_TEST_REPORTER: 'script-reporter',
      WRIGHTBENCH_UI_EVENTS_FILE: 'script-events'
    }
  }
  const stale = {
    ...active,
    id: 'stale-target',
    label: 'stale',
    configPath: 'playwright.stale.config.ts'
  }
  const projects = [
    {
      id: 'registered-project',
      name: 'registered',
      path: root,
      addedAt: 'x',
      targets: [active, stale],
      activeTargetId: active.id
    }
  ]
  const runtime = () => {
    return {
      RUNTIME_ONLY: 'kept',
      PW_TEST_REPORTER: 'runtime-reporter',
      WRIGHTBENCH_UI_SESSION_ID: 'runtime-session',
      WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR: 'runtime-attachments'
    }
  }

  assert.throws(
    () => main.resolveRunRequest({ path: root }, projects, runtime),
    /missing or invalid test configuration/
  )
  assert.throws(
    () => main.resolveRunRequest({ path: root, targetId: null }, projects, runtime),
    /missing or invalid test configuration/
  )
  assert.throws(
    () => main.resolveRunRequest({ path: root, targetId: stale.id }, projects, runtime),
    /configuration changed/
  )
  assert.throws(
    () => main.resolveRunRequest({ path: join(work, 'unknown'), targetId: active.id }, projects, runtime),
    /unknown project/
  )

  const resolved = main.resolveRunRequest(
    {
      path: root,
      targetId: active.id,
      envProfile: 'qa',
      workers: 2,
      trigger: 'watch',
      lastFailed: true
    },
    projects,
    runtime
  )
  assert.equal(resolved.target.id, active.id)
  assert.equal(resolved.config.targetId, active.id)
  assert.equal(resolved.config.workers, 2)
  assert.equal(resolved.config.trigger, 'watch')
  assert.equal(resolved.config.envProfile, null)
  assert.equal(resolved.env.SCRIPT_ONLY, 'kept')
  assert.equal(resolved.env.RUNTIME_ONLY, 'kept')
  assert.equal(resolved.env.PROFILE_ONLY, undefined)
  assert.equal(resolved.env.SHARED, 'script')
  for (const key of main.UI_SESSION_ENV_KEYS) assert.equal(resolved.env[key], '', key)
})

await test('target context: nested cwd, local CLI, argument split, and exact location are resolved', () => {
  const root = fixtureWithFakePlaywright('target-context', {
    'packages/web/package.json': JSON.stringify({ name: 'web' }),
    'packages/web/playwright.config.ts': 'export default {}',
    'packages/web/tests/a.spec.ts': 'test'
  })
  const target = {
    ...main.synthesizeLegacyTarget(),
    cwd: 'packages/web',
    packageDir: 'packages/web',
    configPath: 'packages/web/playwright.config.ts',
    extraArgs: ['--grep', '@monitor', '--', '--tenant=qa']
  }
  const resolved = main.resolveTargetContext(root, target)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.context.cwd, realpathSync(join(root, 'packages/web')))
  assert.equal(
    resolved.context.configPath,
    realpathSync(join(root, 'packages/web/playwright.config.ts'))
  )
  assert.match(resolved.context.playwright.cliPath, /node_modules.*@playwright.*cli\.js$/)
  assert.deepEqual(main.splitTargetArgs(target.extraArgs), {
    options: ['--grep', '@monitor'],
    customArgs: ['--', '--tenant=qa']
  })
  assert.equal(
    main.targetRunLocation(resolved.context, 'packages/web/tests/a.spec.ts:7'),
    'tests/a.spec.ts:7'
  )
  assert.equal(
    main.targetRunLocation(resolved.context, 'packages/web/tests/a.spec.ts:7:13'),
    'tests/a.spec.ts:7:13'
  )
  assert.throws(
    () => main.targetRunLocation(resolved.context, 'packages/web/tests/a.spec.ts:7:0'),
    /invalid/
  )
  assert.throws(() => main.targetRunLocation(resolved.context, '../outside.ts:1'), /invalid/)
  assert.throws(
    () => main.targetRunLocation(resolved.context, join(root, 'packages/web/tests/a.spec.ts') + ':1'),
    /invalid/
  )

  const outside = join(work, 'outside-location.spec.ts')
  writeFileSync(outside, 'test')
  const link = join(root, 'packages/web/tests/link.spec.ts')
  symlinkSync(outside, link)
  assert.throws(
    () => main.targetRunLocation(resolved.context, 'packages/web/tests/link.spec.ts:1'),
    /invalid/,
    'a symlink may not escape the imported workspace'
  )
})

await test('target presentation: configurations and recipes group by invocation context', () => {
  const summary = {
    id: 'config-root',
    label: 'playwright.config.ts',
    cwd: '.',
    configPath: 'playwright.config.ts',
    packageDir: '.',
    launcher: 'npm',
    source: 'config',
    scriptName: null,
    playwrightVersion: '1.58.2',
    testCount: 41,
    runnable: true,
    runnableReason: null
  }
  const groups = main.groupTargets([
    summary,
    { ...summary, id: 'user-copy', source: 'user' },
    { ...summary, id: 'monitor', label: 'test:monitor', source: 'script', scriptName: 'test:monitor', testCount: 23 },
    { ...summary, id: 'visual', label: 'test:visual', source: 'script', scriptName: 'test:visual', testCount: 3 },
    {
      ...summary,
      id: 'nested',
      label: 'packages/admin/playwright.config.ts',
      cwd: 'packages/admin',
      packageDir: 'packages/admin',
      configPath: 'packages/admin/playwright.config.ts'
    }
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].configuration.id, 'config-root', 'scanned/user duplicate collapses')
  assert.deepEqual(groups[0].recipes.map((recipe) => recipe.label), ['test:monitor', 'test:visual'])
  assert.equal(groups[1].configuration.id, 'nested')
})

await test('target presentation: test-module failures are distinct from config failures', () => {
  assert.equal(main.radioNavigationIndex('ArrowRight', 2, 3), 0)
  assert.equal(main.radioNavigationIndex('ArrowLeft', 0, 3), 2)
  assert.equal(main.radioNavigationIndex('Home', 2, 3), 0)
  assert.equal(main.radioNavigationIndex('End', 0, 3), 2)
  assert.equal(main.radioNavigationIndex('Enter', 1, 3), null)
  assert.equal(
    main.standaloneRecoveryFor('needs-context'),
    'environment',
    'single-target environment recovery does not depend on rendering a target picker'
  )
  assert.equal(
    main.standaloneRecoveryFor('setup-required'),
    'setup',
    'single-target setup recovery does not depend on rendering a target picker'
  )
  assert.equal(main.standaloneRecoveryFor('ready'), null)
  assert.deepEqual(main.targetStatusPresentation('setup-required', null), {
    caption: 'needs setup',
    tone: 'warn'
  })
  assert.deepEqual(main.targetStatusPresentation('test-load-failed', null), {
    caption: 'tests failed to load',
    tone: 'fail'
  })
  assert.deepEqual(main.targetStatusPresentation('invalid-config', null), {
    caption: 'config failed to load',
    tone: 'fail'
  })
  const diagnostic = {
    status: 'test-load-failed',
    summary: 'Playwright loaded the configuration but could not load its tests',
    detail: "Error: Cannot find module '../out/extension'",
    exitCode: 1,
    configPath: 'playwright.config.ts',
    cwd: '.',
    launcher: 'npm',
    playwrightVersion: '1.62.0',
    output: null,
    suggestion:
      'Run the project’s documented build or setup step, then retry. Wrightbench will not run project setup commands automatically.'
  }
  assert.deepEqual(main.targetDiagnosticPresentation('test-load-failed', diagnostic), {
    detail: "Error: Cannot find module '../out/extension'",
    suggestion: diagnostic.suggestion
  })
  const setupDiagnostic = {
    ...diagnostic,
    status: 'setup-required',
    summary: 'This configuration requires project authentication setup',
    detail: 'Storage state file does not exist!',
    suggestion:
      'Complete the project’s documented setup or authentication step to create the required state file, then retry. Wrightbench will not run project setup or authentication commands automatically.'
  }
  assert.deepEqual(main.targetDiagnosticPresentation('setup-required', setupDiagnostic), {
    detail: setupDiagnostic.detail,
    suggestion: setupDiagnostic.suggestion
  })
})

await test('compact -c config stays identical from scan through list and run', async () => {
  const root = fixtureWithFakePlaywright('compact-config-parity', {
    'package.json': JSON.stringify({
      name: 'compact-config-parity',
      private: true,
      devDependencies: { '@playwright/test': '^1.62.1' },
      scripts: { 'test:qa': 'STAGE=qa playwright test -cconfigs/qa.config.js --grep @smoke' }
    }),
    'configs/qa.config.js': 'module.exports = {}',
    'tests/a.spec.ts': 'test'
  })
  const candidate = main.scanWorkspace(root).candidates.find((item) => item.scriptName === 'test:qa')
  assert.ok(candidate)
  assert.equal(candidate.configPath, 'configs/qa.config.js')
  assert.deepEqual(candidate.extraArgs, ['--grep', '@smoke'])
  const target = main.candidateToTarget(candidate)
  const context = main.resolveTargetContext(root, target)
  assert.equal(context.ok, true)

  let listInvocation = null
  const report = reportModern(join(root, 'tests'), ['chromium'], [
    fileSuite('a.spec.ts', [spec('a.spec.ts', 'smoke', 1, 1, ['chromium'])])
  ])
  const listed = await main.listTarget(
    { workspaceRoot: root, target, profileEnv: {} },
    async (invocation) => {
      listInvocation = invocation
      return {
        code: 0,
        stdout: JSON.stringify(report) + '\n',
        stderr: '',
        timedOut: false,
        spawnError: null,
        stdoutTruncated: false
      }
    }
  )
  assert.equal(listed.status, 'ready')
  assert.deepEqual(
    listInvocation.args.filter((arg) => arg.startsWith('--config=')),
    [`--config=${context.context.configPath}`]
  )
  assert.ok(!listInvocation.args.some((arg) => arg.startsWith('-c')))

  const marker = join(root, 'run-record.json')
  writeFileSync(
    join(root, 'node_modules/@playwright/test/cli.js'),
    `const fs = require('fs'); const path = require('path'); fs.writeFileSync(path.join(process.cwd(), 'run-record.json'), JSON.stringify({ argv: process.argv.slice(2), stage: process.env.STAGE }));\n`
  )
  const previousSettings = main.loadSettings()
  main.saveSettings({ ...previousSettings, captureMode: 'balanced' })
  try {
    const events = []
    await main.startRun(
      {
        path: root,
        targetId: target.id,
        location: 'tests/a.spec.ts:1',
        trigger: 'manual'
      },
      target,
      target.scriptEnv,
      (payload) => events.push(payload.event)
    )
    const runRecord = await waitFor(
      () => (existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null),
      'compact-config runner invocation'
    )
    await waitFor(() => events.find((event) => event.type === 'finished'), 'runner cleanup')
    assert.equal(runRecord.stage, 'qa')
    assert.deepEqual(
      runRecord.argv.filter((arg) => arg.startsWith('--config=')),
      [`--config=${context.context.configPath}`]
    )
    assert.ok(!runRecord.argv.some((arg) => arg.startsWith('-c')))
  } finally {
    main.saveSettings(previousSettings)
  }
})

await test('runner: a nested recipe uses its cwd, local CLI, fixed context, and custom argv', async () => {
  const root = fixtureWithFakePlaywright('runner-target-context', {
    'packages/web/package.json': JSON.stringify({ name: 'web' }),
    'packages/web/playwright.config.js': 'module.exports = {}',
    'packages/web/tests/a.spec.ts': 'test'
  })
  const marker = join(root, 'packages/web/run-record.json')
  writeFileSync(
    join(root, 'node_modules/@playwright/test/cli.js'),
    `const fs = require('fs'); const path = require('path'); fs.writeFileSync(path.join(process.cwd(), 'run-record.json'), JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), stage: process.env.STAGE, ui: process.env.PW_TEST_REPORTER, events: process.env.WRIGHTBENCH_UI_EVENTS_FILE, session: process.env.WRIGHTBENCH_UI_SESSION_ID, attachments: process.env.WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR }));\n`
  )
  const target = {
    ...main.synthesizeLegacyTarget(),
    id: 'runner-recipe',
    label: 'test:monitor',
    cwd: 'packages/web',
    packageDir: 'packages/web',
    configPath: 'packages/web/playwright.config.js',
    source: 'script',
    scriptName: 'test:monitor',
    scriptEnv: { STAGE: 'script' },
    extraArgs: [
      '--project=chromium',
      '--grep',
      '@monitor',
      '--grep-invert',
      '@stateful|@destructive|@visual',
      '--',
      '--tenant=qa'
    ]
  }
  const started = await main.startRun(
    {
      path: root,
      targetId: target.id,
      location: 'packages/web/tests/a.spec.ts:1:7',
      grep: 'suite exact test$',
      workers: 2,
      trigger: 'manual'
    },
    target,
    {
      STAGE: 'profile',
      PW_TEST_REPORTER: 'malicious',
      WRIGHTBENCH_UI_EVENTS_FILE: 'malicious',
      WRIGHTBENCH_UI_SESSION_ID: 'malicious',
      WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR: 'malicious'
    },
    () => {}
  )
  const record = await waitFor(
    () => (existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null),
    'nested recipe invocation'
  )
  assert.equal(record.cwd, realpathSync(join(root, 'packages/web')))
  assert.equal(record.stage, 'profile')
  assert.equal(record.ui, '')
  assert.equal(record.events, '')
  assert.equal(record.session, '')
  assert.notEqual(record.attachments, 'malicious')
  const separator = record.argv.indexOf('--')
  assert.ok(separator > 0)
  assert.deepEqual(record.argv.slice(separator), ['--', '--tenant=qa'])
  assert.ok(record.argv.indexOf('--grep') < separator)
  assert.ok(record.argv.includes('@stateful|@destructive|@visual'))
  assert.ok(record.argv.some((arg) => arg.startsWith('--reporter=html,')))
  assert.ok(record.argv.some((arg) => arg.startsWith('--config=')))
  assert.ok(record.argv.includes('tests/a.spec.ts:1:7'))
  assert.ok(record.argv.includes('suite exact test$'))
  assert.ok(record.argv.includes('--workers=2'))
  await sleep(100)
  main.stopRun(started.runId)
})

await test('runnable: every sanitized invocation context is executable by the target-aware runner', () => {
  const root = join(work, 'runnable')
  rmSync(root, { recursive: true, force: true })
  writeFiles(root, { 'playwright.config.ts': 'export default {}' })
  const base = main.synthesizeLegacyTarget()
  assert.equal(main.runnableFor(root, base).runnable, true, 'legacy default target runs as before')
  assert.equal(
    main.runnableFor(root, { ...base, configPath: 'playwright.config.ts' }).runnable,
    true,
    'explicit conventional root config runs'
  )
  const nested = main.runnableFor(root, { ...base, cwd: 'packages/web', packageDir: 'packages/web' })
  assert.equal(nested.runnable, true)
  const withEnv = main.runnableFor(root, { ...base, scriptEnv: { TEST_ENV: 'qa' } })
  assert.equal(withEnv.runnable, true)
  const custom = main.runnableFor(root, { ...base, configPath: 'playwright.qa.config.ts' })
  assert.equal(custom.runnable, true)
})

// =====================================================================
// H. target-aware refresh (fixture 22)
// =====================================================================

const fileEvents = []
main.setProjectObservationSink({
  onProjectsChanged: () => {},
  onFilesChanged: (path, discovery) => fileEvents.push({ path, discovery, at: Date.now() })
})

const watchedDir = join(work, 'watched')
rmSync(watchedDir, { recursive: true, force: true })
writeFiles(watchedDir, {
  'playwright.custom.config.ts': 'export default {}',
  'suites/flow.e2e.ts': 'custom-named test',
  'suites/data/cases.json': '[]',
  'README.md': 'docs'
})
seedRegistry([{ id: 'watch-1', name: 'watched', path: watchedDir, addedAt: 'x' }])
main.syncProjectObservation()
// the discovery service registers the listing-derived surface
main.setDiscoverySurface(watchedDir, {
  files: new Set([join(watchedDir, 'suites', 'flow.e2e.ts')]),
  dirs: [join(watchedDir, 'suites')],
  configs: new Set([join(watchedDir, 'playwright.custom.config.ts')])
})
await sleep(400) // let chokidar settle

await test('refresh: a custom-named test file (no .spec/.test) triggers refresh (fixture 22)', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'suites', 'flow.e2e.ts'), 'edited')
  await waitFor(() => fileEvents.length > 0, 'custom-file invalidation')
  assert.equal(fileEvents[0].path, watchedDir)
  assert.equal(fileEvents[0].discovery, false, 'test edit is not a candidate re-evaluation')
})

await test('refresh: a NEW file under the resolved test root triggers refresh', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'suites', 'brand-new.e2e.ts'), 'new custom-named test')
  await waitFor(() => fileEvents.length > 0, 'new-file invalidation')
})

await test('refresh: data files that generate tests trigger refresh', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'suites', 'data', 'cases.json'), '[1]')
  await waitFor(() => fileEvents.length > 0, 'data-file invalidation')
})

await test('refresh: the active custom-named config triggers a discovery re-evaluation', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'playwright.custom.config.ts'), 'export default { changed: true }')
  const event = await waitFor(() => fileEvents[0], 'config invalidation')
  assert.equal(event.discovery, true)
})

await test('refresh: package.json changes re-evaluate candidates', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'package.json'), JSON.stringify({ name: 'watched' }))
  const event = await waitFor(() => fileEvents[0], 'package.json invalidation')
  assert.equal(event.discovery, true)
})

await test('refresh: unrelated files outside the test surface stay quiet', async () => {
  fileEvents.length = 0
  writeFileSync(join(watchedDir, 'README.md'), 'edited docs')
  writeFileSync(join(watchedDir, 'notes.txt'), 'irrelevant')
  await sleep(1200)
  assert.equal(fileEvents.length, 0)
})

await test('refresh: generated dirs stay ignored even under the test root', async () => {
  fileEvents.length = 0
  mkdirSync(join(watchedDir, 'suites', 'test-results'), { recursive: true })
  writeFileSync(join(watchedDir, 'suites', 'test-results', 'out.e2e.ts'), 'artifact')
  await sleep(1200)
  assert.equal(fileEvents.length, 0)
})

main.stopProjectObservation()

console.log(failures === 0 ? '\nall targets tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

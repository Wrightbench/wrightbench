// End-to-end target discovery against a REAL local Playwright installation.
//
// Needs WRIGHTBENCH_PW_MODULES pointing at a node_modules directory that
// contains @playwright/test (plus playwright/playwright-core). Nothing is
// downloaded; the fixture symlinks that installation. Run via:
//   WRIGHTBENCH_PW_MODULES=~/some-project/node_modules node tests/run-tests.mjs --live
//
// This proves the pieces the fake-CLI integration cannot: Playwright's own
// config evaluation, testMatch/testDir/project semantics, JSON shapes, and
// error/exit behavior for gated, broken, and empty configs.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const main = require('./.build/main.cjs')

const pwModules = process.env.WRIGHTBENCH_PW_MODULES
if (!pwModules || !existsSync(join(pwModules, '@playwright', 'test', 'package.json'))) {
  console.log(
    '(skipping targets-live: set WRIGHTBENCH_PW_MODULES to a node_modules dir containing @playwright/test)'
  )
  process.exit(0)
}

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

const root = join(tmpdir(), `wb-targets-live-${process.pid}`)
rmSync(root, { recursive: true, force: true })

function write(files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

write({
  'package.json': JSON.stringify({
    name: 'live-fixture',
    private: true,
    devDependencies: { '@playwright/test': '*' },
    scripts: {
      'test:qa': 'TEST_ENV=qa playwright test -c playwright.qa.config.js',
      'test:e2e': 'node tools/wrapper.js'
    }
  }),
  'tools/wrapper.js': 'process.exit(1)',
  // conventional config: three projects, two testDirs, stdout noise w/ braces
  'playwright.config.js': `
console.log('config noise { with braces } and more')
module.exports = {
  projects: [
    { name: 'chromium', testDir: './tests' },
    { name: 'firefox', testDir: './tests' },
    { name: 'api', testDir: './e2e', testMatch: /.*\\.e2e\\.js/ }
  ]
}
`,
  // env-gated custom-named config referenced by a package script
  'playwright.qa.config.js': `
if (!process.env.TEST_ENV) throw new Error('Please provide a correct TEST_ENV environment value (qa|staging)')
module.exports = { testDir: './qa' }
`,
  // empty + broken configs
  'playwright.empty.config.js': `module.exports = { testDir: './empty-dir' }`,
  'playwright.broken.config.js': `module.exports = { testDir: './tests'`,
  // default-convention specs (.spec + .test), describes, params, deep nesting
  'tests/checkout.spec.js': `
const { test } = require('@playwright/test')
test.describe('checkout', () => {
  test.describe('guest', () => {
    test('pays with card', async () => {})
    test('duplicate title', async () => {})
  })
  test.describe('member', () => {
    test('duplicate title', async () => {})
  })
})
for (const n of [1, 2]) {
  test('param ' + n, async () => {})
}
`,
  'tests/plain.test.js': `
const { test } = require('@playwright/test')
test('default test-dot naming', async () => {})
`,
  'tests/nested/deep/deep.spec.js': `
const { test } = require('@playwright/test')
test('deep test', async () => {})
`,
  'e2e/api.e2e.js': `
const { test } = require('@playwright/test')
test('api health', async () => {})
`,
  'qa/gated.spec.js': `
const { test } = require('@playwright/test')
test('qa only', async () => {})
`,
  'empty-dir/.gitkeep': ''
})
mkdirSync(join(root, 'node_modules'), { recursive: true })
for (const pkg of ['@playwright', 'playwright', 'playwright-core']) {
  const source = join(pwModules, pkg)
  if (existsSync(source)) symlinkSync(source, join(root, 'node_modules', pkg))
}

const version = main.resolvePlaywright(root)?.version
console.log(`  (using real Playwright v${version} from ${pwModules})`)

await test('live: full discovery finds every config and the qa script target', async () => {
  const discovery = await main.discoverTargets(root, null, { validate: true })
  const byLabel = new Map(discovery.candidates.map((c) => [c.label, c]))

  const conventional = byLabel.get('playwright.config.js')
  assert.ok(conventional, 'conventional config candidate')
  assert.equal(conventional.status, 'ready')
  // 5 in checkout.spec + 1 plain.test + 1 deep + 1 e2e = 8 unique declarations
  assert.equal(conventional.testCount, 8)
  assert.deepEqual(conventional.projectNames, ['chromium', 'firefox', 'api'])

  const qa = byLabel.get('test:qa · playwright.qa.config.js')
  assert.ok(qa, 'script target for the qa config')
  assert.equal(qa.status, 'ready', 'script env satisfied the gate')
  assert.equal(qa.testCount, 1)

  const empty = byLabel.get('playwright.empty.config.js')
  assert.equal(empty.status, 'empty')
  const broken = byLabel.get('playwright.broken.config.js')
  assert.equal(broken.status, 'invalid-config')

  assert.equal(discovery.recommendedTargetId, conventional.id)
  assert.ok(
    discovery.opaqueScripts.some((s) => s.scriptName === 'test:e2e'),
    'wrapper script surfaced as a custom launcher'
  )
})

await test('live: the tree keeps rootDir-relative paths, describes, params, projects', async () => {
  const target = {
    id: 't-live',
    cwd: '.',
    configPath: 'playwright.config.js',
    packageDir: '.',
    launcher: 'npm',
    scriptEnv: {},
    extraArgs: []
  }
  const result = await main.listTarget({ workspaceRoot: root, target, profileEnv: {} })
  assert.equal(result.status, 'ready')
  assert.equal(result.rootDir, '.', 'rootDir is the common ancestor of tests/ and e2e/')
  const files = result.tree.files.map((f) => f.file)
  assert.deepEqual(files.sort(), [
    'e2e/api.e2e.js',
    'tests/checkout.spec.js',
    'tests/nested/deep/deep.spec.js',
    'tests/plain.test.js'
  ])
  const checkout = result.tree.files.find((f) => f.file === 'tests/checkout.spec.js')
  const dupes = checkout.tests.filter((t) => t.title === 'duplicate title')
  assert.equal(dupes.length, 2, 'same leaf title in two describes stays distinct')
  assert.deepEqual(dupes.map((d) => d.titlePath.join(' › ')).sort(), [
    'checkout › guest › duplicate title',
    'checkout › member › duplicate title'
  ])
  const params = checkout.tests.filter((t) => t.title.startsWith('param '))
  assert.equal(params.length, 2, 'parameterized declarations on one line stay distinct')
  const shared = checkout.tests.find((t) => t.title === 'pays with card')
  assert.deepEqual(shared.projects.sort(), ['chromium', 'firefox'])
  const api = result.tree.files.find((f) => f.file === 'e2e/api.e2e.js')
  assert.deepEqual(api.tests[0].projects, ['api'], 'testMatch project split respected')
})

await test('live: env-gated config classifies then lists with the profile env', async () => {
  const target = {
    id: 't-gated',
    cwd: '.',
    configPath: 'playwright.qa.config.js',
    packageDir: '.',
    launcher: 'npm',
    scriptEnv: {},
    extraArgs: []
  }
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
  // single-testDir config: rootDir IS qa/, files are relative to it —
  // joining rootDir + file yields the cwd-valid location filter
  assert.equal(withEnv.rootDir, 'qa')
  assert.equal(withEnv.tree.files[0].file, 'gated.spec.js')
})

await test('live: a nested-package config is discovered and listed from the repo root', async () => {
  write({
    'packages/web/package.json': JSON.stringify({
      name: 'web',
      devDependencies: { '@playwright/test': '*' }
    }),
    'packages/web/playwright.config.js': `module.exports = { testDir: './checks' }`,
    'packages/web/checks/smoke.spec.js': `
const { test } = require('@playwright/test')
test('nested package smoke', async () => {})
`
  })
  const discovery = await main.discoverTargets(root, null, { validate: true })
  const nested = discovery.candidates.find((c) => c.cwd === 'packages/web')
  assert.ok(nested, 'nested candidate discovered from the root')
  assert.equal(nested.status, 'ready', 'hoisted install resolved from the nested package')
  assert.equal(nested.testCount, 1)
  // rootDir is workspace-root-relative so open-file/watch/codegen joins work
  assert.equal(nested.rootDir, 'packages/web/checks', 'rootDir relative to the workspace root')
})

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nall targets-live tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

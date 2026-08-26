// Sidebar logic tests: width clamping, settings validation, tree filtering,
// spec rollups, view-context pruning, and open-file safety.
// Runs with a throwaway HOME (see run-tests.mjs).
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

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

const home = homedir()
assert.ok(home.includes('wb-test-home'), 'must run with isolated HOME')

// ---------- width clamping + settings validation ----------

await test('sidebar width clamps to 220–380 and defaults on junk', () => {
  assert.equal(main.clampSidebarWidth(100), 220)
  assert.equal(main.clampSidebarWidth(500), 380)
  assert.equal(main.clampSidebarWidth(262), 262)
  assert.equal(main.clampSidebarWidth(299.6), 300)
  assert.equal(main.clampSidebarWidth(Number.NaN), 262)
  assert.equal(main.clampSidebarWidth('wide'), 262)
})

await test('existing settings files without workspaceUi still load, with defaults', () => {
  const dir = join(home, '.wrightbench')
  const file = join(dir, 'settings.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ theme: 'dark', runRetentionDays: 30 })
  )
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o755)
    chmodSync(file, 0o644)
  }
  const settings = main.loadSettings()
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.runRetentionDays, 30)
  assert.equal(settings.captureMode, 'full', 'legacy Balanced defaults migrate to Full evidence')
  assert.deepEqual(settings.workspaceUi, {
    sidebarCollapsed: false,
    sidebarWidth: 262,
    projectViews: {}
  })
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'legacy Wrightbench dir is tightened on load')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'legacy settings file is tightened on load')
  }
})

await test('saved capture choice is preserved after the Full-evidence migration', () => {
  main.saveSettings({ ...main.loadSettings(), captureMode: 'balanced' })
  assert.equal(main.loadSettings().captureMode, 'balanced')
  if (process.platform !== 'win32') {
    assert.equal(
      statSync(join(home, '.wrightbench', 'settings.json')).mode & 0o777,
      0o600,
      'atomic rewrites keep settings private'
    )
  }
})

await test('permission hardening never follows settings or state-directory symlinks', () => {
  if (process.platform === 'win32') return
  const dir = join(home, '.wrightbench')
  const settingsFile = join(dir, 'settings.json')
  const outsideFile = join(home, 'outside-settings.json')
  const outsideDir = join(home, 'outside-wrightbench')

  rmSync(settingsFile, { force: true })
  writeFileSync(outsideFile, JSON.stringify({ theme: 'dark' }))
  chmodSync(outsideFile, 0o644)
  symlinkSync(outsideFile, settingsFile)

  const defaults = main.loadSettings()
  assert.equal(defaults.theme, 'system', 'a settings symlink is not read')
  assert.equal(statSync(outsideFile).mode & 0o777, 0o644, 'the symlink target is not chmodded')
  main.saveSettings({ ...defaults, theme: 'light' })
  assert.equal(
    JSON.parse(readFileSync(outsideFile, 'utf8')).theme,
    'dark',
    'an atomic save replaces the symlink instead of writing through it'
  )

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  chmodSync(outsideDir, 0o755)
  chmodSync(join(outsideDir, 'settings.json'), 0o644)
  symlinkSync(outsideDir, dir)

  const throughDirectoryLink = main.loadSettings()
  assert.equal(throughDirectoryLink.theme, 'system')
  assert.equal(statSync(outsideDir).mode & 0o777, 0o755, 'the external directory is not chmodded')
  assert.equal(
    statSync(join(outsideDir, 'settings.json')).mode & 0o777,
    0o644,
    'files below the external directory are untouched'
  )
  assert.throws(
    () => main.saveSettings(throughDirectoryLink),
    /real directory|EEXIST/,
    'writes refuse a symlinked state directory'
  )

  rmSync(dir, { force: true })
  mkdirSync(dir, { recursive: true })
  main.saveSettings(throughDirectoryLink)
})

await test('environment profiles enforce bounded names, keys, values and unique identity', () => {
  const valid = [
    {
      name: 'qa profile',
      description: 'x'.repeat(500),
      env: {
        BASE_URL: 'https://example.test',
        CERTIFICATE: 'line one\nline two'
      }
    }
  ]
  assert.equal(main.isValidEnvProfiles(valid), true, 'losslessly editable multiline values are allowed')
  assert.equal(
    main.isValidEnvProfiles([{ name: 'qa', env: { 'API-KEY': 'value', '1PASSWORD': 'value' } }]),
    true,
    'non-shell environment names accepted by execve remain compatible'
  )
  assert.equal(main.isValidEnvProfiles([]), true)
  assert.equal(
    main.isValidEnvProfiles(
      Array.from({ length: 50 }, (_, index) => ({ name: `profile-${index}`, env: {} }))
    ),
    true
  )

  const invalid = [
    [{ name: '', env: {} }],
    [{ name: ' padded ', env: {} }],
    [{ name: 'bad\nname', env: {} }],
    [{ name: 'bad\u0085name', env: {} }],
    [{ name: 'x'.repeat(101), env: {} }],
    [
      { name: 'duplicate', env: {} },
      { name: 'duplicate', env: {} }
    ],
    [{ name: 'qa', description: 'x'.repeat(501), env: {} }],
    [{ name: 'qa', env: {}, unboundedExtra: 'x' }],
    [{ name: 'qa', env: new Date() }],
    [{ name: 'qa', env: { 'INVALID KEY': 'value' } }],
    [{ name: 'qa', env: { ['A'.repeat(257)]: 'value' } }],
    [{ name: 'qa', env: { VALID_KEY: `before\u0000after` } }],
    [{ name: 'qa', env: { VALID_KEY: 'x'.repeat(65_537) } }],
    [
      {
        name: 'qa',
        env: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, 'value'])
        )
      }
    ],
    Array.from({ length: 51 }, (_, index) => ({ name: `profile-${index}`, env: {} }))
  ]
  for (const profiles of invalid) assert.equal(main.isValidEnvProfiles(profiles), false)
})

await test('legacy environment profiles migrate individually without replacing the collection', () => {
  const settingsFile = join(home, '.wrightbench', 'settings.json')
  writeFileSync(
    settingsFile,
    JSON.stringify({
      theme: 'dark',
      envProfiles: [
        {
          name: ' qa ',
          description: 'legacy profile',
          env: {
            'API-KEY': 'keep-me',
            MULTILINE: 'line one\nline two',
            'INVALID KEY': 'cannot be represented safely'
          },
          legacyExtension: true
        },
        { malformed: true },
        { name: ' qa ', env: { SECOND: 'also-kept' } }
      ],
      defaultProfile: ' qa ',
      workspaceUi: {
        projectViews: {
          project: { envProfile: ' qa ' }
        }
      }
    })
  )

  const migrated = main.loadSettings()
  assert.deepEqual(
    migrated.envProfiles.map((profile) => profile.name),
    ['qa', 'qa-2']
  )
  assert.deepEqual(migrated.envProfiles[0].env, {
    'API-KEY': 'keep-me',
    MULTILINE: 'line one\nline two'
  })
  assert.deepEqual(migrated.envProfiles[1].env, { SECOND: 'also-kept' })
  assert.equal(migrated.defaultProfile, 'qa')
  assert.equal(migrated.workspaceUi.projectViews.project.envProfile, 'qa')

  main.updateSettings({ density: 'compact' })
  const persisted = JSON.parse(readFileSync(settingsFile, 'utf8'))
  assert.deepEqual(
    persisted.envProfiles.map((profile) => profile.name),
    ['qa', 'qa-2'],
    'an unrelated settings save persists the migrated profiles, not defaults'
  )
  assert.equal(persisted.envProfiles[0].env.MULTILINE, 'line one\nline two')
})

await test('profile editor text round-trips multiline, backslashes and significant spaces', () => {
  const original = {
    CERTIFICATE: 'line one\nline two\r\nline three',
    WINDOWS_PATH: String.raw`C:\secrets\new`,
    PADDED_SECRET: '  keep both sides  ',
    LITERAL_ESCAPE: String.raw`leave\nencoded`
  }
  const text = main.envProfileToText(original)
  assert.ok(text.includes(String.raw`line one\nline two\r\nline three`))
  assert.deepEqual(main.envProfileFromText(text), { env: original, error: null })
  assert.match(main.envProfileFromText('MISSING_EQUALS').error, /Line 1/)
  assert.match(main.envProfileFromText('A=one\nA=two').error, /repeats A/)
})

await test('invalid environment-profile updates are rejected without changing settings', () => {
  const settingsFile = join(home, '.wrightbench', 'settings.json')
  const validProfiles = [
    {
      name: 'qa',
      env: { CERTIFICATE: 'line one\nline two', BASE_URL: 'https://example.test' }
    }
  ]
  const saved = main.updateSettings({ envProfiles: validProfiles, defaultProfile: 'qa' })
  assert.deepEqual(saved.envProfiles, validProfiles)
  assert.equal(saved.defaultProfile, 'qa')
  assert.equal(main.loadSettings().envProfiles[0].env.CERTIFICATE, 'line one\nline two')

  const before = readFileSync(settingsFile, 'utf8')
  assert.throws(
    () =>
      main.updateSettings({
        envProfiles: [{ name: 'qa', env: { 'BAD=KEY': 'secret' } }],
        defaultProfile: 'qa'
      }),
    /invalid environment profiles/
  )
  assert.equal(readFileSync(settingsFile, 'utf8'), before, 'invalid profile patch is atomic')

  assert.throws(
    () => main.updateSettings({ defaultProfile: 'missing' }),
    /does not exist/
  )
  assert.equal(readFileSync(settingsFile, 'utf8'), before, 'invalid default patch is atomic')

  assert.throws(
    () => main.updateSettings({ envProfiles: [], defaultProfile: 'qa' }),
    /does not exist/
  )
  assert.equal(readFileSync(settingsFile, 'utf8'), before, 'paired profile/default patch is atomic')
})

await test('capture policies resolve their trace behavior explicitly', () => {
  assert.equal(main.traceModeForCapture('full', false), 'on')
  assert.equal(main.traceModeForCapture('full', true), 'on')
  assert.equal(main.traceModeForCapture('balanced', true), 'on')
  assert.equal(main.traceModeForCapture('balanced', false), 'retain-on-failure')
  assert.equal(main.traceModeForCapture('failures', true), 'retain-on-failure')
})

await test('Full evidence config overrides every project without editing the repo', async () => {
  const project = join(home, 'full-evidence-project')
  mkdirSync(join(project, 'tests'), { recursive: true })
  const original = `export default {
  testDir: './tests',
  globalSetup: './setup.mjs',
  webServer: { command: 'npm start' },
  use: { trace: 'off', screenshot: 'off', video: 'off', storageState: './state.json' },
  projects: [{ name: 'webkit', use: { browserName: 'webkit', video: 'off' } }]
}\n`
  writeFileSync(join(project, 'playwright.config.mjs'), original)
  writeFileSync(join(project, 'setup.mjs'), 'export default async function setup() {}\n')

  const runtime = main.createRuntimeCaptureConfig(project, 'full')
  assert.ok(runtime)
  assert.equal(existsSync(runtime.path), true)
  assert.equal(main.findPlaywrightConfig(project), join(project, 'playwright.config.mjs'))

  const loaded = await import(`${pathToFileURL(runtime.path).href}?test=${Date.now()}`)
  const config = loaded.default
  assert.equal(config.testDir, join(project, 'tests'))
  assert.equal(config.globalSetup, join(project, 'setup.mjs'))
  assert.equal(config.webServer.cwd, project)
  assert.equal(config.use.storageState, join(project, 'state.json'))
  assert.deepEqual(
    { trace: config.use.trace, screenshot: config.use.screenshot, video: config.use.video },
    { trace: 'on', screenshot: 'on', video: 'on' }
  )
  assert.deepEqual(
    {
      trace: config.projects[0].use.trace,
      screenshot: config.projects[0].use.screenshot,
      video: config.projects[0].use.video
    },
    { trace: 'on', screenshot: 'on', video: 'on' }
  )
  assert.equal(readFileSync(join(project, 'playwright.config.mjs'), 'utf8'), original)

  runtime.cleanup()
  assert.equal(existsSync(runtime.path), false)
  assert.equal(main.createRuntimeCaptureConfig(project, 'balanced'), null)
})

await test('Full evidence wraps the selected nested custom configuration', async () => {
  const workspace = join(home, 'nested-capture-workspace')
  const packageDir = join(workspace, 'packages', 'web')
  const configPath = join(packageDir, 'configs', 'e2e.config.mjs')
  mkdirSync(join(packageDir, 'configs'), { recursive: true })
  writeFileSync(configPath, `export default { testDir: '../specs', use: { trace: 'off' } }\n`)

  const runtime = main.createRuntimeCaptureConfig(workspace, 'full', {
    cwd: packageDir,
    packageDir,
    configPath
  })
  assert.ok(runtime)
  const loaded = await import(`${pathToFileURL(runtime.path).href}?test=${Date.now()}`)
  assert.equal(loaded.default.testDir, join(packageDir, 'specs'))
  assert.equal(loaded.default.use.trace, 'on')
  runtime.cleanup()
})

await test('Full evidence supports Playwright default resolution without a config file', async () => {
  const project = join(home, 'configless-full-evidence')
  mkdirSync(join(project, 'tests'), { recursive: true })
  const runtime = main.createRuntimeCaptureConfig(project, 'full', {
    cwd: project,
    configPath: null,
    packageDir: project
  })
  assert.ok(runtime)
  const loaded = await import(`${pathToFileURL(runtime.path).href}?test=${Date.now()}`)
  assert.equal(loaded.default.testDir, project)
  assert.deepEqual(loaded.default.use, { trace: 'on', screenshot: 'on', video: 'on' })
  runtime.cleanup()
})

await test('malformed workspaceUi values fall back safely', () => {
  const ui = main.sanitizeWorkspaceUi({
    sidebarCollapsed: 'yes',
    sidebarWidth: 9999,
    projectViews: {
      good: {
        expandedFiles: ['a.spec.ts', 42, 'b.spec.ts'],
        selectedKey: 'a.spec.ts:3:t',
        query: 'x'.repeat(999),
        statusFilter: 'bogus',
        scrollTop: -50
      },
      junk: 'not-an-object'
    }
  })
  assert.equal(ui.sidebarCollapsed, false)
  assert.equal(ui.sidebarWidth, 380)
  assert.deepEqual(Object.keys(ui.projectViews), ['good'])
  assert.deepEqual(ui.projectViews.good.expandedFiles, ['a.spec.ts', 'b.spec.ts'])
  assert.equal(ui.projectViews.good.query.length, 200)
  assert.equal(ui.projectViews.good.statusFilter, 'all')
  assert.equal(ui.projectViews.good.scrollTop, 0)
  assert.deepEqual(main.sanitizeWorkspaceUi('garbage'), {
    sidebarCollapsed: false,
    sidebarWidth: 262,
    projectViews: {}
  })
})

await test('removed changed filter migrates to All tests', () => {
  const ui = main.sanitizeWorkspaceUi({
    projectViews: {
      legacy: {
        expandedFiles: [],
        selectedKey: null,
        query: '',
        statusFilter: 'changed',
        scrollTop: 0
      }
    }
  })
  assert.equal(ui.projectViews.legacy.statusFilter, 'all')
})

await test('pruneProjectViewContext drops only that project id', () => {
  main.saveSettings({
    ...main.loadSettings(),
    workspaceUi: {
      sidebarCollapsed: true,
      sidebarWidth: 300,
      projectViews: {
        keep: { expandedFiles: [], selectedKey: null, query: '', statusFilter: 'all', scrollTop: 0 },
        drop: { expandedFiles: [], selectedKey: null, query: '', statusFilter: 'all', scrollTop: 0 }
      }
    }
  })
  main.pruneProjectViewContext('drop')
  const after = main.loadSettings().workspaceUi
  assert.deepEqual(Object.keys(after.projectViews), ['keep'])
  assert.equal(after.sidebarCollapsed, true)
  assert.equal(after.sidebarWidth, 300)
})

// ---------- tree filtering ----------

const TREE = {
  targetId: 'target-a',
  rootDir: 'tests/e2e',
  projectNames: ['chromium'],
  totalTests: 5,
  files: [
    {
      file: 'checkout.spec.ts',
      tests: [
        {
          file: 'checkout.spec.ts',
          line: 3,
          column: 1,
          title: 'completes guest checkout',
          titlePath: ['completes guest checkout'],
          projects: []
        },
        {
          file: 'checkout.spec.ts',
          line: 9,
          column: 1,
          title: 'applies discount code',
          titlePath: ['applies discount code'],
          projects: []
        }
      ]
    },
    {
      file: 'auth.spec.ts',
      tests: [
        {
          file: 'auth.spec.ts',
          line: 3,
          column: 1,
          title: 'signs in with magic link',
          titlePath: ['signs in with magic link'],
          projects: []
        },
        {
          file: 'auth.spec.ts',
          line: 8,
          column: 1,
          title: 'locks account after failures',
          titlePath: ['locks account after failures'],
          projects: []
        }
      ]
    },
    {
      file: 'cart.spec.ts',
      tests: [
        {
          file: 'cart.spec.ts',
          line: 5,
          column: 1,
          title: 'updates quantity',
          titlePath: ['updates quantity'],
          projects: []
        }
      ]
    }
  ]
}

const STATUSES = {
  [main.testKeyOf(TREE.files[0].tests[0], TREE.targetId)]: 'pass',
  [main.testKeyOf(TREE.files[0].tests[1], TREE.targetId)]: 'fail',
  [main.testKeyOf(TREE.files[1].tests[0], TREE.targetId)]: 'flaky',
  [main.testKeyOf(TREE.files[1].tests[1], TREE.targetId)]: 'skipped'
  // cart:5 has no result → 'none'
}
const statusOf = (key) => STATUSES[key] ?? 'none'
const base = { statusFilter: 'all' }

await test('project selector lists only projects applicable to the selected test', () => {
  const first = TREE.files[0].tests[0]
  const second = TREE.files[0].tests[1]
  const tree = {
    ...TREE,
    projectNames: ['setup', 'chromium', 'firefox', 'webkit'],
    files: [
      {
        ...TREE.files[0],
        tests: [
          { ...first, projects: ['webkit', 'chromium'] },
          { ...second, projects: ['firefox'] }
        ]
      }
    ]
  }

  assert.deepEqual(
    main.applicableProjectNames(tree, main.testKeyOf(tree.files[0].tests[0], tree.targetId)),
    ['chromium', 'webkit'],
    'config order wins over reporter order'
  )
  assert.deepEqual(
    main.applicableProjectNames(tree, main.testKeyOf(tree.files[0].tests[1], tree.targetId)),
    ['firefox']
  )
})

await test('project selector safely falls back when per-test project metadata is unavailable', () => {
  assert.deepEqual(main.applicableProjectNames(TREE, main.testKeyOf(TREE.files[0].tests[0], TREE.targetId)), [
    'chromium'
  ])
  assert.deepEqual(main.applicableProjectNames(TREE, null), ['chromium'])
})

await test('folder view builds a nested hierarchy from discovered spec paths', () => {
  const nested = main.buildTestFolderTree([
    TREE.files[0],
    { ...TREE.files[1], file: 'auth/magic/auth.spec.ts' },
    { ...TREE.files[2], file: 'auth/cart.spec.ts' },
    { ...TREE.files[0], file: 'store/checkout.spec.ts' }
  ])

  assert.deepEqual(nested.files.map((file) => file.file), ['checkout.spec.ts'])
  assert.deepEqual(nested.folders.map((folder) => folder.name), ['auth', 'store'])
  assert.equal(nested.folders[0].path, 'auth')
  assert.equal(nested.folders[0].testCount, 3)
  assert.deepEqual(nested.folders[0].files.map((file) => file.file), ['auth/cart.spec.ts'])
  assert.deepEqual(nested.folders[0].folders.map((folder) => folder.path), ['auth/magic'])
  assert.deepEqual(nested.folders[0].folders[0].files.map((file) => file.file), [
    'auth/magic/auth.spec.ts'
  ])
})

await test('folder view does not mutate or rediscover the filtered test files', () => {
  const filtered = main.filterTree(TREE, statusOf, { query: 'discount', statusFilter: 'all' })
  const before = structuredClone(filtered.files)
  const nested = main.buildTestFolderTree(filtered.files)

  assert.deepEqual(filtered.files, before)
  assert.equal(nested.files.length, 1)
  assert.deepEqual(nested.files[0].tests.map((test) => test.title), ['applies discount code'])
})

await test('query matches test titles and spec paths, case-insensitive, trimmed', () => {
  const byTitle = main.filterTree(TREE, statusOf, { ...base, query: '  DISCOUNT ' })
  assert.deepEqual(byTitle.files.map((f) => f.file), ['checkout.spec.ts'])
  assert.equal(byTitle.matchCount, 1)
  const byPath = main.filterTree(TREE, statusOf, { ...base, query: 'auth.spec' })
  assert.deepEqual(byPath.files.map((f) => f.file), ['auth.spec.ts'])
  assert.equal(byPath.matchCount, 2, 'a spec-path match admits all its tests')
})

await test('passed / failed / flaky / skipped / not-run status filters', () => {
  const passed = main.filterTree(TREE, statusOf, { ...base, query: '', statusFilter: 'passed' })
  assert.equal(passed.matchCount, 1)
  assert.equal(passed.files[0].tests[0].title, 'completes guest checkout')
  const failed = main.filterTree(TREE, statusOf, { ...base, query: '', statusFilter: 'failed' })
  assert.equal(failed.matchCount, 1)
  assert.equal(failed.files[0].tests[0].title, 'applies discount code')
  const flaky = main.filterTree(TREE, statusOf, { ...base, query: '', statusFilter: 'flaky' })
  assert.equal(flaky.matchCount, 1)
  assert.equal(flaky.files[0].file, 'auth.spec.ts')
  const skipped = main.filterTree(TREE, statusOf, { ...base, query: '', statusFilter: 'skipped' })
  assert.equal(skipped.matchCount, 1)
  assert.equal(skipped.files[0].tests[0].title, 'locks account after failures')
  const notRun = main.filterTree(TREE, statusOf, { ...base, query: '', statusFilter: 'not-run' })
  assert.equal(notRun.matchCount, 1)
  assert.equal(notRun.files[0].tests[0].title, 'updates quantity')
})

await test('query and status combine with AND', () => {
  const both = main.filterTree(TREE, statusOf, {
    ...base,
    query: 'checkout',
    statusFilter: 'failed'
  })
  assert.equal(both.matchCount, 1)
  assert.equal(both.files[0].tests[0].line, 9)
  const none = main.filterTree(TREE, statusOf, { ...base, query: 'auth', statusFilter: 'failed' })
  assert.equal(none.files.length, 0)
})

await test('filtering is pure — the tree and no expansion state are touched', () => {
  const before = JSON.stringify(TREE)
  const out = main.filterTree(TREE, statusOf, { ...base, query: 'checkout' })
  assert.equal(JSON.stringify(TREE), before)
  assert.notEqual(out.files[0], undefined)
  const unfiltered = main.filterTree(TREE, statusOf, { ...base, query: '' })
  assert.equal(unfiltered.filtering, false)
  assert.equal(unfiltered.files, TREE.files, 'no filter returns the same objects')
})

// ---------- spec rollups + progress ----------

await test('spec rollup priority: fail > flaky > pass > none', () => {
  assert.equal(main.specSummary(['pass', 'flaky', 'fail']).worst, 'fail')
  assert.equal(main.specSummary(['pass', 'flaky']).worst, 'flaky')
  assert.equal(main.specSummary(['pass', 'none']).worst, 'pass')
  assert.equal(main.specSummary(['none', 'skipped']).worst, 'none')
})

await test('spec run progress counts declarations, flags running/queued', () => {
  const mid = main.specSummary(['pass', 'fail', 'running', 'queued'])
  assert.equal(mid.done, 2)
  assert.equal(mid.total, 4)
  assert.equal(mid.anyRunning, true)
  assert.equal(mid.running, true)
  assert.equal(mid.allQueued, false)
  const queued = main.specSummary(['queued', 'queued'])
  assert.equal(queued.allQueued, true)
  const idle = main.specSummary(['pass', 'fail'])
  assert.equal(idle.running, false)
})

// ---------- view-context pruning + test locations ----------

await test('restored context keeps only specs/tests that still exist', () => {
  const pruned = main.pruneViewContext(
    {
      expandedFiles: ['checkout.spec.ts', 'deleted.spec.ts'],
      selectedKey: 'deleted.spec.ts:4:gone test',
      query: 'q',
      statusFilter: 'failed',
      scrollTop: 120
    },
    TREE
  )
  assert.deepEqual(pruned.expandedFiles, ['checkout.spec.ts'])
  assert.equal(pruned.selectedKey, null)
  assert.equal(pruned.query, 'q')
  const kept = main.pruneViewContext(
    {
      expandedFiles: ['auth.spec.ts'],
      selectedKey: 'auth.spec.ts:3:signs in with magic link',
      query: '',
      statusFilter: 'all',
      scrollTop: 0
    },
    TREE
  )
  assert.equal(
    kept.selectedKey,
    main.testKeyOf(TREE.files[1].tests[0], TREE.targetId),
    'a unique legacy selection is upgraded to declaration identity'
  )
})

await test('same-line duplicate titles keep distinct identities and reject ambiguous legacy selection', () => {
  const first = {
    file: 'dup.spec.ts',
    line: 5,
    column: 3,
    title: 'can login',
    titlePath: ['admin', 'can login'],
    projects: ['chromium']
  }
  const second = {
    ...first,
    titlePath: ['user', 'can login']
  }
  const tree = {
    targetId: 'target-duplicates',
    rootDir: '.',
    projectNames: ['chromium'],
    totalTests: 2,
    files: [{ file: 'dup.spec.ts', tests: [first, second] }]
  }
  const firstKey = main.testKeyOf(first, tree.targetId)
  const secondKey = main.testKeyOf(second, tree.targetId)
  assert.notEqual(firstKey, secondKey)

  const exact = main.pruneViewContext(
    {
      expandedFiles: ['dup.spec.ts'],
      selectedKey: secondKey,
      query: '',
      statusFilter: 'all',
      scrollTop: 0,
      envProfile: null
    },
    tree
  )
  assert.equal(exact.selectedKey, secondKey)

  const legacy = main.pruneViewContext(
    {
      ...exact,
      selectedKey: 'dup.spec.ts:5:can login'
    },
    tree
  )
  assert.equal(legacy.selectedKey, null, 'legacy identity cannot guess between two declarations')
})

await test('single-test run filters preserve location column and exact title suffix', () => {
  assert.equal(main.buildTestLocation('tests/e2e', 'checkout.spec.ts', 9), 'tests/e2e/checkout.spec.ts:9')
  assert.equal(
    main.buildTestLocation('tests/e2e', 'checkout.spec.ts', 9, 17),
    'tests/e2e/checkout.spec.ts:9:17'
  )
  assert.equal(main.buildTestLocation(null, 'a.spec.ts', 3), 'a.spec.ts:3')
  assert.equal(main.buildTestLocation('.', 'a.spec.ts', 3), 'a.spec.ts:3')
  assert.equal(
    main.buildTestTitleGrep(['checkout (guest)', 'uses $5.00 coupon?']),
    'checkout \\(guest\\) uses \\$5\\.00 coupon\\?$'
  )
  assert.equal(main.specRootPath('e2e/', 'sub\\a.spec.ts'), 'e2e/sub/a.spec.ts')
})

// ---------- open-file safety ----------

await test('open-file resolution rejects traversal and absolute paths', () => {
  const project = join(home, 'proj')
  mkdirSync(project, { recursive: true })
  assert.equal(main.resolveProjectFile(project, '../outside.ts'), null)
  assert.equal(main.resolveProjectFile(project, 'a/../../outside.ts'), null)
  assert.equal(main.resolveProjectFile(project, '/etc/hosts'), null)
  assert.equal(main.resolveProjectFile(project, ''), null)
  assert.equal(
    main.resolveProjectFile(project, 'tests/a.spec.ts'),
    join(project, 'tests', 'a.spec.ts')
  )
  assert.equal(main.resolveProjectFile(project, 'tests/../b.spec.ts'), join(project, 'b.spec.ts'))
})

console.log(failures === 0 ? '\nall sidebar tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

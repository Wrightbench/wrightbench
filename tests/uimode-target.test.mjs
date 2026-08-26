import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
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

const target = (overrides = {}) => ({
  id: 'base',
  label: 'packages/e2e/playwright.custom.ts',
  cwd: 'packages/e2e',
  configPath: 'packages/e2e/playwright.custom.ts',
  packageDir: 'packages/e2e',
  launcher: 'npm',
  source: 'config',
  scriptName: null,
  scriptEnv: {},
  extraArgs: [],
  playwrightVersion: '1.62.0',
  testCount: 4,
  ...overrides
})

const project = (path, targets, activeTargetId) => ({
  id: 'project',
  name: 'fixture',
  path,
  addedAt: new Date(0).toISOString(),
  targets,
  activeTargetId
})

await test('startup diagnostics prefer the error headline over Node boilerplate', () => {
  const lines = [
    'node:internal/modules/cjs/loader:685',
    'throw e;',
    '^',
    "Error: Cannot find module '/repo/node_modules/playwright/lib/program.js'",
    ...Array.from({ length: 16 }, (_, index) => `at fixture${index} (/repo/file.js:${index + 1}:1)`),
    "code: 'MODULE_NOT_FOUND',",
    "path: '/repo/node_modules/playwright'",
    '}',
    'Node.js v24.19.0'
  ]
  assert.equal(
    main.selectUiModeDiagnostic(lines, 'UI Mode server exited unexpectedly'),
    "Error: Cannot find module '/repo/node_modules/playwright/lib/program.js'"
  )
  assert.equal(
    main.selectUiModeDiagnostic(
      ['node:internal/modules/cjs/loader:685', 'Permission denied while loading config', 'Node.js v24.19.0'],
      'fallback'
    ),
    'Permission denied while loading config'
  )
  assert.equal(
    main.selectUiModeDiagnostic(['Node.js v24.19.0'], 'UI Mode server exited unexpectedly'),
    'UI Mode server exited unexpectedly'
  )
})

await test('resolver maps a selected recipe to its registered base configuration', () => {
  const base = target()
  const recipe = target({
    id: 'recipe',
    label: 'smoke',
    source: 'script',
    scriptName: 'test:smoke',
    scriptEnv: { API_MODE: 'mock' },
    extraArgs: ['--project=chromium', '--grep', '@smoke']
  })
  const resolved = main.resolveUiModeRequest(
    { path: '/repo', targetId: recipe.id, profile: 'staging' },
    [project('/repo', [base, recipe], recipe.id)]
  )
  assert.equal(resolved.targetId, recipe.id)
  assert.equal(resolved.target.id, base.id)
  assert.equal(resolved.profile, null)
  assert.deepEqual(resolved.recipeEnv, { API_MODE: 'mock' })
  assert.deepEqual(resolved.target.extraArgs, [], 'recipe filters are not sent to native UI Mode')
})

await test('resolver rejects malformed requests, unknown projects, and stale targets', () => {
  const base = target()
  const registered = project('/repo', [base], base.id)
  for (const malformed of [null, undefined, 'not-an-object', [], {}]) {
    assert.throws(
      () => main.resolveUiModeRequest(malformed, [registered]),
      /invalid UI Mode request|invalid project path/
    )
  }
  assert.throws(
    () => main.resolveUiModeRequest({ path: 'relative', targetId: base.id }, [registered]),
    /invalid project path/
  )
  assert.throws(
    () => main.resolveUiModeRequest({ path: '/unknown', targetId: base.id }, [registered]),
    /unknown project/
  )
  for (const targetId of [null, 1, '', `bad\u0000id`, 'x'.repeat(65)]) {
    assert.throws(
      () => main.resolveUiModeRequest({ path: '/repo', targetId }, [registered]),
      /missing or invalid test configuration/
    )
  }
  assert.throws(
    () => main.resolveUiModeRequest({ path: '/repo', targetId: 'unknown' }, [registered]),
    /configuration changed/
  )
})

await test('resolver maps only exact recipes and rejects stale or orphaned recipes', () => {
  const base = target()
  const recipe = target({
    id: 'recipe',
    source: 'script',
    scriptName: 'test:smoke',
    extraArgs: ['--grep=@smoke']
  })
  const registered = project('/repo', [base, recipe], base.id)
  assert.throws(
    () =>
      main.resolveUiModeRequest(
        { path: '/repo', targetId: recipe.id, profile: null },
        [registered]
      ),
    /configuration changed/
  )
  assert.throws(
    () =>
      main.resolveUiModeRequest(
        { path: '/repo', targetId: recipe.id, profile: null },
        [project('/repo', [recipe], recipe.id)]
    ),
    /no base configuration/
  )
  const wrongBase = target({ id: 'wrong-base', packageDir: 'packages/other' })
  assert.throws(
    () =>
      main.resolveUiModeRequest(
        { path: '/repo', targetId: recipe.id, profile: null },
        [project('/repo', [wrongBase, recipe], recipe.id)]
      ),
    /no base configuration/
  )
})

await test('resolver ignores legacy environment profile input', () => {
  const base = target()
  const registered = project('/repo', [base], base.id)
  for (const profile of [undefined, null, '', 'staging', false, 7, {}, `bad\u0000profile`]) {
    const resolved = main.resolveUiModeRequest(
      { path: '/repo', targetId: base.id, profile },
      [registered]
    )
    assert.equal(resolved.profile, null)
  }
})

await test('loopback endpoint validation rejects remote or credentialed websocket URLs', () => {
  const valid = main.validateUiModeWsEndpoint('ws://127.0.0.1:43123/session-guid')
  assert.equal(valid.port, 43123)
  assert.match(valid.ws, /^ws:\/\/127\.0\.0\.1:43123\/session-guid/)
  // uiMode.html resolves the `ws` query value against its own origin (1.45:
  // `new URL('../' + ws, location)`), so the page must be handed the bare
  // GUID path — a full ws:// URL only happens to work on newer bundles.
  assert.equal(valid.wsPath, 'session-guid')
  for (const endpoint of [
    'wss://127.0.0.1:43123/session-guid',
    'ws://example.com:43123/session-guid',
    'ws://localhost:43123/session-guid',
    'ws://127.0.0.2:43123/session-guid',
    'ws://[::1]:43123/session-guid',
    'ws://user:password@127.0.0.1:43123/session-guid',
    'ws://127.0.0.1/session-guid',
    'ws://127.0.0.1:43123/session-guid?redirect=1',
    'ws://127.0.0.1:43123/session-guid#fragment',
    `ws://127.0.0.1:43123/${'x'.repeat(4_096)}`
  ]) {
    assert.throws(() => main.validateUiModeWsEndpoint(endpoint), /WebSocket endpoint/)
  }
})

const workspace = mkdtempSync(join(tmpdir(), 'wb-ui-target-'))
const outsideWorkspace = mkdtempSync(join(tmpdir(), 'wb-ui-outside-'))
try {
  const packageDir = join(workspace, 'packages', 'e2e')
  const install = join(packageDir, 'node_modules', '@playwright', 'test')
  mkdirSync(install, { recursive: true })
  const manifest = join(install, 'package.json')
  const cli = join(install, 'cli.js')
  writeFileSync(
    manifest,
    JSON.stringify({ name: '@playwright/test', version: '1.62.0' })
  )
  writeFileSync(
    cli,
    [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const configPath = args.find(arg => arg.startsWith('--config='))?.slice('--config='.length) ?? null",
      "const configSource = configPath && fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''",
      "const fullEvidence = [\"trace: 'on'\", \"screenshot: 'on'\", \"video: 'on'\"].every(value => configSource.includes(value))",
      "const observed = { args, cwd: process.cwd(), configPath, fullEvidence, recipe: process.env.RECIPE_VALUE ?? null, recipeOnly: process.env.RECIPE_ONLY ?? null, profileOnly: process.env.PROFILE_ONLY ?? null, reporter: process.env.PW_TEST_REPORTER ?? null, eventsFile: process.env.WRIGHTBENCH_UI_EVENTS_FILE ?? null, session: process.env.WRIGHTBENCH_UI_SESSION_ID ?? null, attachmentsDir: process.env.WRIGHTBENCH_REPORTER_ATTACHMENTS_DIR ?? null }",
      "const probe = (value) => { if (process.env.WB_UI_PROBE_FILE) fs.appendFileSync(process.env.WB_UI_PROBE_FILE, `${JSON.stringify(value)}\\n`) }",
      "process.on('uncaughtException', (error) => { probe({ uncaught: error.stack ?? error.message }); console.error(error); process.exit(1) })",
      "process.on('exit', (code) => probe({ exit: code }))",
      'probe(observed)',
      "if (process.env.WB_UI_STARTUP_ERROR === '1') {",
      "  console.error(\"node:internal/modules/cjs/loader:685\\n  throw e;\\n  ^\\n\\nError: Cannot find module '/repo/node_modules/playwright/lib/program.js'\\n    at fixture (/repo/cli.js:1:1)\\n{\\n  code: 'MODULE_NOT_FOUND',\\n  path: '/repo/node_modules/playwright'\\n}\\n\\nNode.js v24.19.0\")",
      '  process.exit(1)',
      '}',
      "if (process.argv[2] === 'test-server') {",
      "  const http = require('node:http')",
      "  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Playwright</title>') })",
      "  const listen = () => server.listen(0, '127.0.0.1', () => console.log(`Listening on ws://127.0.0.1:${server.address().port}/fixture-session`))",
      "  setTimeout(listen, Number(process.env.WB_UI_SERVER_DELAY_MS ?? 0))",
      '} else {',
      '  setInterval(() => {}, 1000)',
      '}'
    ].join('\n')
  )
  const config = join(packageDir, 'playwright.custom.ts')
  writeFileSync(config, 'export default {}\n')

  const probe = join(workspace, 'probe.ndjson')
  process.env.WB_UI_PROBE_FILE = probe
  const probeRows = () => {
    if (!existsSync(probe)) return []
    const text = readFileSync(probe, 'utf8').trim()
    return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line))
  }
  const waitFor = async (predicate, message, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${message}`)
  }
  const settingsDir = main.wrightbenchDir()
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(
    join(settingsDir, 'settings.json'),
    JSON.stringify({
      envProfiles: [
        {
          name: 'staging',
          env: {
            RECIPE_VALUE: 'profile',
            PROFILE_ONLY: 'yes',
            PW_TEST_REPORTER: 'profile-reporter',
            WRIGHTBENCH_UI_SESSION_ID: 'profile-session'
          }
        }
      ],
      defaultProfile: 'staging'
    })
  )

  const base = target()
  const recipe = target({
    id: 'recipe',
    source: 'script',
    scriptName: 'test:smoke',
    scriptEnv: {
      RECIPE_VALUE: 'recipe',
      RECIPE_ONLY: 'yes',
      WRIGHTBENCH_UI_EVENTS_FILE: 'recipe-events'
    },
    extraArgs: ['--project=chromium', '--grep=@smoke']
  })
  const request = main.resolveUiModeRequest(
    { path: workspace, targetId: recipe.id, profile: 'staging' },
    [project(workspace, [base, recipe], recipe.id)]
  )
  const canonicalWorkspace = realpathSync(workspace)
  const canonicalPackageDir = realpathSync(packageDir)
  const canonicalConfig = realpathSync(config)
  const canonicalCli = realpathSync(cli)

  await test('launch specs use the nested local CLI/cwd/custom config and stable identity', () => {
    const embedded = main.resolveUiModeLaunchSpec(request, 'embedded')
    assert.equal(embedded.command, 'node')
    assert.equal(embedded.cwd, canonicalPackageDir)
    assert.equal(embedded.configPath, canonicalConfig)
    assert.equal(embedded.playwrightVersion, '1.62.0')
    assert.deepEqual(embedded.args, [
      canonicalCli,
      'test-server',
      `--config=${canonicalConfig}`,
      '--host=127.0.0.1',
      '--port=0'
    ])
    const external = main.resolveUiModeLaunchSpec(request, 'external')
    assert.deepEqual(external.args, [
      canonicalCli,
      'test',
      '--ui',
      '--ui-host=127.0.0.1',
      `--config=${canonicalConfig}`
    ])
    assert.equal(external.cwd, canonicalPackageDir)
    assert.equal(external.identity, embedded.identity, 'launch form does not fork context identity')
    const identity = JSON.parse(embedded.identity)
    assert.deepEqual(identity.slice(0, 6), [
      recipe.id,
      base.id,
      canonicalPackageDir,
      canonicalConfig,
      canonicalCli,
      '1.62.0'
    ])
    const effectiveEnv = new Map(identity[6])
    assert.equal(effectiveEnv.get('RECIPE_VALUE'), 'recipe')
    assert.equal(effectiveEnv.get('RECIPE_ONLY'), 'yes')
    assert.equal(effectiveEnv.get('PROFILE_ONLY'), undefined)
    const changedProfile = main.resolveUiModeLaunchSpec({ ...request, profile: 'legacy' }, 'embedded')
    const changedRecipeEnv = main.resolveUiModeLaunchSpec(
      { ...request, recipeEnv: { ...request.recipeEnv, NEW_CONTEXT: 'yes' } },
      'embedded'
    )
    assert.equal(changedProfile.identity, embedded.identity)
    assert.notEqual(changedRecipeEnv.identity, embedded.identity)
    assert.ok(!external.args.some((arg) => arg.includes('@smoke')))
    assert.ok(!external.args.some((arg) => arg.includes('chromium')))
  })

  await test('launch resolution rejects escaped targets and missing local Playwright', () => {
    assert.throws(
      () =>
        main.resolveUiModeLaunchSpec(
          { ...request, target: { ...request.target, cwd: '../outside' } },
          'embedded'
        ),
      /outside this workspace/
    )
    const outsideConfig = join(outsideWorkspace, 'escape.config.ts')
    writeFileSync(outsideConfig, 'export default {}\n')
    const linkedConfig = join(packageDir, 'escape.config.ts')
    symlinkSync(outsideConfig, linkedConfig)
    assert.throws(
      () =>
        main.resolveUiModeLaunchSpec(
          {
            ...request,
            target: {
              ...request.target,
              configPath: 'packages/e2e/escape.config.ts'
            }
          },
          'external'
        ),
      /outside this workspace/
    )
    mkdirSync(join(workspace, 'packages', 'missing'), { recursive: true })
    assert.throws(
      () =>
        main.resolveUiModeLaunchSpec(
          {
            ...request,
            target: target({
              id: 'missing-install',
              cwd: 'packages/missing',
              packageDir: 'packages/missing',
              configPath: null
            })
          },
          'embedded'
        ),
      /Playwright is not installed/
    )
  })

  const events = []
  main.setUiModeEventSink((payload) => events.push(payload))
  main.setUiModeStopper(main.prepareUiModeForCliRun)
  const startEmbedded = async (resolved) => {
    try {
      return await main.startUiMode(resolved)
    } catch (err) {
      const crashed = [...events]
        .reverse()
        .find(
          (payload) =>
            payload.event.type === 'state' && payload.event.state === 'crashed'
        )
      const childMessage = crashed?.event.message
      const lastProbes = probeRows().slice(-3)
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}${
          childMessage ? ` (child: ${childMessage})` : ''
        }${lastProbes.length > 0 ? ` (probes: ${JSON.stringify(lastProbes)})` : ''}`
      )
    }
  }

  await test('embedded startup surfaces the real child error, not the trailing Node version', async () => {
    const crashing = {
      ...request,
      recipeEnv: { ...request.recipeEnv, WB_UI_STARTUP_ERROR: '1' }
    }
    await assert.rejects(
      async () => main.startUiMode(crashing),
      (error) => {
        assert.match(error.message, /Error: Cannot find module .*playwright\/lib\/program\.js/)
        assert.doesNotMatch(error.message, /Node\.js v24\.19\.0/)
        return true
      }
    )
    const crashed = [...events]
      .reverse()
      .find(
        (payload) =>
          payload.event.type === 'state' &&
          payload.event.state === 'crashed' &&
          payload.event.targetId === request.targetId
      )
    assert.match(crashed?.event.message ?? '', /Error: Cannot find module/)
    assert.doesNotMatch(crashed?.event.message ?? '', /Node\.js v24\.19\.0/)
    assert.equal(await main.stopUiMode(workspace), false)
  })

  await test('external fallback is opaque, target-aware, tracked, and exclusive', async () => {
    let stopped = false
    const inheritedPrivateEnv = new Map(
      main.UI_SESSION_ENV_KEYS.map((key) => [key, process.env[key]])
    )
    for (const key of main.UI_SESSION_ENV_KEYS) {
      process.env[key] = `parent-value-for-${key}`
    }
    try {
      const before = probeRows().length
      const info = await main.openExternalUiMode(request)
      assert.equal(info.launchMode, 'external')
      assert.equal(info.targetId, recipe.id)
      assert.equal(info.configurationTargetId, base.id)
      assert.equal(info.recipeMappedToBase, true)
      assert.equal(info.recording.supported, false)
      assert.match(info.recording.reason, /not recorded in Wrightbench history/)
      const observed = await waitFor(
        () => probeRows()[before] ?? null,
        'fake public UI CLI probe'
      )
      assert.deepEqual(observed.args, [
        'test',
        '--ui',
        '--ui-host=127.0.0.1',
        `--config=${canonicalConfig}`
      ])
      assert.equal(observed.configPath, canonicalConfig)
      assert.equal(observed.fullEvidence, false, 'opaque external UI preserves project capture')
      assert.equal(observed.cwd, canonicalPackageDir)
      assert.equal(observed.recipe, 'recipe', 'safe recipe env remains active')
      assert.equal(observed.recipeOnly, 'yes')
      assert.equal(observed.profileOnly, null, 'stored profile values stay dormant')
      assert.equal(observed.reporter, '', 'external UI never loads the Wrightbench reporter')
      assert.equal(observed.eventsFile, '', 'recipe cannot smuggle a private UI event channel')
      assert.equal(observed.session, '', 'stored or recipe values cannot smuggle a private UI session id')
      assert.equal(
        observed.attachmentsDir,
        '',
        'private keys inherited by the Wrightbench process are blanked in the child'
      )

      const same = await main.openExternalUiMode(request)
      assert.equal(same.sessionId, info.sessionId, 'identical starts join one tracked child')
      const legacyProfileIgnored = await main.openExternalUiMode({ ...request, profile: 'legacy' })
      assert.equal(legacyProfileIgnored.sessionId, info.sessionId)
      await assert.rejects(async () => main.startUiMode(request), /open externally/)
      await assert.rejects(main.beginCliExecution(workspace), /open externally/)
      assert.equal(await main.stopUiMode(workspace), true)
      stopped = true
      assert.equal(await main.stopUiMode(workspace), false)
      assert.ok(
        events.some(
          (payload) =>
            payload.event.type === 'state' &&
            payload.event.state === 'external' &&
            payload.event.sessionId === info.sessionId
        )
      )
      assert.ok(
        events.some(
          (payload) =>
            payload.event.type === 'state' &&
            payload.event.state === 'stopped' &&
            payload.event.launchMode === 'external'
        )
      )
      const release = await main.beginCliExecution(workspace)
      release()
    } finally {
      if (!stopped) await main.stopUiMode(workspace)
      for (const [key, value] of inheritedPrivateEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  await test('supported idle embedded UI joins by identity and yields to Run and Capture', async () => {
    try {
      const before = probeRows().length
      const info = await startEmbedded(request)
      assert.equal(info.launchMode, 'embedded')
      assert.equal(info.recording.supported, true)
      assert.equal(main.registeredUiModeOrigin(info.url), new URL(info.url).origin)
      assert.equal(
        main.registeredUiModeOrigin(new URL('/other', info.url).href),
        null,
        'another path on the registered loopback server is not an issued UI surface'
      )
      const alteredQuery = new URL(info.url)
      alteredQuery.searchParams.set('extra', '1')
      assert.equal(main.registeredUiModeOrigin(alteredQuery.href), null)
      assert.equal(
        main.registeredUiModeOrigin('http://127.0.0.1:65530/trace/uiMode.html?ws=arbitrary'),
        null
      )
      const observed = await waitFor(() => probeRows()[before] ?? null, 'embedded UI probe')
      assert.deepEqual(observed.args, [
        'test-server',
        `--config=${observed.configPath}`,
        '--host=127.0.0.1',
        '--port=0'
      ])
      assert.notEqual(observed.configPath, canonicalConfig)
      assert.equal(observed.fullEvidence, true)
      assert.ok(existsSync(observed.configPath), 'capture wrapper lives with the UI session')
      assert.equal(observed.cwd, canonicalPackageDir)
      assert.notEqual(observed.reporter, 'profile-reporter')
      assert.match(observed.reporter, /reporter\.cjs$/)
      assert.notEqual(observed.eventsFile, 'recipe-events')
      assert.notEqual(observed.session, 'profile-session')

      const same = await main.startUiMode(request)
      assert.equal(same.sessionId, info.sessionId)
      const legacyProfileIgnored = await main.startUiMode({ ...request, profile: 'legacy' })
      assert.equal(legacyProfileIgnored.sessionId, info.sessionId)
      const release = await main.beginCliExecution(workspace)
      release()
      assert.equal(
        existsSync(observed.configPath),
        false,
        'capture wrapper is removed when UI Mode yields ownership'
      )
      assert.equal(await main.stopUiMode(workspace), false, 'idle embedded child was drained')
      assert.equal(
        main.registeredUiModeOrigin(info.url),
        null,
        'stopped sessions immediately revoke their issued webview URL'
      )
    } finally {
      await main.stopUiMode(workspace)
    }
  })

  await test('unsupported embedded UI remains opaque and blocks Run and Capture', async () => {
    writeFileSync(
      manifest,
      JSON.stringify({ name: '@playwright/test', version: '1.43.0' })
    )
    try {
      const before = probeRows().length
      const info = await startEmbedded(request)
      assert.equal(info.recording.supported, false)
      assert.match(info.recording.reason, /not supported for Playwright v1\.43\.0/)
      const observed = await waitFor(
        () => probeRows()[before] ?? null,
        'unsupported embedded UI probe'
      )
      assert.equal(observed.reporter, '')
      assert.equal(observed.eventsFile, '')
      assert.equal(observed.session, '')
      assert.equal(observed.attachmentsDir, '')
      await assert.rejects(
        main.beginCliExecution(workspace),
        /cannot be observed for this Playwright version/
      )
      assert.equal(await main.stopUiMode(workspace), true)
    } finally {
      await main.stopUiMode(workspace)
      writeFileSync(
        manifest,
        JSON.stringify({ name: '@playwright/test', version: '1.62.0' })
      )
    }
  })

  await test('stopping an in-flight embedded startup cannot resurrect a stale session', async () => {
    const delayed = {
      ...request,
      recipeEnv: { ...request.recipeEnv, WB_UI_SERVER_DELAY_MS: '750' }
    }
    const before = probeRows().length
    const pending = startEmbedded(delayed)
    const rejected = assert.rejects(pending, /exited|stopped|reachable/)
    await waitFor(() => probeRows()[before] ?? null, 'delayed embedded UI probe')
    assert.equal(await main.stopUiMode(workspace), true)
    await rejected
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(await main.stopUiMode(workspace), false)

    const recovered = await startEmbedded(request)
    assert.equal(recovered.recording.supported, true)
    assert.equal(await main.stopUiMode(workspace), true)
  })

  await test('stopping an in-flight restart cannot resurrect its replacement session', async () => {
    const delayed = {
      ...request,
      recipeEnv: { ...request.recipeEnv, WB_UI_SERVER_DELAY_MS: '750' }
    }
    try {
      await startEmbedded(request)
      const before = probeRows().length
      const pending = main.restartUiMode(delayed)
      const rejected = assert.rejects(pending, /cancelled|exited|stopped|reachable/)
      await waitFor(() => probeRows()[before] ?? null, 'delayed restart UI probe')
      assert.equal(await main.stopUiMode(workspace), true)
      await rejected
      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.equal(
        await main.stopUiMode(workspace),
        false,
        'the cancelled replacement did not become a live session'
      )
    } finally {
      await main.stopUiMode(workspace)
    }
  })

  await test('context mutation reservation rejects stale starts until explicitly released', async () => {
    try {
      const original = await startEmbedded(request)
      const pendingContextChange = main.beginUiModeContextChange(workspace)

      await assert.rejects(
        async () => main.startUiMode(request),
        /configuration is changing/
      )
      const releaseContext = await pendingContextChange
      try {
        assert.equal(
          await main.stopUiMode(workspace),
          false,
          'reservation drained the old embedded session before mutation begins'
        )
        await assert.rejects(
          async () => main.restartUiMode(request),
          /configuration is changing/
        )
        await assert.rejects(
          async () => main.openExternalUiMode(request),
          /configuration is changing/
        )
        await assert.rejects(
          main.beginCliExecution(workspace),
          /configuration is changing/
        )
      } finally {
        releaseContext()
        releaseContext()
      }

      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(
        await main.stopUiMode(workspace),
        false,
        `stale session ${original.sessionId} did not resurrect after the reservation`
      )
      const changedContext = { ...request, profile: null }
      const recovered = await startEmbedded(changedContext)
      assert.equal(recovered.profile, null)
      assert.notEqual(recovered.sessionId, original.sessionId)
      assert.equal(await main.stopUiMode(workspace), true)
    } finally {
      await main.stopUiMode(workspace)
    }
  })
} finally {
  delete process.env.WB_UI_PROBE_FILE
  main.setUiModeStopper(async () => {})
  main.setUiModeEventSink(() => {})
  await main.stopAllUiModeSessions()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outsideWorkspace, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nall target-aware UI Mode tests passed' : `\n${failures} test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

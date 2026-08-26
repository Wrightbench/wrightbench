// Live main-process Record check against a project-local Playwright install.
//
//   WRIGHTBENCH_RECORD_PROJECT=/path/to/project npm run test:uimode:live
//
// The project must have Playwright >=1.56 plus Chromium installed. This opens
// Playwright's real headed browser; the Inspector frontend itself is verified
// over the loopback URL that Wrightbench embeds.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const project = process.env.WRIGHTBENCH_RECORD_PROJECT
if (!project) {
  console.log('SKIP codegen live test — set WRIGHTBENCH_RECORD_PROJECT')
  process.exit(0)
}

const originalHome = process.env.HOME
const defaultBrowserCache = originalHome
  ? join(originalHome, 'Library', 'Caches', 'ms-playwright')
  : null
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && defaultBrowserCache && existsSync(defaultBrowserCache)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = defaultBrowserCache
}

const isolatedHome = mkdtempSync(join(tmpdir(), 'wb-record-live-home-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

const require = createRequire(import.meta.url)
const {
  hasCodegenInspector,
  sendCodegenCommand,
  startCodegen,
  stopCodegen
} = require('./.build/main.cjs')
const events = []
const targetId = 'record-live'
const request = {
  projectPath: project,
  targetId,
  profile: null,
  target: {
    id: targetId,
    label: 'playwright.config.ts',
    cwd: '.',
    configPath: null,
    packageDir: '.',
    launcher: 'npm',
    source: 'config',
    scriptName: null,
    scriptEnv: {},
    extraArgs: [],
    playwrightVersion: null,
    testCount: null
  },
  recipeEnv: {}
}

async function waitFor(predicate, label, from = 0, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const failure = events.slice(from).find(event => event.type === 'error')
    if (failure) throw new Error(`${label} failed: ${failure.message}`)
    const value = events.slice(from).find(predicate)
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`timed out waiting for ${label}`)
}

try {
  await startCodegen(
    request,
    {
      browser: 'chromium',
      url: 'data:text/html,<title>Wrightbench Record</title><button>Save</button>',
      viewport: { width: 800, height: 600 }
    },
    payload => events.push(payload.event)
  )
  const ready = await waitFor(event => event.type === 'ready', 'ready')
  assert.equal(hasCodegenInspector(project, ready.inspectorUrl), true)
  assert.ok(ready.viewport.width >= 480 && ready.viewport.width <= 7680)
  assert.ok(ready.viewport.height >= 320 && ready.viewport.height <= 4320)

  const response = await fetch(ready.inspectorUrl)
  assert.equal(response.ok, true)
  const html = await response.text()
  assert.match(html, /<title>Playwright Inspector<\/title>/)
  assert.match(html, /\/assets\/index-[^"']+\.js/)

  const measuredWidth = new RegExp(`width:\\s*${ready.viewport.width}`)
  const measuredHeight = new RegExp(`height:\\s*${ready.viewport.height}`)
  const sources = await waitFor(
    event =>
      event.type === 'inspector' &&
      event.event.method === 'sourcesUpdated' &&
      event.event.params.sources.some(
        source =>
          source.id === 'playwright-test' &&
          measuredWidth.test(source.text) &&
          measuredHeight.test(source.text)
      ),
    'native Inspector sources'
  )
  const generated = sources.event.params.sources.find(source => source.id === 'playwright-test')
  assert.ok(generated)
  assert.match(generated.text, measuredWidth)
  assert.match(generated.text, measuredHeight)

  const checkpoint = events.length
  assert.equal(
    sendCodegenCommand(project, { method: 'setMode', params: { mode: 'standby' } }),
    true
  )
  const mode = await waitFor(
    event =>
      event.type === 'inspector' &&
      event.event.method === 'modeChanged' &&
      event.event.params?.mode === 'standby',
    'native Inspector mode update',
    checkpoint
  )
  assert.equal(mode.event.params.mode, 'standby')

  assert.equal(sendCodegenCommand(project, { method: 'wrightbenchReady' }), true)
  const stopCheckpoint = events.length
  await stopCodegen(project)
  await waitFor(event => event.type === 'stopped', 'clean End session', stopCheckpoint)
  assert.equal(events.slice(stopCheckpoint).some(event => event.type === 'error'), false)
  console.log('  ok  headed browser, Inspector protocol, and clean End session are live')
} finally {
  await stopCodegen(project)
  rmSync(isolatedHome, { recursive: true, force: true })
}

console.log('\ncodegen live test passed')

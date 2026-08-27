/**
 * Project-local Record host written to ~/.wrightbench/record-host.cjs.
 *
 * The host deliberately uses Playwright's server-side Recorder directly. That
 * keeps the inspected browser genuine and headed while avoiding Playwright's
 * second, external Inspector window. The exact recorder frontend files from
 * the same playwright-core installation are served on loopback and embedded
 * by Wrightbench without modifying their HTML, JavaScript, or CSS.
 */
export const CODEGEN_HOST_SOURCE = String.raw`'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const Module = require('module')

const PREFIX = 'WBREC '
const MAX_WIDTH = 7680
const MAX_HEIGHT = 4320
const MIN_WIDTH = 480
const MIN_HEIGHT = 320

let browser = null
let context = null
let page = null
let recorder = null
let server = null
let stopping = false
let browserName = 'chromium'
let viewport = { width: 1100, height: 700 }
let actions = []
let userSources = []
let recorderSources = []
let selectedGeneratorId = 'playwright-test'
let autoExpect = false
let generatorOptions = null
let languageSet = null
let generateCode = null
let collapseActions = null
let ProgressController = null
let RecorderEvent = null
let frameEvaluationNeedsProgress = false
let browserCloseNeedsProgress = false

function emit(value) {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n')
}

function safeMessage(error) {
  const raw = error && error.message ? String(error.message) : String(error || 'Record session failed')
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '')
  const callLog = clean.indexOf('\nCall log:')
  return (callLog === -1 ? clean : clean.slice(0, callLog)).trim().slice(0, 1600)
}

function numberIn(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

function runWithProgress(task) {
  return new ProgressController().run(task, 0)
}

function loadPlaywrightInternals(coreRoot) {
  const serverRoot = path.join(coreRoot, 'lib', 'server')
  const modularPlaywright = path.join(serverRoot, 'playwright.js')
  if (fs.existsSync(modularPlaywright)) {
    const { createPlaywright } = require(modularPlaywright)
    const { ProgressController } = require(path.join(serverRoot, 'progress.js'))
    const recorderModule = require(path.join(serverRoot, 'recorder.js'))
    const { languageSet } = require(path.join(serverRoot, 'codegen', 'languages.js'))
    const { generateCode } = require(path.join(serverRoot, 'codegen', 'language.js'))
    const { collapseActions } = require(path.join(serverRoot, 'recorder', 'recorderUtils.js'))
    return {
      createPlaywright,
      ProgressController,
      Recorder: recorderModule.Recorder,
      RecorderEvent: recorderModule.RecorderEvent,
      languageSet,
      generateCode,
      collapseActions,
      frameEvaluationNeedsProgress: false,
      browserCloseNeedsProgress: false
    }
  }

  // Playwright 1.62 consolidated its server implementation into coreBundle.js
  // and removed the importable lib/server/*.js files. The recorder classes are
  // still present in the project-local bundle and power the shipped Inspector,
  // but they are intentionally not public exports. Compile that exact bundle
  // in memory with a narrow adapter export; the project package remains
  // untouched and the Inspector assets served below remain byte-for-byte exact.
  const bundlePath = path.join(coreRoot, 'lib', 'coreBundle.js')
  if (!fs.existsSync(bundlePath)) {
    throw new Error('This Playwright version does not expose compatible Record internals')
  }
  const source = fs.readFileSync(bundlePath, 'utf8')
  if (source.length > 20_000_000) {
    throw new Error('The project Playwright server bundle is unexpectedly large')
  }
  const adapterSource = source + [
    '',
    ';init_progress()',
    ';init_recorder()',
    ';init_languages()',
    ';init_language()',
    ';init_recorderUtils()',
    ';init_playwright()',
    ';module.exports.__wrightbenchRecord = {',
    '  createPlaywright,',
    '  ProgressController,',
    '  Recorder,',
    '  RecorderEvent,',
    '  languageSet,',
    '  generateCode,',
    '  collapseActions',
    '}',
    ''
  ].join('\n')
  const loaded = new Module(bundlePath + '.wrightbench', module)
  loaded.filename = bundlePath
  loaded.paths = Module._nodeModulePaths(path.dirname(bundlePath))
  loaded._compile(adapterSource, bundlePath)
  const internals = loaded.exports && loaded.exports.__wrightbenchRecord
  if (
    !internals ||
    typeof internals.createPlaywright !== 'function' ||
    typeof internals.ProgressController !== 'function' ||
    typeof internals.Recorder !== 'function' ||
    !internals.RecorderEvent ||
    typeof internals.languageSet !== 'function' ||
    typeof internals.generateCode !== 'function' ||
    typeof internals.collapseActions !== 'function'
  ) {
    throw new Error('This Playwright server bundle uses unsupported Record internals')
  }
  internals.frameEvaluationNeedsProgress = true
  internals.browserCloseNeedsProgress = true
  return internals
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function focusInspectedPage(page) {
  // Start recording is an explicit handoff to the headed browser. Activate it
  // once while the page is being created; Inspector readiness and later state
  // replays must never steal focus back from whatever the user chose next.
  try {
    if (page.delegate && typeof page.delegate.bringToFront === 'function') {
      await page.delegate.bringToFront()
    }
  } catch {
    // Window activation is best-effort and must never block a Record session.
  }
}

async function maximizeAndMeasure(page, fallback) {
  // --start-maximized is respected by normal Chromium launches. The explicit
  // bounds request handles installations/platforms that create the first page
  // before applying that flag. Both are Chromium-only and fail open.
  try {
    if (page.delegate && typeof page.delegate.setWindowBounds === 'function') {
      await page.delegate.setWindowBounds({ windowState: 'maximized' })
    }
  } catch {
    // The launch flag remains the fallback; fixed fallback dimensions are last.
  }

  let measured = fallback
  // Let native window management settle, then keep the latest valid reading.
  // Three samples cover the short maximize animation on macOS without making
  // Record startup feel delayed.
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(attempt === 0 ? 120 : 80)
    try {
      const expression = '({ width: window.innerWidth, height: window.innerHeight })'
      const value = frameEvaluationNeedsProgress
        ? await runWithProgress(progress =>
            page.mainFrame().evaluateExpression(progress, expression, { isFunction: false })
          )
        : await page.mainFrame().evaluateExpression(expression, { isFunction: false })
      if (value && Number.isFinite(value.width) && Number.isFinite(value.height)) {
        measured = {
          width: numberIn(value.width, MIN_WIDTH, MAX_WIDTH, measured.width),
          height: numberIn(value.height, MIN_HEIGHT, MAX_HEIGHT, measured.height)
        }
      }
    } catch {
      // A page that cannot be measured keeps the caller's fixed viewport.
    }
  }
  return measured
}

function inspector(method, params) {
  emit({ type: 'inspector', event: { method, params } })
}

function currentSource() {
  return [...userSources, ...recorderSources].find(source => source.id === selectedGeneratorId) || recorderSources[0] || null
}

function publishSources(reveal) {
  const sources = [...userSources, ...recorderSources]
  inspector('sourcesUpdated', { sources })
  const source = currentSource()
  if (reveal && source) inspector('sourceRevealRequested', { sourceId: source.id })
  emit({ type: 'code', code: source && typeof source.text === 'string' ? source.text : '' })
}

function updateActions(reveal) {
  const generated = []
  const collapsed = collapseActions(actions)
  for (const languageGenerator of languageSet()) {
    const result = generateCode(collapsed, languageGenerator, {
      ...generatorOptions,
      // 1.56 called this generateAutoExpect; 1.62 renamed it to
      // generateExpectSignal. Supplying both keeps the adapter exact across the
      // supported range without version-specific generated-code branches.
      generateAutoExpect: autoExpect,
      generateExpectSignal: autoExpect
    })
    generated.push({
      isRecorded: true,
      label: languageGenerator.name,
      group: languageGenerator.groupName,
      id: languageGenerator.id,
      text: result.text,
      header: result.header,
      footer: result.footer,
      actions: result.actionTexts,
      language: languageGenerator.highlighter,
      highlight: [],
      revealLine: result.text.split('\n').length - 1
    })
  }
  recorderSources = generated
  publishSources(reveal)
}

function publishFullState() {
  inspector('pageNavigated', { url: recorder.url() || (page ? page.mainFrame().url() : '') })
  inspector('modeChanged', { mode: recorder.mode() })
  inspector('pauseStateChanged', { paused: recorder.paused() })
  inspector('callLogsUpdated', { callLogs: recorder.callLog() })
  updateActions(false)
  const pausedSourceId = recorder.pausedSourceId()
  if (pausedSourceId) inspector('sourceRevealRequested', { sourceId: pausedSourceId })
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.ttf') return 'font/ttf'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

function inspectorProtocol(recorderDir) {
  const html = fs.readFileSync(path.join(recorderDir, 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/g)]
  for (const match of scripts) {
    const script = path.resolve(recorderDir, match[1].replace(/^\/+/, ''))
    const relative = path.relative(recorderDir, script)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(script)) continue
    const source = fs.readFileSync(script, 'utf8')
    // Playwright 1.58+ exposes a method-based Inspector transport. Playwright
    // 1.56 uses dispatch({ event }) for commands and named setters for events.
    // Detect the exact bundled frontend instead of guessing from a version.
    if (source.includes('window.sendCommand')) return 'method'
    if (source.includes('playwrightSetSources')) return 'legacy'
  }
  throw new Error('This Playwright Inspector frontend uses an unsupported protocol')
}

function startInspectorServer(recorderDir) {
  const root = fs.realpathSync(recorderDir)
  return new Promise((resolve, reject) => {
    const hosted = http.createServer((request, response) => {
      let pathname
      try {
        pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname)
      } catch {
        response.writeHead(400).end('Bad request')
        return
      }
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const candidate = path.resolve(root, relative)
      const rel = path.relative(root, candidate)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        response.writeHead(404).end('Not found')
        return
      }
      let file
      try {
        file = fs.realpathSync(candidate)
        if (file !== root && !file.startsWith(root + path.sep)) throw new Error('outside recorder assets')
        if (!fs.statSync(file).isFile()) throw new Error('not a file')
      } catch {
        response.writeHead(404).end('Not found')
        return
      }
      response.writeHead(200, {
        'Content-Type': contentType(file),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin'
      })
      fs.createReadStream(file).pipe(response)
    })
    hosted.once('error', reject)
    hosted.listen(0, '127.0.0.1', () => {
      const address = hosted.address()
      if (!address || typeof address === 'string') {
        hosted.close()
        reject(new Error('Inspector server did not bind to loopback'))
        return
      }
      server = hosted
      resolve('http://127.0.0.1:' + address.port + '/')
    })
  })
}

function bindRecorderEvents() {
  recorder.on(RecorderEvent.ActionAdded, action => {
    actions.push(action)
    updateActions(true)
  })
  recorder.on(RecorderEvent.SignalAdded, signal => {
    const signalPageGuid = signal.pageGuid || (signal.frame && signal.frame.pageGuid)
    const last = actions.findLast(action => {
      const actionPageGuid = action.pageGuid || (action.frame && action.frame.pageGuid)
      return actionPageGuid === signalPageGuid
    })
    if (last) last.action.signals.push(signal.signal)
    updateActions(false)
  })
  recorder.on(RecorderEvent.PageNavigated, url => inspector('pageNavigated', { url }))
  recorder.on(RecorderEvent.ModeChanged, mode => inspector('modeChanged', { mode }))
  recorder.on(RecorderEvent.PausedStateChanged, paused => inspector('pauseStateChanged', { paused }))
  recorder.on(RecorderEvent.CallLogsUpdated, callLogs => inspector('callLogsUpdated', { callLogs }))
  recorder.on(RecorderEvent.ElementPicked, (elementInfo, userGesture) => {
    inspector('elementPicked', { elementInfo, userGesture })
  })
  recorder.on(RecorderEvent.UserSourcesChanged, (sources, pausedSourceId) => {
    userSources = sources
    publishSources(false)
    if (pausedSourceId) inspector('sourceRevealRequested', { sourceId: pausedSourceId })
  })
}

async function start(config) {
  const packageRoot = process.argv[2]
  if (!packageRoot) throw new Error('Project Playwright package was not resolved')
  const coreManifest = require.resolve('playwright-core/package.json', { paths: [packageRoot] })
  const coreRoot = path.dirname(coreManifest)
  const recorderDir = path.join(coreRoot, 'lib', 'vite', 'recorder')
  if (!fs.existsSync(path.join(recorderDir, 'index.html'))) {
    throw new Error('This Playwright version does not expose the native Inspector frontend')
  }

  const internals = loadPlaywrightInternals(coreRoot)
  const { createPlaywright, Recorder } = internals
  ProgressController = internals.ProgressController
  RecorderEvent = internals.RecorderEvent
  languageSet = internals.languageSet
  generateCode = internals.generateCode
  collapseActions = internals.collapseActions
  frameEvaluationNeedsProgress = internals.frameEvaluationNeedsProgress
  browserCloseNeedsProgress = internals.browserCloseNeedsProgress

  browserName = ['chromium', 'firefox', 'webkit'].includes(config.browser) ? config.browser : 'chromium'
  viewport = {
    width: numberIn(config.viewport && config.viewport.width, MIN_WIDTH, MAX_WIDTH, 1100),
    height: numberIn(config.viewport && config.viewport.height, MIN_HEIGHT, MAX_HEIGHT, 700)
  }
  // This is the inspected browser, so it needs a normal initialized context
  // (including Playwright's Debugger). isInternalPlaywright is reserved for
  // Playwright's own auxiliary app browser and intentionally skips that setup.
  const serverPlaywright = createPlaywright({ sdkLanguage: 'javascript', isInternalPlaywright: false })
  const browserType = serverPlaywright[browserName]
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new Error('The selected project does not expose Playwright ' + browserName)
  }
  const nativeMaximize = browserName === 'chromium'
  browser = await runWithProgress(progress => browserType.launch(progress, {
    headless: false,
    handleSIGINT: false,
    args: nativeMaximize ? ['--start-maximized'] : undefined
  }))
  context = await runWithProgress(progress => browser.newContext(
    progress,
    nativeMaximize
      ? { noDefaultViewport: true }
      : {
          viewport,
          deviceScaleFactor: process.platform === 'darwin' ? 2 : 1
        }
  ))

  generatorOptions = {
    browserName,
    launchOptions: { headless: false },
    contextOptions: { viewport },
    deviceName: undefined,
    saveStorage: undefined
  }
  recorder = await Recorder.forContext(context, {
    mode: 'recording',
    recorderMode: 'default',
    handleSIGINT: false
  })
  const primary = [...languageSet()].find(generator => generator.id === selectedGeneratorId)
  if (primary) await recorder.setLanguage(primary.highlighter)
  bindRecorderEvents()

  page = await runWithProgress(progress => context.newPage(progress))
  await focusInspectedPage(page)
  if (nativeMaximize) {
    // Keep the genuine browser naturally maximized, but give the generator the
    // measured fixed dimensions so copied tests remain deterministic.
    viewport = await maximizeAndMeasure(page, viewport)
    generatorOptions.contextOptions = { viewport }
  }
  const initialUrl = typeof config.url === 'string' && config.url ? config.url : 'about:blank'
  if (initialUrl !== 'about:blank') {
    await runWithProgress(progress => page.mainFrame().goto(progress, initialUrl))
  }

  updateActions(false)
  const protocol = inspectorProtocol(recorderDir)
  const inspectorUrl = await startInspectorServer(recorderDir)
  emit({
    type: 'ready',
    inspectorUrl: inspectorUrl + '?wrightbenchProtocol=' + protocol,
    pageUrl: page.mainFrame().url(),
    browserVersion: typeof browser._version === 'string' ? browser._version : '',
    viewport
  })
  publishFullState()

  browser.once('disconnected', () => {
    if (stopping) return
    stopping = true
    if (server) server.close(() => process.exit(0))
    else process.exit(0)
  })
}

async function handle(command) {
  if (!command || typeof command !== 'object') return
  if (command.type === 'start') {
    await start(command)
    return
  }
  if (command.type !== 'command' || !recorder || !command.command) return
  const payload = command.command
  const params = payload.params || {}
  if (payload.method === 'wrightbenchReady') {
    publishFullState()
  } else if (payload.method === 'clear') {
    actions = []
    recorder.clear()
    updateActions(true)
  } else if (payload.method === 'fileChanged') {
    const source = [...userSources, ...recorderSources].find(item => item.id === params.fileId)
    if (source) {
      if (source.isRecorded) selectedGeneratorId = source.id
      await recorder.setLanguage(source.language)
      publishSources(false)
    }
  } else if (payload.method === 'setAutoExpect') {
    autoExpect = !!params.autoExpect
    updateActions(false)
  } else if (payload.method === 'setMode') {
    await recorder.setMode(params.mode)
  } else if (payload.method === 'resume') {
    recorder.resume()
  } else if (payload.method === 'pause') {
    recorder.pause()
  } else if (payload.method === 'step') {
    recorder.step()
  } else if (payload.method === 'highlightRequested') {
    if (typeof params.selector === 'string') await recorder.setHighlightedSelector(params.selector)
    else if (params.ariaTemplate) await recorder.setHighlightedAriaTemplate(params.ariaTemplate)
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  if (server) await new Promise(resolve => server.close(resolve)).catch(() => {})
  try {
    if (browser) {
      const options = { reason: 'Record stopped by Wrightbench' }
      if (browserCloseNeedsProgress) {
        await runWithProgress(progress => browser.close(progress, options))
      } else {
        await browser.close(options)
      }
    }
  } catch {}
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let commandQueue = Promise.resolve()
reader.on('line', line => {
  if (!line || line.length > 200000) return
  let command
  try {
    command = JSON.parse(line)
  } catch {
    return
  }
  commandQueue = commandQueue.then(() => handle(command)).catch(error => {
    emit({ type: 'error', message: safeMessage(error) })
  })
})
reader.on('close', () => { void shutdown() })

process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
process.on('uncaughtException', error => {
  emit({ type: 'error', message: safeMessage(error) })
  void shutdown().finally(() => process.exit(1))
})
process.on('unhandledRejection', error => {
  emit({ type: 'error', message: safeMessage(error) })
  void shutdown().finally(() => process.exit(1))
})
`

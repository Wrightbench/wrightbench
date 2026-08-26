import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanCodegenDir,
  hasCodegenInspector,
  saveCodegen,
  sendCodegenCommand,
  startCodegen,
  stopCodegen
} from './codegen'
import { scaffoldProject } from './commands'
import {
  closeHistoryDb,
  artifactRecordStats,
  historyAnalytics,
  historyRunTests,
  latestTestStatuses,
  listRuns,
  listTraceAttachments,
  openHistoryDb,
  pruneOldRuns,
  runTotals,
  sweepOrphanRuns,
  testInspector,
  testRunDetail
} from './db'
import { artifactStoreBytes, pruneArtifactStore } from './artifacts'
import { serveRunArtifact, stopArtifactServer } from './artifactserve'
import { inspectProject, probeNode } from './inspect'
import { setUiModeStopper } from './execution'
import { killAllTracked, sweepOrphans } from './proc'
import {
  addProject,
  applyDiscoveredTargets,
  listProjectsWithHealth,
  loadProjects,
  migrateProjectsFile,
  removeProject,
  resolveProjectFile
} from './projects'
import {
  buildUserConfigTarget,
  cachedDiscovery,
  cacheUserTarget,
  discoverTargets,
  listTestsForProject,
  resolveImportTarget,
  rescanRegisteredTargets,
  setActiveTarget,
  targetsStateFor
} from './targets/service'
import {
  revalidateProjects,
  setProjectObservationSink,
  stopProjectObservation,
  syncProjectObservation
} from './projectwatch'
import {
  exportReport,
  hasReportPort,
  reportInfo,
  reportPort,
  serveRunReport,
  startReport,
  stopReport
} from './report'
import { startRun, stopRun } from './runner'
import { resolveRunRequest } from './runrequest'
import {
  isThemePreference,
  loadSettings,
  projectRunEnv,
  pruneProjectViewContext,
  saveSettings,
  updateSettings
} from './settings'
import { serveTrace, stopAllTraceServers, stopTraceServer, traceServerPort } from './traceserve'
import {
  beginUiModeContextChange,
  openExternalUiMode,
  restartUiMode,
  prepareUiModeForCliRun,
  registeredUiModeOrigin,
  setUiModeEventSink,
  startUiMode,
  stopAllUiModeSessions,
  stopUiMode
} from './uimode'
import { resolveUiModeRequest } from './uimoderequest'
import { sweepUiEventFiles } from './uisession'
import { startWatch, stopAllWatchers, stopWatch } from './watcher'
import type {
  CodegenEventPayload,
  CodegenInspectorCommand,
  CodegenStartConfig,
  InvokeChannels,
  ProjectProgress,
  ResolvedTheme,
  RunEventPayload,
  ThemePreference,
  ThemeState,
  UiModeEventPayload,
  WrightbenchSettings
} from '@shared/ipc'

// Window chrome backgrounds must match --bg so resize never flashes a wrong color.
const BG: Record<ResolvedTheme, string> = { light: '#ffffff', dark: '#1e1e1e' }
const MAIN_BUNDLE_DIR = dirname(fileURLToPath(import.meta.url))
const PRODUCT_NAME = 'Wrightbench'
const APP_ID = 'com.wrightbench.app'

// electron-vite launches the Electron binary in development, so package.json's
// productName alone cannot replace the native menu-bar and dock identity.
app.setName(PRODUCT_NAME)

function developmentIconPath(): string {
  return join(app.getAppPath(), 'resources/icon.png')
}

function runtimeIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : developmentIconPath()
}

function configureNativeIdentity(): void {
  if (process.platform === 'darwin' && !app.isPackaged) {
    const icon = nativeImage.createFromPath(runtimeIconPath())
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
}

function loopbackHostedOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    const allowed =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
      url.username === '' &&
      url.password === ''
    return allowed ? url.origin : null
  } catch {
    return null
  }
}

function isExternalWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      loopbackHostedOrigin(raw) === null
    )
  } catch {
    return false
  }
}

function hasOrigin(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw)
    return url.origin === origin && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

interface IssuedHostedWebview {
  href: string
  origin: string
  isActive: () => boolean
  recorderBridge: boolean
}

const MAX_ISSUED_WEBVIEWS = 64
const issuedHostedWebviews = new Map<string, IssuedHostedWebview>()

function rememberHostedWebview(
  key: string,
  raw: string,
  isActive: () => boolean,
  recorderBridge = false
): void {
  const origin = loopbackHostedOrigin(raw)
  if (origin === null) throw new Error('hosted webview URL is not loopback')
  const href = new URL(raw).href
  issuedHostedWebviews.delete(key)
  issuedHostedWebviews.set(key, { href, origin, isActive, recorderBridge })
  while (issuedHostedWebviews.size > MAX_ISSUED_WEBVIEWS) {
    const oldest = issuedHostedWebviews.keys().next().value as string | undefined
    if (!oldest) break
    issuedHostedWebviews.delete(oldest)
  }
}

function forgetHostedWebviews(prefix: string): void {
  for (const key of issuedHostedWebviews.keys()) {
    if (key.startsWith(prefix)) issuedHostedWebviews.delete(key)
  }
}

function approvedHostedWebview(raw: string): {
  origin: string
  recorderBridge: boolean
} | null {
  const uiModeOrigin = registeredUiModeOrigin(raw)
  if (uiModeOrigin !== null) return { origin: uiModeOrigin, recorderBridge: false }
  let href: string
  try {
    href = new URL(raw).href
  } catch {
    return null
  }
  for (const [key, issued] of issuedHostedWebviews) {
    if (!issued.isActive()) {
      issuedHostedWebviews.delete(key)
      continue
    }
    if (issued.href === href) {
      return { origin: issued.origin, recorderBridge: issued.recorderBridge }
    }
  }
  return null
}

let themePreference: ThemePreference = 'system'

function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function themeState(): ThemeState {
  return { preference: themePreference, resolved: resolvedTheme() }
}

function handle<C extends keyof InvokeChannels>(
  channel: C,
  fn: (
    ...args: InvokeChannels[C]['args']
  ) => InvokeChannels[C]['result'] | Promise<InvokeChannels[C]['result']>
): void {
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as InvokeChannels[C]['args'])))
}

function sendProgress(progress: ProjectProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('project:progress', progress)
  }
}

function sendRunEvent(payload: RunEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('run:event', payload)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: PRODUCT_NAME,
    icon: process.platform === 'darwin' ? undefined : runtimeIconPath(),
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 17 },
    backgroundColor: BG[resolvedTheme()],
    webPreferences: {
      preload: join(MAIN_BUNDLE_DIR, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
      // Playwright's own UIs (UI Mode, Trace Viewer, HTML report) are hosted
      // in <webview> panes from Phase 2 onward.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // the user may have deleted/restored project folders while away
  win.on('focus', () => revalidateProjects())

  // Hosted report/trace content is not fully trusted — only pass web URLs on.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Every hosted Playwright surface is a loopback guest. Keep project-owned
  // reports/UI bundles outside Electron's privileged renderer context and
  // prevent a compromised/local page from navigating its webview remotely.
  const pendingGuestApprovals: Array<{ origin: string; recorderBridge: boolean }> = []
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.webviewTag = false
    delete webPreferences.preload
    const approval = approvedHostedWebview(params.src)
    if (approval === null) {
      event.preventDefault()
    } else {
      if (approval.recorderBridge) {
        webPreferences.preload = join(MAIN_BUNDLE_DIR, '../preload/recorder.cjs')
      }
      pendingGuestApprovals.push(approval)
    }
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    const approval = pendingGuestApprovals.shift()
    if (!approval) {
      guest.close()
      return
    }
    const { origin } = approval
    const secureHostedContents = (contents: Electron.WebContents): void => {
      contents.setWindowOpenHandler(({ url }) => {
        if (hasOrigin(url, origin)) {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              webPreferences: {
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                webviewTag: false
              }
            }
          }
        }
        if (isExternalWebUrl(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      contents.on('will-navigate', (event, url) => {
        if (!hasOrigin(url, origin)) event.preventDefault()
      })
      contents.on('will-redirect', (event, url) => {
        if (!hasOrigin(url, origin)) event.preventDefault()
      })
      contents.on('did-create-window', (child) => secureHostedContents(child.webContents))
    }
    secureHostedContents(guest)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(MAIN_BUNDLE_DIR, '../renderer/index.html'))
  }

  return win
}

let lastBroadcast = ''

function broadcastTheme(): void {
  const state = themeState()
  // themeSource assignment also fires 'updated' when the resolved color
  // flips, so a theme:set can reach here twice — send each state once.
  const key = `${state.preference}:${state.resolved}`
  if (key === lastBroadcast) return
  lastBroadcast = key
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(BG[state.resolved])
    win.webContents.send('theme:changed', state)
  }
}

app.whenReady().then(() => {
  configureNativeIdentity()
  themePreference = loadSettings().theme
  nativeTheme.themeSource = themePreference

  handle('theme:get', () => themeState())
  handle('theme:set', (preference) => {
    // IPC args are untrusted; an invalid enum would make themeSource throw
    if (!isThemePreference(preference)) return themeState()
    themePreference = preference
    nativeTheme.themeSource = preference
    try {
      saveSettings({ ...loadSettings(), theme: preference })
    } catch (err) {
      // persistence failure must not block the live theme change
      console.error('failed to persist settings:', err)
    }
    broadcastTheme()
    return themeState()
  })

  // Fires on OS scheme changes AND whenever a themeSource assignment flips
  // the resolved color; broadcastTheme dedupes the overlap with theme:set.
  nativeTheme.on('updated', broadcastTheme)

  const assertProjectPath = (path: unknown): string => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid project path')
    return path
  }

  const sendProjectsChanged = (projects: ReturnType<typeof listProjectsWithHealth>): void => {
    for (const project of projects) {
      if (project.health.state !== 'available') void stopUiMode(project.path)
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('projects:changed', projects)
    }
  }
  setProjectObservationSink({
    onProjectsChanged: sendProjectsChanged,
    onFilesChanged: (path, discovery) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('project:files-changed', { path, discovery })
      }
    }
  })

  handle('projects:list', () => listProjectsWithHealth())
  handle('projects:add', async (project) => {
    const path = assertProjectPath(project?.path)
    const name =
      typeof project.name === 'string' && project.name !== '' ? project.name : basename(path)
    // Targets come from this process's own inspection cache — the renderer
    // only names the chosen candidate, never supplies launch context. If the
    // cache expired, repeat the same passive import scan. projects:add then
    // rechecks only the selected configuration's local Playwright dependency;
    // browser binaries and test loading remain owned by Playwright UI Mode.
    const discovered =
      cachedDiscovery(path) ??
      (await discoverTargets(path, null, { validate: false }).catch(() => null))
    if (discovered === null) throw new Error('Could not inspect this Playwright project')
    const requestedActive =
      typeof project.activeTargetId === 'string' ? project.activeTargetId : null
    const importTarget = resolveImportTarget(path, discovered, requestedActive)
    addProject({
      name,
      path,
      playwrightVersion: importTarget.playwrightVersion,
      nodeVersion: typeof project.nodeVersion === 'string' ? project.nodeVersion : null,
      testCount: typeof project.testCount === 'number' ? project.testCount : null,
      targets: discovered.targets,
      suppressedTargetIds: discovered.suppressedTargetIds,
      activeTargetId: importTarget.id
    })
    const projects = syncProjectObservation()
    sendProjectsChanged(projects)
    return projects
  })
  handle('projects:remove', async (id) => {
    if (typeof id !== 'string' || id === '') throw new Error('invalid project id')
    const removed = listProjectsWithHealth().find((p) => p.id === id)
    // registry-only removal: project files and history.db rows are untouched
    removeProject(id)
    pruneProjectViewContext(id)
    if (removed) {
      // no orphaned sessions or watchers for a path Wrightbench no longer tracks
      stopWatch(removed.path)
      forgetHostedWebviews(`record\u0000${removed.path}`)
      forgetHostedWebviews(`report\u0000${removed.path}\u0000`)
      forgetHostedWebviews(`trace\u0000${removed.path}\u0000`)
      void stopReport(removed.path)
      void stopTraceServer(removed.path)
      void stopCodegen(removed.path).catch(() => {})
      void stopUiMode(removed.path)
    }
    const projects = syncProjectObservation()
    sendProjectsChanged(projects)
    return projects
  })

  handle('dialog:pick-folder', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const options = {
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('project:inspect', (path, _envProfile) =>
    inspectProject(assertProjectPath(path), null)
  )

  handle('project:targets', (path) => targetsStateFor(assertProjectPath(path)))
  handle('project:set-active-target', async (path, targetId) => {
    const projectPath = assertProjectPath(path)
    if (typeof targetId !== 'string' || targetId === '') throw new Error('invalid target id')
    const current = targetsStateFor(projectPath)
    if (!current.targets.some((target) => target.id === targetId)) {
      throw new Error('unknown test configuration')
    }
    if (current.activeTargetId === targetId) return setActiveTarget(projectPath, targetId)
    const releaseContext = await beginUiModeContextChange(projectPath)
    try {
      return setActiveTarget(projectPath, targetId)
    } finally {
      releaseContext()
    }
  })
  handle('project:rescan-targets', async (path, _envProfile, validate) => {
    const projectPath = assertProjectPath(path)
    // Rescanning can replace target metadata while preserving its id. Stop a
    // native UI session first so a later start cannot silently join stale cwd,
    // config, package-install, or environment context.
    const releaseContext = await beginUiModeContextChange(projectPath)
    try {
      return await rescanRegisteredTargets(projectPath, null, validate === true)
    } finally {
      releaseContext()
    }
  })

  handle('project:pick-config-target', async (path, _envProfile) => {
    const projectPath = assertProjectPath(path)
    const win = BrowserWindow.getAllWindows()[0]
    const options = {
      title: 'Choose a Playwright config file',
      defaultPath: projectPath,
      filters: [{ name: 'Playwright config', extensions: ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts'] }],
      properties: ['openFile'] as Array<'openFile'>
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) {
      return { cancelled: true, error: null, inspection: null, targets: null }
    }
    const built = buildUserConfigTarget(projectPath, picked.filePaths[0])
    if ('error' in built) {
      return { cancelled: false, error: built.error, inspection: null, targets: null }
    }
    const registered = loadProjects().some((p) => p.path === projectPath)
    if (registered) {
      // Persist immediately and make it active. UI Mode or the workspace test
      // tree performs runtime validation when the user opens that surface.
      const releaseContext = await beginUiModeContextChange(projectPath)
      try {
        cacheUserTarget(projectPath, built.target)
        applyDiscoveredTargets(projectPath, [built.target], built.target.id)
        return {
          cancelled: false,
          error: null,
          inspection: null,
          targets: targetsStateFor(projectPath)
        }
      } finally {
        releaseContext()
      }
    }
    // detection flow: fold the pick into a fresh inspection (same discovery
    // service; the cached user target rides along into projects:add)
    cacheUserTarget(projectPath, built.target)
    const inspection = await inspectProject(projectPath, null)
    return { cancelled: false, error: null, inspection, targets: null }
  })

  handle('project:open-file', async (path, relativeFile) => {
    const projectPath = assertProjectPath(path)
    if (!loadProjects().some((p) => p.path === projectPath)) {
      return { ok: false, code: null, error: 'unknown project' }
    }
    const resolved = resolveProjectFile(
      projectPath,
      typeof relativeFile === 'string' ? relativeFile : ''
    )
    if (resolved === null) return { ok: false, code: null, error: 'invalid file location' }
    try {
      statSync(resolved)
    } catch {
      return { ok: false, code: null, error: 'file not found' }
    }
    const openError = await shell.openPath(resolved)
    return openError === ''
      ? { ok: true, code: 0 }
      : { ok: false, code: null, error: openError }
  })

  handle('project:reveal', (path) => {
    const projectPath = assertProjectPath(path)
    // only folders the user registered — never an arbitrary reveal target
    if (!loadProjects().some((p) => p.path === projectPath)) return false
    shell.showItemInFolder(projectPath)
    return true
  })

  handle('project:scaffold', (path, version) =>
    scaffoldProject(assertProjectPath(path), version, sendProgress)
  )
  handle('project:test-tree', (path, _envProfile, targetId) =>
    listTestsForProject(
      assertProjectPath(path),
      null,
      typeof targetId === 'string' && targetId !== '' ? targetId : null
    )
  )

  handle('run:start', (config) => {
    const request = resolveRunRequest(config, loadProjects(), projectRunEnv)
    return startRun(
      { ...request.config, envProfile: null },
      request.target,
      request.env,
      sendRunEvent
    )
  })
  handle('run:stop', (runId) => (typeof runId === 'string' ? stopRun(runId) : false))

  handle('watch:start', (path, rootDir) => {
    const projectPath = assertProjectPath(path)
    startWatch(projectPath, typeof rootDir === 'string' ? rootDir : null, (file) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('watch:changed', { path: projectPath, file })
      }
    })
    return true
  })
  handle('watch:stop', (path) => {
    stopWatch(assertProjectPath(path))
    return true
  })

  const sendUiModeEvent = (payload: UiModeEventPayload): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('uimode:event', payload)
    }
  }
  setUiModeEventSink(sendUiModeEvent)
  setUiModeStopper(prepareUiModeForCliRun)

  const resolveUiModeConfig = (config: unknown) => {
    return resolveUiModeRequest(config, loadProjects())
  }
  handle('uimode:start', (config) =>
    startUiMode(resolveUiModeConfig(config))
  )
  handle('uimode:restart', (config) =>
    restartUiMode(resolveUiModeConfig(config))
  )
  handle('uimode:open-external', (config) =>
    openExternalUiMode(resolveUiModeConfig(config))
  )
  handle('uimode:stop', (path) => stopUiMode(assertProjectPath(path)))

  const safeHistoryRange = (range: { from: number | null; to: number | null }): {
    from: number | null
    to: number | null
  } => {
    const from = typeof range?.from === 'number' && Number.isFinite(range.from)
      ? Math.trunc(range.from)
      : null
    const to = typeof range?.to === 'number' && Number.isFinite(range.to)
      ? Math.trunc(range.to)
      : null
    return from !== null && to !== null && from <= to ? { from, to } : { from: null, to: null }
  }
  handle('history:runs', (path, range, limit) => {
    const projectPath = assertProjectPath(path)
    const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 500)
    return listRuns(projectPath, 'all', safeLimit, safeHistoryRange(range))
  })
  handle('history:run-tests', (path, runId) => {
    const projectPath = assertProjectPath(path)
    if (!Number.isFinite(runId) || runId <= 0) return []
    return historyRunTests(projectPath, Math.trunc(runId))
  })
  handle('history:analytics', (path, range) => {
    const projectPath = assertProjectPath(path)
    return {
      ...historyAnalytics(projectPath, 200, safeHistoryRange(range)),
      retentionDays: loadSettings().runRetentionDays
    }
  })
  handle('history:latest-test-statuses', (path) =>
    latestTestStatuses(assertProjectPath(path))
  )

  handle('history:test-inspector', (path, ref) => {
    const projectPath = assertProjectPath(path)
    if (
      ref === null ||
      typeof ref !== 'object' ||
      typeof ref.file !== 'string' ||
      !Number.isFinite(ref.line) ||
      typeof ref.title !== 'string'
    ) {
      throw new Error('invalid test reference')
    }
    return testInspector(projectPath, { file: ref.file, line: ref.line, title: ref.title })
  })
  handle('history:test-run-detail', (path, runId, ref) => {
    const projectPath = assertProjectPath(path)
    if (
      !Number.isFinite(runId) ||
      ref === null ||
      typeof ref !== 'object' ||
      typeof ref.file !== 'string' ||
      !Number.isFinite(ref.line) ||
      typeof ref.title !== 'string'
    ) {
      throw new Error('invalid test run reference')
    }
    return testRunDetail(projectPath, Math.trunc(runId), {
      file: ref.file,
      line: ref.line,
      title: ref.title
    })
  })

  const assertAbsoluteFile = (path: unknown): string => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('invalid file path')
    return path
  }


  handle('attachment:open', async (attPath) => {
    const file = assertAbsoluteFile(attPath)
    try {
      statSync(file)
    } catch {
      return false
    }
    // archives reveal in the file manager; media opens in its default app
    if (file.endsWith('.zip')) {
      shell.showItemInFolder(file)
      return true
    }
    return (await shell.openPath(file)) === ''
  })
  handle('attachment:serve', (path, runId, artifactId) => {
    if (!Number.isFinite(runId) || !Number.isFinite(artifactId)) {
      throw new Error('invalid artifact reference')
    }
    return serveRunArtifact(assertProjectPath(path), Math.trunc(runId), Math.trunc(artifactId))
  })

  const sendCodegenEvent = (payload: CodegenEventPayload): void => {
    const key = `record\u0000${payload.path}`
    if (payload.event.type === 'ready') {
      const inspectorUrl = payload.event.inspectorUrl
      rememberHostedWebview(
        key,
        inspectorUrl,
        () => hasCodegenInspector(payload.path, inspectorUrl),
        true
      )
    } else if (payload.event.type === 'stopped' || payload.event.type === 'error') {
      forgetHostedWebviews(key)
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('codegen:event', payload)
    }
  }

  const recordUrl = (value: unknown, nullable: boolean): string | null => {
    if (value === null || value === undefined || value === '') {
      if (nullable) return null
      throw new Error('Enter a URL to open in Record')
    }
    if (typeof value !== 'string' || value.length > 8_192 || value.includes('\u0000')) {
      throw new Error('invalid Record URL')
    }
    const trimmed = value.trim()
    if (/^(https?|data|file|about):/i.test(trimmed)) return trimmed
    // Match Playwright codegen's convenience behavior for example.com.
    if (!/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/\s/.test(trimmed)) {
      return `http://${trimmed}`
    }
    throw new Error('Record supports HTTP, HTTPS, file, data, and about URLs')
  }

  const recordViewport = (value: unknown): { width: number; height: number } => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid Record viewport')
    const raw = value as Record<string, unknown>
    const width = typeof raw.width === 'number' ? Math.round(raw.width) : NaN
    const height = typeof raw.height === 'number' ? Math.round(raw.height) : NaN
    if (!Number.isFinite(width) || width < 480 || width > 7680) {
      throw new Error('invalid Record viewport width')
    }
    if (!Number.isFinite(height) || height < 320 || height > 4320) {
      throw new Error('invalid Record viewport height')
    }
    return { width, height }
  }

  const safeRecordCommand = (value: unknown): CodegenInspectorCommand => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid Inspector command')
    const raw = value as Record<string, unknown>
    const method = raw.method
    const params = raw.params
    if (
      method === 'clear' ||
      method === 'resume' ||
      method === 'pause' ||
      method === 'step' ||
      method === 'wrightbenchReady'
    ) {
      return { method }
    }
    if (method === 'fileChanged') {
      if (
        typeof params !== 'object' ||
        params === null ||
        typeof (params as Record<string, unknown>).fileId !== 'string' ||
        ((params as Record<string, unknown>).fileId as string).length > 512
      ) {
        throw new Error('invalid Inspector source')
      }
      return { method, params: { fileId: (params as Record<string, unknown>).fileId } }
    }
    if (method === 'setAutoExpect') {
      if (
        typeof params !== 'object' ||
        params === null ||
        typeof (params as Record<string, unknown>).autoExpect !== 'boolean'
      ) {
        throw new Error('invalid Inspector assertion setting')
      }
      return { method, params: { autoExpect: (params as Record<string, unknown>).autoExpect } }
    }
    if (method === 'setMode') {
      const mode =
        typeof params === 'object' && params !== null
          ? (params as Record<string, unknown>).mode
          : null
      const modes = new Set([
        'none',
        'standby',
        'recording',
        'inspecting',
        'recording-inspecting',
        'assertingText',
        'assertingVisibility',
        'assertingValue',
        'assertingSnapshot'
      ])
      if (typeof mode !== 'string' || !modes.has(mode)) {
        throw new Error('invalid Inspector mode')
      }
      return { method, params: { mode } }
    }
    if (method === 'highlightRequested') {
      if (typeof params !== 'object' || params === null) {
        throw new Error('invalid Inspector highlight')
      }
      const clean = params as Record<string, unknown>
      if (clean.selector !== undefined && typeof clean.selector !== 'string') {
        throw new Error('invalid Inspector selector')
      }
      const encoded = JSON.stringify(clean)
      if (encoded.length > 100_000) throw new Error('Inspector highlight is too large')
      return { method, params: JSON.parse(encoded) as unknown }
    }
    throw new Error('unsupported Inspector command')
  }

  handle('codegen:start', (value) => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid Record request')
    const raw = value as unknown as Record<string, unknown>
    const path = assertProjectPath(raw.path)
    const targetId = raw.targetId
    const browser = raw.browser
    if (typeof targetId !== 'string' || targetId === '' || targetId.length > 64) {
      throw new Error('missing or invalid test configuration')
    }
    if (browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') {
      throw new Error('invalid Record browser')
    }
    const config: CodegenStartConfig = {
      path,
      targetId,
      browser,
      url: recordUrl(raw.url, true),
      viewport: recordViewport(raw.viewport)
    }
    return startCodegen(
      resolveUiModeConfig({ path: config.path, targetId: config.targetId }),
      config,
      sendCodegenEvent
    )
  })
  handle('codegen:command', (path, command) =>
    sendCodegenCommand(assertProjectPath(path), safeRecordCommand(command))
  )
  handle('codegen:stop', async (path) => {
    const projectPath = assertProjectPath(path)
    const result = await stopCodegen(projectPath)
    forgetHostedWebviews(`record\u0000${projectPath}`)
    return result
  })
  handle('codegen:save', (input) => {
    const projectPath = assertProjectPath(input?.path)
    if (
      typeof input.file !== 'string' ||
      input.file === '' ||
      typeof input.testName !== 'string' ||
      typeof input.code !== 'string'
    ) {
      return { ok: false, code: null, error: 'invalid save request' }
    }
    return saveCodegen({
      path: projectPath,
      file: input.file,
      rootDir: typeof input.rootDir === 'string' ? input.rootDir : null,
      testName: input.testName,
      code: input.code
    })
  })

  handle('report:start', async (path) => {
    const projectPath = assertProjectPath(path)
    const result = await startReport(projectPath)
    const url = `http://127.0.0.1:${result.port}/`
    rememberHostedWebview(`report\u0000${projectPath}\u0000current`, url, () =>
      hasReportPort(projectPath, result.port)
    )
    return result
  })
  handle('report:serve-run', async (path, runId) => {
    if (!Number.isFinite(runId)) throw new Error('invalid run id')
    const projectPath = assertProjectPath(path)
    const safeRunId = Math.trunc(runId)
    const result = await serveRunReport(projectPath, safeRunId)
    const port = Number(new URL(result.url).port)
    rememberHostedWebview(`report\u0000${projectPath}\u0000run\u0000${safeRunId}`, result.url, () =>
      hasReportPort(projectPath, port)
    )
    return result
  })
  handle('report:stop', (path) => {
    const projectPath = assertProjectPath(path)
    forgetHostedWebviews(`report\u0000${projectPath}\u0000`)
    return stopReport(projectPath)
  })
  handle('report:info', (path) => reportInfo(assertProjectPath(path)))
  handle('report:open-browser', async (path) => {
    const projectPath = assertProjectPath(path)
    const port = reportPort(projectPath) ?? (await startReport(projectPath)).port
    await shell.openExternal(`http://127.0.0.1:${port}`)
    return true
  })
  handle('report:export', async (path) => {
    const projectPath = assertProjectPath(path)
    const win = BrowserWindow.getAllWindows()[0]
    const options = {
      title: 'Export report to folder',
      properties: ['openDirectory', 'createDirectory'] as Array<
        'openDirectory' | 'createDirectory'
      >
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, code: null, error: 'cancelled' }
    }
    return exportReport(projectPath, picked.filePaths[0])
  })

  handle('traces:list', (path) => {
    const projectPath = assertProjectPath(path)
    return listTraceAttachments(projectPath, 100).map((entry) => {
      let sizeBytes: number | null = null
      try {
        sizeBytes = statSync(entry.path).size
      } catch {
        sizeBytes = null
      }
      return { ...entry, sizeBytes }
    })
  })
  handle('traces:serve', async (path, zipPath) => {
    const projectPath = assertProjectPath(path)
    const safeZipPath = assertAbsoluteFile(zipPath)
    const result = await serveTrace(projectPath, safeZipPath)
    const port = Number(new URL(result.url).port)
    rememberHostedWebview(`trace\u0000${projectPath}\u0000${safeZipPath}`, result.url, () =>
      traceServerPort(projectPath) === port
    )
    return result
  })
  handle('traces:stop', (path) => {
    const projectPath = assertProjectPath(path)
    forgetHostedWebviews(`trace\u0000${projectPath}\u0000`)
    return stopTraceServer(projectPath)
  })
  handle('dialog:pick-trace', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const options = {
      title: 'Open a Playwright trace',
      filters: [{ name: 'Playwright trace', extensions: ['zip'] }],
      properties: ['openFile'] as Array<'openFile'>
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })

  const broadcastSettings = (settings: WrightbenchSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('settings:changed', settings)
    }
  }
  handle('settings:get', () => loadSettings())
  handle('settings:update', (patch) => {
    const next = updateSettings(patch ?? {})
    try {
      pruneArtifactStore(next)
      // Covers legacy summary rows which predate immutable artifact_dir.
      pruneOldRuns(next.runRetentionDays)
    } catch (err) {
      console.error('artifact retention update failed:', err)
    }
    broadcastSettings(next)
    return next
  })
  handle('settings:storage', () => {
    let dbBytes = 0
    const historyPath = join(app.getPath('home'), '.wrightbench', 'history.db')
    for (const file of [historyPath, `${historyPath}-wal`, `${historyPath}-shm`]) {
      try {
        dbBytes += statSync(file).size
      } catch {
        // WAL/SHM are transient and may not exist yet.
      }
    }
    const artifactBytes = artifactStoreBytes()
    const evidence = artifactRecordStats()
    // Immutable roots can also contain Playwright-internal resources which
    // are not individual attachments (report bundles, trace resources).
    const otherBytes = Math.max(0, artifactBytes - evidence.traceBytes - evidence.videoBytes)
    return {
      dbBytes,
      artifactBytes,
      artifactCount: evidence.count,
      traceBytes: evidence.traceBytes,
      videoBytes: evidence.videoBytes,
      otherBytes,
      ...runTotals()
    }
  })
  handle('settings:clear-artifacts', () => {
    const settings = loadSettings()
    const result = pruneArtifactStore(settings)
    // Databases created before immutable storage have no artifact_dir; still
    // apply the history-age policy to those legacy summary rows.
    result.removedRuns += pruneOldRuns(settings.runRetentionDays)
    return result
  })
  handle('settings:node-info', () => probeNode())

  try {
    openHistoryDb()
    sweepOrphanRuns()
    const settings = loadSettings()
    pruneArtifactStore(settings)
    pruneOldRuns(settings.runRetentionDays)
  } catch (err) {
    console.error('history db unavailable:', err)
  }
  cleanCodegenDir()
  sweepUiEventFiles()
  sweepOrphans()
  try {
    // legacy registry entries gain an explicit default harness target once
    migrateProjectsFile()
  } catch (err) {
    console.error('projects.json target migration failed:', err)
  }
  syncProjectObservation()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let shutdownInProgress = false

app.on('before-quit', (event) => {
  if (shutdownInProgress) return
  event.preventDefault()
  shutdownInProgress = true
  stopAllWatchers()
  stopProjectObservation()
  stopArtifactServer()
  stopAllTraceServers()
  // Finalize queued/open UI Mode runs before closing SQLite. Calling quit
  // below re-enters this handler; shutdownInProgress lets that second pass go.
  void stopAllUiModeSessions()
    .catch((err) => console.error('failed to stop UI Mode sessions:', err))
    .finally(() => {
      killAllTracked()
      closeHistoryDb()
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// electron-vite dev restarts (and terminal Ctrl-C) signal the process rather
// than going through 'before-quit' — kill children so they don't orphan.
// SIGKILL is uncatchable; sweepOrphans() covers that path on the next launch.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    killAllTracked()
    app.quit()
  })
}

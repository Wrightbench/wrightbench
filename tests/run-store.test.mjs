import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

let filesChanged = null
let releaseRescan = null
let rescanGate = Promise.resolve()
const calls = []
let uiModeEventListener = null
let startUiModeImpl = async () => {
  throw new Error('unexpected UI Mode start')
}
let inspectProjectImpl = async () => {
  throw new Error('unexpected project inspection')
}
let pickedProjectFolder = null
let scaffoldProjectImpl = async () => {
  throw new Error('unexpected project scaffold')
}
let registeredProjects = []

function target(id) {
  return {
    id,
    label: `${id}.config.ts`,
    cwd: '.',
    configPath: `${id}.config.ts`,
    packageDir: '.',
    launcher: 'npm',
    source: 'config',
    scriptName: null,
    playwrightVersion: '1.62.1',
    testCount: 1,
    runnable: true,
    runnableReason: null
  }
}

const first = target('first')
const second = target('second')
let persisted = { targets: [first], activeTargetId: first.id }
let listedLine = 3
let persistedStatuses = [
  { file: 'status.spec.ts', line: 3, title: 'keeps its outcome', status: 'fail', durationMs: 44 }
]

function treeOutcome(active) {
  return {
    status: 'ready',
    tree: {
      targetId: active.id,
      files: [
        {
          file: 'status.spec.ts',
          tests: [
            {
              file: 'status.spec.ts',
              line: listedLine,
              column: 3,
              title: 'keeps its outcome',
              titlePath: ['keeps its outcome'],
              projects: ['chromium']
            }
          ]
        }
      ],
      projectNames: ['chromium'],
      rootDir: 'tests',
      totalTests: 1
    },
    diagnostic: null,
    target: active
  }
}

const noopSubscription = () => () => {}
globalThis.window = {
  wrightbench: {
    run: { onEvent: noopSubscription },
    watch: { onChanged: noopSubscription, stop: async () => {} },
    codegen: { onEvent: noopSubscription, stop: async () => {} },
    uimode: {
      onEvent(listener) {
        uiModeEventListener = listener
        return () => {}
      },
      start: (...args) => startUiModeImpl(...args),
      restart: async () => {
        throw new Error('unexpected UI Mode restart')
      },
      openExternal: async () => {
        throw new Error('unexpected external UI Mode start')
      },
      stop: async () => true
    },
    report: { stop: async () => {} },
    traces: { stop: async () => {} },
    projects: {
      list: async () => registeredProjects,
      add: async (project) => {
        const added = {
          ...project,
          id: 'imported-project',
          addedAt: new Date().toISOString(),
          health: { state: 'available', reason: null }
        }
        registeredProjects = [...registeredProjects, added]
        return registeredProjects
      },
      onChanged: noopSubscription,
      onFilesChanged(listener) {
        filesChanged = listener
        return () => {}
      }
    },
    settings: {
      get: async () => ({ workspaceUi: { projectViews: {} } })
    },
    history: {
      latestTestStatuses: async () => persistedStatuses
    },
    project: {
      onProgress: noopSubscription,
      pickFolder: async () => pickedProjectFolder,
      inspect: (...args) => inspectProjectImpl(...args),
      scaffold: (...args) => scaffoldProjectImpl(...args),
      targets: async () => persisted,
      async rescanTargets() {
        calls.push('rescan:start')
        await rescanGate
        calls.push('rescan:end')
        persisted = { targets: [second], activeTargetId: second.id }
        return { ...persisted, candidates: [] }
      },
      async testTree(_path, _env, targetId) {
        calls.push(`tree:${targetId ?? 'persisted'}`)
        const active =
          persisted.targets.find((candidate) => candidate.id === targetId) ??
          persisted.targets.find((candidate) => candidate.id === persisted.activeTargetId) ??
          persisted.targets[0]
        return treeOutcome(active)
      }
    }
  }
}

const require = createRequire(import.meta.url)
const {
  errorMessage,
  shouldAutoStartUiMode,
  runEvidenceTabs,
  uiModeHeaderActionState,
  useRun,
  useUiMode,
  useWorkspace
} = require('./.build/run-store.cjs')

assert.equal(
  errorMessage(
    new Error(
      "Error invoking remote method 'uimode:restart': Error: Playwright is not installed for this configuration"
    )
  ),
  'Playwright is not installed for this configuration'
)
console.log('  ok  renderer errors omit Electron IPC transport noise')

pickedProjectFolder = '/fixture/new-project'
await useWorkspace.getState().scaffold()
assert.deepEqual(useWorkspace.getState().screen, {
  name: 'scaffold-setup',
  path: '/fixture/new-project',
  version: '1.62.1'
})
useWorkspace.getState().selectScaffoldVersion('1.60.0')
assert.equal(useWorkspace.getState().screen.version, '1.60.0')
const scaffoldCalls = []
scaffoldProjectImpl = async (...args) => {
  scaffoldCalls.push(args)
  return { ok: true, code: 0 }
}
inspectProjectImpl = async (path) => ({
  path,
  name: 'new-project',
  configFile: 'playwright.config.ts',
  playwrightVersion: '1.60.0',
  targets: [target('new-project')],
  recommendedTargetId: 'new-project'
})
await useWorkspace.getState().confirmScaffold()
assert.deepEqual(scaffoldCalls, [['/fixture/new-project', '1.60.0']])
assert.equal(useWorkspace.getState().screen.name, 'detection')
assert.equal(useWorkspace.getState().screen.inspection.playwrightVersion, '1.60.0')
console.log('  ok  project creation defaults latest verified and forwards the exact selection')
useWorkspace.setState({ screen: { name: 'workspace' } })
pickedProjectFolder = null

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

await useRun.getState().initWorkspace('/fixture')
assert.equal(useRun.getState().tree?.targetId, first.id)
assert.deepEqual(Object.values(useRun.getState().statuses), [{ status: 'fail', duration: 44 }])
useRun.getState().setExpandedFiles(['status.spec.ts', 'missing.spec.ts', 'status.spec.ts'])
assert.deepEqual(useRun.getState().expandedFiles, { 'status.spec.ts': true })
useRun.getState().setExpandedFiles([])
assert.deepEqual(useRun.getState().expandedFiles, {})
console.log('  ok  bulk spec disclosure replaces state once and rejects unknown files')
assert.ok(filesChanged, 'filesystem observer subscribed')
calls.length = 0

rescanGate = new Promise((resolve) => {
  releaseRescan = resolve
})
filesChanged({ path: '/fixture', discovery: true })
filesChanged({ path: '/fixture', discovery: true })
await waitFor(() => calls.includes('rescan:start'), 'target rescan to start')
assert.deepEqual(
  calls,
  ['rescan:start'],
  'duplicate discovery notifications coalesce and tree listing waits for the rescan'
)

releaseRescan()
await waitFor(() => useRun.getState().tree?.targetId === second.id, 'new target tree')
assert.deepEqual(calls, ['rescan:start', 'rescan:end', 'tree:second'])
assert.equal(useRun.getState().activeTargetId, second.id)
assert.equal(useRun.getState().tree?.targetId, second.id)
assert.deepEqual(
  Object.values(useRun.getState().statuses),
  [{ status: 'fail', duration: 44 }],
  'persisted status follows an unambiguous declaration across tree reconstruction'
)

console.log('  ok  discovery invalidation rescans before listing the resulting active target')

listedLine = 9
filesChanged({ path: '/fixture', discovery: false })
await waitFor(() => useRun.getState().tree?.files[0]?.tests[0]?.line === 9, 'edited test tree')
assert.deepEqual(
  useRun.getState().statuses,
  {},
  'a moved declaration does not inherit history from its previous legacy identity'
)
persistedStatuses = [
  { file: 'status.spec.ts', line: 9, title: 'keeps its outcome', status: 'pass', durationMs: 51 }
]
await useRun.getState().refreshPersistedStatuses()
assert.deepEqual(Object.values(useRun.getState().statuses), [{ status: 'pass', duration: 51 }])
console.log('  ok  sidebar statuses hydrate from SQLite and require the current declaration identity')

useWorkspace.setState({
  activeProjectId: 'project-a',
  uiModeOpen: true,
  historyOpen: false,
  settingsOpen: false,
  externalTraceOpen: false
})
useWorkspace.getState().setActiveProject('project-b')
assert.equal(useWorkspace.getState().activeProjectId, 'project-b')
assert.equal(
  useWorkspace.getState().uiModeOpen,
  true,
  'changing global project scope preserves the chosen execution mode'
)
useWorkspace.getState().openHistory()
assert.equal(useWorkspace.getState().historyOpen, true)
assert.equal(
  useWorkspace.getState().uiModeOpen,
  true,
  'History overlays a mounted UI Mode session without ending its ownership'
)
useWorkspace.getState().openSettings()
assert.equal(useWorkspace.getState().settingsOpen, true)
useWorkspace.getState().openHistory()
assert.equal(useWorkspace.getState().historyOpen, true)
assert.equal(
  useWorkspace.getState().settingsOpen,
  false,
  'Reports is a direct destination that closes the Settings overlay'
)
useWorkspace.getState().openSettings()
useWorkspace.getState().openUiMode()
assert.equal(useWorkspace.getState().uiModeOpen, true)
assert.equal(useWorkspace.getState().historyOpen, false)
assert.equal(
  useWorkspace.getState().settingsOpen,
  false,
  'UI Mode is a direct destination that closes the Settings overlay'
)
useWorkspace.getState().openHistory()
useWorkspace.getState().openCliMode()
assert.equal(useWorkspace.getState().historyOpen, false)
assert.equal(useWorkspace.getState().uiModeOpen, false)
useWorkspace.getState().openUiMode()
assert.equal(useWorkspace.getState().historyOpen, false)
assert.equal(useWorkspace.getState().uiModeOpen, true)
useWorkspace.getState().openCliMode()
console.log('  ok  global mode and History navigation preserve project-scoped execution state')

useUiMode.setState({
  path: '/fixture',
  targetId: second.id,
  status: 'ready',
  url: 'http://127.0.0.1:4400/trace/uiMode.html?ws=fixture'
})
const uiSessionBeforeDestinationSwitch = {
  path: useUiMode.getState().path,
  targetId: useUiMode.getState().targetId,
  status: useUiMode.getState().status,
  url: useUiMode.getState().url
}
useWorkspace.getState().openUiMode()
useWorkspace.getState().openRecord()
useWorkspace.getState().openHistory()
useWorkspace.getState().openUiMode()
assert.deepEqual(
  {
    path: useUiMode.getState().path,
    targetId: useUiMode.getState().targetId,
    status: useUiMode.getState().status,
    url: useUiMode.getState().url
  },
  uiSessionBeforeDestinationSwitch,
  'Record/Report/Run navigation preserves the existing UI Mode guest session'
)
console.log('  ok  destination switching preserves the ready UI Mode session')

registeredProjects = [
  {
    id: 'existing-project',
    name: 'existing-project',
    path: '/existing-project',
    addedAt: new Date().toISOString(),
    playwrightVersion: '1.62.1',
    nodeVersion: 'v24.19.0',
    testCount: 1,
    health: { state: 'available', reason: null }
  }
]
useWorkspace.setState({
  screen: { name: 'welcome' },
  projects: [],
  activeProjectId: null,
  uiModeOpen: false,
  historyOpen: false,
  externalTraceOpen: false
})
await useWorkspace.getState().init()
assert.equal(useWorkspace.getState().screen.name, 'workspace')
assert.equal(useWorkspace.getState().activeProjectId, 'existing-project')
assert.equal(useWorkspace.getState().uiModeOpen, true)
assert.equal(useWorkspace.getState().historyOpen, false)

registeredProjects = []
const missingPlaywrightTarget = { ...first, playwrightVersion: null }
useWorkspace.setState({
  screen: {
    name: 'detection',
    inspection: {
      path: '/new-project',
      name: 'new-project',
      configFile: 'playwright.config.ts',
      playwrightVersion: null,
      targets: [missingPlaywrightTarget],
      recommendedTargetId: missingPlaywrightTarget.id
    },
    selectedTargetId: missingPlaywrightTarget.id
  },
  lastError: null,
  uiModeOpen: false,
  historyOpen: true,
  externalTraceOpen: true
})
await useWorkspace.getState().confirmAdd()
assert.equal(useWorkspace.getState().screen.name, 'detection')
assert.deepEqual(registeredProjects, [])
assert.match(useWorkspace.getState().lastError, /can’t resolve.*dependencies/s)

const oldPlaywrightTarget = { ...first, playwrightVersion: '1.55.1' }
useWorkspace.setState({
  screen: {
    name: 'detection',
    inspection: {
      path: '/old-project',
      name: 'old-project',
      configFile: 'playwright.config.ts',
      playwrightVersion: '1.55.1',
      targets: [oldPlaywrightTarget],
      recommendedTargetId: oldPlaywrightTarget.id
    },
    selectedTargetId: oldPlaywrightTarget.id
  },
  lastError: null
})
await useWorkspace.getState().confirmAdd()
assert.equal(useWorkspace.getState().screen.name, 'detection')
assert.deepEqual(registeredProjects, [])
assert.match(useWorkspace.getState().lastError, /too old.*1\.56\.0/s)

inspectProjectImpl = async (path) => ({
  path,
  name: 'new-project',
  configFile: 'playwright.config.ts',
  playwrightVersion: '1.62.1',
  targets: [first],
  recommendedTargetId: first.id
})
await useWorkspace.getState().reinspect()
assert.equal(useWorkspace.getState().screen.name, 'detection')
assert.equal(useWorkspace.getState().screen.selectedTargetId, first.id)
assert.equal(useWorkspace.getState().screen.inspection.targets[0].playwrightVersion, '1.62.1')
assert.equal(useWorkspace.getState().lastError, null)
console.log('  ok  unresolved Playwright blocks import until retry detection succeeds')

useWorkspace.setState({
  screen: {
    name: 'detection',
    inspection: {
      path: '/new-project',
      name: 'new-project',
      configFile: 'playwright.config.ts',
      playwrightVersion: '1.62.1',
      targets: [first],
      recommendedTargetId: first.id
    },
    selectedTargetId: first.id
  },
  uiModeOpen: false,
  historyOpen: true,
  externalTraceOpen: true
})
await useWorkspace.getState().confirmAdd()
assert.equal(useWorkspace.getState().screen.name, 'workspace')
assert.equal(useWorkspace.getState().activeProjectId, 'imported-project')
assert.equal(useWorkspace.getState().uiModeOpen, true)
assert.equal(useWorkspace.getState().historyOpen, false)
assert.equal(useWorkspace.getState().externalTraceOpen, false)
useWorkspace.getState().openCliMode()
console.log('  ok  existing and newly imported projects enter UI Mode by default')

useRun.getState().openTrace('decl:failed', 142)
const exactTraceIntent = useRun.getState().traceIntent
assert.equal(useRun.getState().selectedKey, 'decl:failed')
assert.equal(exactTraceIntent?.runId, 142)
useRun.getState().consumeTraceIntent((exactTraceIntent?.id ?? 0) + 1)
assert.equal(
  useRun.getState().traceIntent?.id,
  exactTraceIntent?.id,
  'a stale consumer cannot clear a newer trace request'
)
useRun.getState().consumeTraceIntent(exactTraceIntent.id)
assert.equal(useRun.getState().traceIntent, null)
useRun.getState().openTrace('decl:latest-failure', null)
assert.equal(useRun.getState().selectedKey, 'decl:latest-failure')
assert.equal(useRun.getState().traceIntent?.runId, null)
useRun.getState().select('decl:ordinary-selection')
assert.equal(useRun.getState().traceIntent, null, 'ordinary selection cancels stale trace navigation')
console.log('  ok  failure entry points atomically select a test and request its Trace tab')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function embeddedInfo(sessionId) {
  return {
    sessionId,
    targetId: first.id,
    configurationTargetId: first.id,
    recipeMappedToBase: false,
    launchMode: 'embedded',
    url: `http://127.0.0.1:43123/trace/uiMode.html?ws=${sessionId}`,
    port: 43123,
    profile: null,
    playwrightVersion: '1.62.1',
    recording: { supported: true, reason: null }
  }
}

function terminalEvent(state, sessionId) {
  return {
    path: '/ui-fixture',
    event: {
      type: 'state',
      state,
      sessionId,
      targetId: first.id,
      configurationTargetId: first.id,
      recipeMappedToBase: false,
      launchMode: 'embedded',
      url: null,
      port: null,
      profile: null,
      playwrightVersion: '1.62.1',
      recording: { supported: true, reason: null },
      message: state === 'crashed' ? 'fixture child exited' : null
    }
  }
}

function resetUiMode() {
  useUiMode.setState({
    path: null,
    targetId: null,
    configurationTargetId: null,
    recipeMappedToBase: false,
    status: 'idle',
    launchMode: null,
    sessionId: null,
    url: null,
    port: null,
    profile: null,
    playwrightVersion: null,
    recording: { supported: false, reason: null },
    error: null,
    run: null,
    lastSaved: null
  })
}

for (const terminal of ['crashed', 'stopped']) {
  resetUiMode()
  const gate = deferred()
  let startCalled = false
  startUiModeImpl = async () => {
    startCalled = true
    return gate.promise
  }
  const pending = useUiMode.getState().open({
    path: '/ui-fixture',
    targetId: first.id,
    profile: null
  })
  await waitFor(() => startCalled, `${terminal} ordering fixture to invoke UI Mode`)
  assert.ok(uiModeEventListener, 'UI Mode lifecycle listener subscribed')
  uiModeEventListener(terminalEvent(terminal, 'late-session'))
  assert.equal(useUiMode.getState().status, terminal)
  gate.resolve(embeddedInfo('late-session'))
  await pending
  assert.equal(
    useUiMode.getState().status,
    terminal,
    `a late invoke response cannot revive a ${terminal} UI Mode process`
  )
  assert.equal(useUiMode.getState().url, null)
}
console.log('  ok  terminal UI Mode events invalidate late start responses')

assert.equal(
  shouldAutoStartUiMode({
    active: true,
    wasActive: false,
    status: 'stopped',
    identityChanged: false,
    opaque: false
  }),
  true,
  'returning to Debug restarts an idle session drained by Run and Capture'
)
assert.equal(
  shouldAutoStartUiMode({
    active: true,
    wasActive: true,
    status: 'stopped',
    identityChanged: false,
    opaque: false
  }),
  false,
  'an explicit Stop while Debug stays active does not immediately restart'
)
assert.equal(
  shouldAutoStartUiMode({
    active: true,
    wasActive: false,
    status: 'ready',
    identityChanged: true,
    opaque: true
  }),
  false,
  'an unobservable session keeps ownership until explicitly stopped'
)
console.log('  ok  Debug re-entry auto-starts only the safe stopped-session edge')

assert.deepEqual(
  uiModeHeaderActionState({
    status: 'ready',
    targetId: first.id,
    recordingSupported: true,
    run: { runNumber: 7, done: 1, total: 2, failed: 0 },
    cliRunning: false
  }),
  {
    visible: true,
    restartVisible: true,
    restartDisabled: true,
    restartReason: 'Available after the current run finishes'
  },
  'an active embedded run disables Restart without removing its session-menu entry'
)
assert.deepEqual(
  uiModeHeaderActionState({
    status: 'ready',
    targetId: first.id,
    recordingSupported: true,
    run: null,
    cliRunning: false
  }),
  {
    visible: true,
    restartVisible: true,
    restartDisabled: false,
    restartReason: null
  },
  'Restart becomes available in the same menu after the embedded run finishes'
)
assert.equal(
  uiModeHeaderActionState({
    status: 'external',
    targetId: first.id,
    recordingSupported: false,
    run: null,
    cliRunning: false
  }).restartVisible,
  false,
  'external UI Mode remains Stop-only because Wrightbench cannot safely restart it'
)
console.log('  ok  UI Mode session menu keeps Restart gating stable during embedded runs')

assert.deepEqual(runEvidenceTabs(false, []), ['overview'])
assert.deepEqual(runEvidenceTabs(false, ['custom', 'trace']), ['overview', 'trace'])
assert.deepEqual(
  runEvidenceTabs(false, ['video', 'screenshot', 'diff']),
  ['overview', 'video', 'screenshots']
)
assert.deepEqual(
  runEvidenceTabs(true, ['video', 'screenshot', 'trace']),
  ['overview'],
  'live runs expose only their streaming overview'
)
console.log('  ok  run detail advertises only evidence that was retained')

console.log('\nall run-store tests passed')

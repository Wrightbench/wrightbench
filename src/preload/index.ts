import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  CodegenEventPayload,
  CommandResult,
  HistoryAnalytics,
  HistoryDateRange,
  HistoryRunTest,
  NodeInfo,
  PersistedTestStatus,
  ReportInfo,
  RunRecord,
  ProjectInspection,
  ProjectWithHealth,
  ProjectProgress,
  RunConfig,
  RunEventPayload,
  StorageStats,
  TargetCandidateInfo,
  TargetsState,
  TestListOutcome,
  TestResultRef,
  TestInspectorDetail,
  TestRunDetail,
  ThemePreference,
  ThemeState,
  TraceLibEntry,
  UiModeEventPayload,
  UiModeExternalSessionInfo,
  UiModeSessionInfo,
  WrightbenchApi,
  WrightbenchSettings
} from '@shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.off(channel, wrapped)
}

const api: WrightbenchApi = {
  theme: {
    get: () => ipcRenderer.invoke('theme:get') as Promise<ThemeState>,
    set: (preference: ThemePreference) =>
      ipcRenderer.invoke('theme:set', preference) as Promise<ThemeState>,
    onChanged: (listener) => subscribe('theme:changed', listener)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list') as Promise<ProjectWithHealth[]>,
    add: (project) => ipcRenderer.invoke('projects:add', project) as Promise<ProjectWithHealth[]>,
    remove: (id) => ipcRenderer.invoke('projects:remove', id) as Promise<ProjectWithHealth[]>,
    onChanged: (listener) => subscribe<ProjectWithHealth[]>('projects:changed', listener),
    onFilesChanged: (listener) =>
      subscribe<{ path: string; discovery: boolean }>('project:files-changed', listener)
  },
  project: {
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
    inspect: (path, envProfile) =>
      ipcRenderer.invoke('project:inspect', path, envProfile) as Promise<ProjectInspection>,
    scaffold: (path, version) =>
      ipcRenderer.invoke('project:scaffold', path, version) as Promise<CommandResult>,
    onProgress: (listener) => subscribe<ProjectProgress>('project:progress', listener),
    testTree: (path, envProfile, targetId) =>
      ipcRenderer.invoke('project:test-tree', path, envProfile, targetId) as Promise<TestListOutcome>,
    targets: (path) => ipcRenderer.invoke('project:targets', path) as Promise<TargetsState>,
    setActiveTarget: (path, targetId) =>
      ipcRenderer.invoke('project:set-active-target', path, targetId) as Promise<TargetsState>,
    rescanTargets: (path, envProfile, validate) =>
      ipcRenderer.invoke('project:rescan-targets', path, envProfile, validate) as Promise<
        TargetsState & { candidates: TargetCandidateInfo[] }
      >,
    pickConfigTarget: (path, envProfile) =>
      ipcRenderer.invoke('project:pick-config-target', path, envProfile) as Promise<{
        cancelled: boolean
        error: string | null
        inspection: ProjectInspection | null
        targets: TargetsState | null
      }>,
    openFile: (path, relativeFile) =>
      ipcRenderer.invoke('project:open-file', path, relativeFile) as Promise<CommandResult>,
    reveal: (path) => ipcRenderer.invoke('project:reveal', path) as Promise<boolean>
  },
  run: {
    start: (config: RunConfig) =>
      ipcRenderer.invoke('run:start', config) as Promise<{
        runId: string
        historyRunId: number | null
        runNumber: number
        commitHash: string | null
      }>,
    stop: (runId: string) => ipcRenderer.invoke('run:stop', runId) as Promise<boolean>,
    onEvent: (listener) => subscribe<RunEventPayload>('run:event', listener)
  },
  watch: {
    start: (path, testDir) => ipcRenderer.invoke('watch:start', path, testDir) as Promise<boolean>,
    stop: (path) => ipcRenderer.invoke('watch:stop', path) as Promise<boolean>,
    onChanged: (listener) => subscribe<{ path: string; file: string }>('watch:changed', listener)
  },
  uimode: {
    start: (config) =>
      ipcRenderer.invoke('uimode:start', config) as Promise<UiModeSessionInfo>,
    restart: (config) =>
      ipcRenderer.invoke('uimode:restart', config) as Promise<UiModeSessionInfo>,
    openExternal: (config) =>
      ipcRenderer.invoke('uimode:open-external', config) as Promise<UiModeExternalSessionInfo>,
    stop: (path) => ipcRenderer.invoke('uimode:stop', path) as Promise<boolean>,
    onEvent: (listener) => subscribe<UiModeEventPayload>('uimode:event', listener)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<WrightbenchSettings>,
    update: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<WrightbenchSettings>,
    storage: () => ipcRenderer.invoke('settings:storage') as Promise<StorageStats>,
    clearArtifacts: () =>
      ipcRenderer.invoke('settings:clear-artifacts') as Promise<{
        removedRuns: number
        removedArtifacts: number
        freedBytes: number
      }>,
    nodeInfo: () => ipcRenderer.invoke('settings:node-info') as Promise<NodeInfo>,
    onChanged: (listener) => subscribe<WrightbenchSettings>('settings:changed', listener)
  },
  codegen: {
    start: (config) => ipcRenderer.invoke('codegen:start', config) as Promise<boolean>,
    command: (path, command) =>
      ipcRenderer.invoke('codegen:command', path, command) as Promise<boolean>,
    stop: (path) => ipcRenderer.invoke('codegen:stop', path) as Promise<string>,
    save: (input) => ipcRenderer.invoke('codegen:save', input) as Promise<CommandResult>,
    onEvent: (listener) => subscribe<CodegenEventPayload>('codegen:event', listener)
  },
  report: {
    start: (path) => ipcRenderer.invoke('report:start', path) as Promise<{ port: number }>,
    serveRun: (path, runId) =>
      ipcRenderer.invoke('report:serve-run', path, runId) as Promise<{ url: string }>,
    stop: (path) => ipcRenderer.invoke('report:stop', path) as Promise<boolean>,
    info: (path) => ipcRenderer.invoke('report:info', path) as Promise<ReportInfo>,
    openBrowser: (path) => ipcRenderer.invoke('report:open-browser', path) as Promise<boolean>,
    export: (path) => ipcRenderer.invoke('report:export', path) as Promise<CommandResult>
  },
  traces: {
    list: (path) => ipcRenderer.invoke('traces:list', path) as Promise<TraceLibEntry[]>,
    serve: (path, zipPath) =>
      ipcRenderer.invoke('traces:serve', path, zipPath) as Promise<{ url: string }>,
    stop: (path) => ipcRenderer.invoke('traces:stop', path) as Promise<boolean>,
    pickFile: () => ipcRenderer.invoke('dialog:pick-trace') as Promise<string | null>
  },
  history: {
    runs: (path: string, range: HistoryDateRange, limit: number) =>
      ipcRenderer.invoke('history:runs', path, range, limit) as Promise<RunRecord[]>,
    runTests: (path: string, runId: number) =>
      ipcRenderer.invoke('history:run-tests', path, runId) as Promise<HistoryRunTest[]>,
    analytics: (path: string, range: HistoryDateRange) =>
      ipcRenderer.invoke('history:analytics', path, range) as Promise<HistoryAnalytics>,
    latestTestStatuses: (path: string) =>
      ipcRenderer.invoke('history:latest-test-statuses', path) as Promise<PersistedTestStatus[]>,
    testInspector: (path: string, ref: TestResultRef) =>
      ipcRenderer.invoke('history:test-inspector', path, ref) as Promise<TestInspectorDetail | null>,
    testRunDetail: (path: string, runId: number, ref: TestResultRef) =>
      ipcRenderer.invoke('history:test-run-detail', path, runId, ref) as Promise<TestRunDetail | null>
  },
  attachments: {
    open: (path: string) => ipcRenderer.invoke('attachment:open', path) as Promise<boolean>,
    serve: (projectPath: string, runId: number, artifactId: number) =>
      ipcRenderer.invoke('attachment:serve', projectPath, runId, artifactId) as Promise<{
        url: string
        contentType: string
      }>
  },
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('wrightbench', api)

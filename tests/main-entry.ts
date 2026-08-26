/**
 * Test bundle entry: re-exports the main-process modules under test.
 * run-tests.mjs bundles this with esbuild (external: electron,
 * better-sqlite3) and the .mjs tests require the resulting CJS under
 * `ELECTRON_RUN_AS_NODE=1 electron`, so better-sqlite3 keeps Electron's ABI.
 */
export { aggregate, recordDeclEvent } from '../src/main/aggregate'
export { serveRunArtifact, stopArtifactServer } from '../src/main/artifactserve'
export {
  createRuntimeCaptureConfig,
  findPlaywrightConfig,
  traceModeForCapture
} from '../src/main/capture'
export {
  parseCodegenActions,
  hasCodegenInspector,
  sendCodegenCommand,
  startCodegen,
  stopCodegen
} from '../src/main/codegen'
export { CODEGEN_HOST_SOURCE } from '../src/main/codegenhost'
export { scaffoldInstallPlan, scaffoldProject } from '../src/main/commands'
export {
  artifactFileForRun,
  closeHistoryDb,
  createRun,
  finishRunRecord,
  historyAnalytics,
  historyRunTests,
  latestTestStatuses,
  listRuns,
  listTraceAttachments,
  openHistoryDb,
  sweepOrphanRuns,
  testInspector,
  testRunDetail
} from '../src/main/db'
export {
  assertUiModeAvailable,
  beginCliExecution,
  isCliExecutionActive,
  setUiModeStopper
} from '../src/main/execution'
export {
  installedPlaywrightVersion,
  parseUiEventLine,
  recordingSupportForVersion,
  sanitizeCliProcessEnv,
  UI_SESSION_ENV_KEYS,
  uiSessionEnv
} from '../src/main/pwadapter'
export {
  addProject,
  applyDiscoveredTargets,
  listProjectsWithHealth,
  loadProjects,
  mergeTargets,
  migrateProjectsFile,
  projectHealth,
  projectTargets,
  removeProject,
  sanitizeTarget,
  setActiveTargetPersisted,
  synthesizeLegacyTarget,
  targetIdFor
} from '../src/main/projects'
export {
  revalidateProjects,
  setDiscoverySurface,
  setProjectObservationSink,
  stopProjectObservation,
  syncProjectObservation
} from '../src/main/projectwatch'
export {
  analyzeScript,
  hasRecipeContext,
  hasReservedRunArgs,
  tokenizeScript
} from '../src/main/targets/script'
export {
  resolveTargetContext,
  splitTargetArgs,
  targetRunLocation
} from '../src/main/targets/context'
export {
  detectLauncher,
  launcherFromLockfileName,
  launcherFromPackageManagerField,
  resolvePlaywright,
  usesYarnPnp
} from '../src/main/targets/launcher'
export {
  dedupeCandidates,
  fromWorkspaceRelative,
  resolveConfigArg,
  scanWorkspace,
  toPosixRelative,
  workspaceRelative
} from '../src/main/targets/scan'
export {
  defaultExec,
  listTarget,
  looksLikeMissingAuthState,
  looksLikeMissingEnv,
  parseListReport
} from '../src/main/targets/list'
export {
  buildUserConfigTarget,
  cacheDiscovery,
  cachedDiscovery,
  cacheUserTarget,
  candidateToTarget,
  discoverTargets,
  listTestsForProject,
  resolveImportTarget,
  rescanRegisteredTargets,
  runnableFor,
  setActiveTarget,
  targetsStateFor,
  toSummary
} from '../src/main/targets/service'
export { environmentSetupHintsFor } from '../src/main/targets/environment'
export { declIdentity } from '../src/shared/ipc'
export {
  EXPERIMENTAL_PLAYWRIGHT_TAGS,
  LATEST_VERIFIED_PLAYWRIGHT_VERSION,
  MINIMUM_PLAYWRIGHT_VERSION,
  PLAYWRIGHT_SCAFFOLD_OPTIONS,
  VERIFIED_PLAYWRIGHT_VERSIONS,
  assertSupportedPlaywright,
  playwrightScaffoldOption,
  playwrightCompatibility
} from '../src/shared/playwright-compat'
export { envProfileFromText, envProfileToText } from '../src/shared/env-profile'
export { inspectProject } from '../src/main/inspect'
export { resolveProjectFile } from '../src/main/projects'
export { reporterPath, reporterSource } from '../src/main/reporter'
export { resolveRunRequest } from '../src/main/runrequest'
export { resolveUiModeRequest } from '../src/main/uimoderequest'
export { startRun, stopRun } from '../src/main/runner'
export {
  clampSidebarWidth,
  isValidEnvProfiles,
  loadSettings,
  projectRunEnv,
  pruneProjectViewContext,
  sanitizeWorkspaceUi,
  saveSettings,
  updateSettings,
  wrightbenchDir
} from '../src/main/settings'
export {
  applicableProjectNames,
  buildTestFolderTree,
  buildTestLocation,
  buildTestTitleGrep,
  filterTree,
  isFiltering,
  pruneViewContext,
  specRootPath,
  specSummary,
  testKeyOf
} from '../src/renderer/src/lib/sidebar'
export {
  groupTargets,
  isRunRecipe,
  radioNavigationIndex,
  standaloneRecoveryFor,
  targetDiagnosticPresentation,
  targetConfigurationKey,
  targetStatusPresentation
} from '../src/renderer/src/lib/targets'
export {
  beginUiModeContextChange,
  openExternalUiMode,
  prepareUiModeForCliRun,
  registeredUiModeOrigin,
  resolveUiModeLaunchSpec,
  restartUiMode,
  selectUiModeDiagnostic,
  setUiModeEventSink,
  startUiMode,
  stopAllUiModeSessions,
  stopUiMode,
  validateUiModeWsEndpoint
} from '../src/main/uimode'
export { sweepUiEventFiles, uiEventsDir, UiRunRecorder, UiSessionChannel } from '../src/main/uisession'

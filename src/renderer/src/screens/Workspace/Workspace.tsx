import { useEffect, type JSX } from 'react'
import { useNow } from './useNow'
import {
  StatusBar,
  StatusBarElapsed,
  StatusBarFailed,
  StatusBarItem,
  StatusBarProgress
} from '@/components/StatusBar/StatusBar'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import { Tabs } from '@/components/Tabs/Tabs'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { useHistory } from '@/state/history'
import { declStatus, useRun } from '@/state/run'
import { useSidebar } from '@/state/sidebar'
import { useUiMode } from '@/state/uimode'
import { useWorkspace } from '@/state/workspace'
import type { ProjectInfo } from '@shared/ipc'
import { useCodegen } from '@/state/codegen'
import { CodegenView } from '../Codegen/CodegenView'
import { TracesView } from '../Traces/TracesView'
import { UiModeView } from '../UiMode/UiModeView'
import { SettingsView } from '../Settings/SettingsView'
import { ProjectUnavailable } from './ProjectUnavailable'
import { ResultsList } from './ResultsList'
import { HistoryView } from './HistoryView'
import { ModeDock } from './ModeDock'
import { RunsView } from './RunsView'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { TestInspector } from './TestInspector'
import styles from './Workspace.module.css'

const MAIN_TABS = ['Tests', 'UI Mode', 'Runs', 'Codegen'] as const

/**
 * The suite-level workspace remains implemented below, but the current product
 * surface is deliberately focused on one selected test at a time.
 */
const TEST_DETAIL_WORKSPACE = true
/** The mode dock remains implemented but is hidden in the UI-first product surface. */
const SHOW_MODE_DOCK = false

function FocusedTestEmpty(): JSX.Element {
  return (
    <div className={styles.focusedEmpty}>
      <div className={styles.focusedEmptyBody}>
        <span className={styles.focusedEmptyIcon}>
          <Icon name="chevron-right" size={13} />
        </span>
        <h2>Select a test</h2>
        <p>Choose a test from the sidebar to inspect its runs, history, video, report, and trace.</p>
      </div>
    </div>
  )
}

/** "Recording · 0:42" tab-strip pill (artboard 09) */
function RecordingPill(): JSX.Element | null {
  const recording = useCodegen((s) => s.recording)
  const startedAt = useCodegen((s) => s.startedAt)
  const now = useNow(recording)
  if (!recording || startedAt === null) return null
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return (
    <span className={styles.recordingPill}>
      <span className={styles.recordingDot} />
      Recording · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function RunsStatusBar({ project }: { project: ProjectInfo }): JSX.Element {
  const analytics = useHistory((s) => s.analytics)
  const monoParts = [
    project.nodeVersion ? `Node ${project.nodeVersion}` : null,
    project.playwrightVersion ? `Playwright v${project.playwrightVersion}` : null
  ].filter(Boolean)
  const oldest =
    analytics?.oldestKeptAt != null
      ? new Date(analytics.oldestKeptAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short'
        })
      : null
  return (
    <StatusBar mono={monoParts.join(' · ')}>
      <StatusBarItem>
        <StatusDot status="pass" />
        Idle
      </StatusBarItem>
      <span>
        {analytics && analytics.totalRuns > 0
          ? `${analytics.totalRuns} runs recorded${oldest ? ` · oldest kept ${oldest}` : ''}`
          : 'No runs recorded yet'}
      </span>
    </StatusBar>
  )
}

/** shared "folder is gone" status line — cached metadata must not look healthy */
function UnavailableStatusBar(): JSX.Element {
  return (
    <StatusBar mono="">
      <StatusBarItem>
        <Icon name="warning" size={12} color="var(--flaky)" />
        Project unavailable
      </StatusBarItem>
      <span>Reports remain available from the global header.</span>
    </StatusBar>
  )
}

function WsStatusBar({ project }: { project: ProjectInfo }): JSX.Element {
  const running = useRun((s) => s.running)
  const instanceDone = useRun((s) => s.instanceDone)
  const instanceTotal = useRun((s) => s.instanceTotal)
  const decls = useRun((s) => s.decls)
  const startedAt = useRun((s) => s.startedAt)
  const runError = useRun((s) => s.runError)
  const uiStatus = useUiMode((s) => s.status)
  const uiRecordingSupported = useUiMode((s) => s.recording.supported)
  const uiRun = useUiMode((s) => s.run)
  const now = useNow(running)

  const monoParts = [
    project.nodeVersion ? `Node ${project.nodeVersion}` : null,
    project.playwrightVersion ? `Playwright v${project.playwrightVersion}` : null
  ].filter(Boolean)
  const mono = monoParts.join(' · ')

  if (running) {
    let failed = 0
    for (const decl of Object.values(decls)) {
      if (declStatus(decl) === 'fail') failed += 1
    }
    const percent = instanceTotal > 0 ? (instanceDone / instanceTotal) * 100 : 0
    return (
      <StatusBar running mono={mono}>
        <StatusBarItem>
          <Spinner size={11} />
          {instanceTotal === 0
            ? 'Running · starting (config + web servers)…'
            : `Running ${instanceDone} / ${instanceTotal}`}
        </StatusBarItem>
        <StatusBarProgress percent={percent} />
        {failed > 0 && <StatusBarFailed>{failed} failed so far</StatusBarFailed>}
        <StatusBarElapsed>
          elapsed {formatElapsed(startedAt ? now - startedAt : 0)}
        </StatusBarElapsed>
      </StatusBar>
    )
  }

  if (uiRun !== null) {
    const percent = uiRun.total > 0 ? (uiRun.done / uiRun.total) * 100 : 0
    return (
      <StatusBar running mono={mono}>
        <StatusBarItem>
          <Spinner size={11} />
          UI Mode run #{uiRun.runNumber} · {uiRun.done} / {uiRun.total}
        </StatusBarItem>
        <StatusBarProgress percent={percent} />
        {uiRun.failed > 0 && <StatusBarFailed>{uiRun.failed} failed so far</StatusBarFailed>}
      </StatusBar>
    )
  }

  if (uiStatus === 'external' || (uiStatus === 'ready' && !uiRecordingSupported)) {
    return (
      <StatusBar mono={mono}>
        <StatusBarItem>
          <StatusDot status="queued" />
          UI Mode active
        </StatusBarItem>
        <span>
          {uiStatus === 'external'
            ? 'Native UI Mode is open in another window.'
            : 'Run activity is unavailable for this Playwright version.'}
        </span>
      </StatusBar>
    )
  }

  if (uiStatus === 'starting' || uiStatus === 'restarting') {
    return (
      <StatusBar running mono={mono}>
        <StatusBarItem>
          <Spinner size={11} />
          {uiStatus === 'restarting' ? 'Restarting UI Mode…' : 'Starting UI Mode…'}
        </StatusBarItem>
      </StatusBar>
    )
  }

  if (uiStatus === 'ready') {
    return (
      <StatusBar mono={mono}>
        <StatusBarItem>
          <StatusDot status="pass" />
          UI Mode ready
        </StatusBarItem>
        <span>Runs save to Reports</span>
      </StatusBar>
    )
  }

  if (uiStatus === 'crashed') {
    return (
      <StatusBar mono={mono}>
        <StatusBarItem>
          <StatusDot status="fail" />
          UI Mode unavailable
        </StatusBarItem>
        <span>Retry from the workspace.</span>
      </StatusBar>
    )
  }

  return (
    <StatusBar mono={mono}>
      <StatusBarItem>
        <StatusDot status={runError ? 'fail' : 'queued'} />
        UI Mode paused
      </StatusBarItem>
      {runError && <StatusBarFailed>{runError}</StatusBarFailed>}
    </StatusBar>
  )
}

export function Workspace(): JSX.Element {
  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const tab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const externalTraceOpen = useWorkspace((s) => s.externalTraceOpen)
  const closeExternalTrace = useWorkspace((s) => s.closeExternalTrace)
  const uiModeOpen = useWorkspace((s) => s.uiModeOpen)
  const recordOpen = useWorkspace((s) => s.recordOpen)
  const historyOpen = useWorkspace((s) => s.historyOpen)
  const settingsOpen = useWorkspace((s) => s.settingsOpen)
  const closeSettings = useWorkspace((s) => s.closeSettings)
  const initWorkspace = useRun((s) => s.initWorkspace)
  const refreshPersistedStatuses = useRun((s) => s.refreshPersistedStatuses)
  const running = useRun((s) => s.running)
  const tree = useRun((s) => s.tree)
  const activeTargetId = useRun((s) => s.activeTargetId)
  const treeError = useRun((s) => s.treeError)
  const selectedKey = useRun((s) => s.selectedKey)
  const uiSessionPath = useUiMode((s) => s.path)
  const uiStatus = useUiMode((s) => s.status)
  const uiRunActive = useUiMode((s) => s.run !== null)
  const uiRecordingSupported = useUiMode((s) => s.recording.supported)
  const uiLastSavedAt = useUiMode((s) => s.lastSaved?.at ?? null)
  const codegenPath = useCodegen((s) => s.path)
  const codegenStatus = useCodegen((s) => s.status)
  const sidebarCollapsed = useSidebar((s) => s.collapsed)
  const toggleSidebar = useSidebar((s) => s.toggleCollapsed)

  const active =
    projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null
  const activeHealthState = active?.health.state ?? 'available'

  useEffect(() => {
    // an unavailable folder still switches state, but skips the doomed listing
    if (active) void initWorkspace(active.path, activeHealthState === 'available', active.id)
  }, [active?.path, initWorkspace])

  // Native UI Mode records directly to SQLite, bypassing the CLI run store.
  // Refresh only the dots after a saved UI run; relisting Playwright is costly.
  useEffect(() => {
    if (active && uiLastSavedAt !== null && uiSessionPath === active.path) {
      void refreshPersistedStatuses()
    }
  }, [active?.path, refreshPersistedStatuses, uiLastSavedAt, uiSessionPath])

  // persisted sidebar chrome + per-project view contexts
  useEffect(() => {
    void useSidebar.getState().init()
  }, [])

  // Cmd/Ctrl+B toggles the sidebar on Tests/Runs — never while typing
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el || !el.tagName) return false
      const tag = el.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'WEBVIEW' ||
        el.isContentEditable === true
      )
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'b' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey)
        return
      const currentTab = useWorkspace.getState().tab
      if (
        TEST_DETAIL_WORKSPACE &&
        (useWorkspace.getState().uiModeOpen ||
          useWorkspace.getState().recordOpen ||
          useWorkspace.getState().historyOpen ||
          useWorkspace.getState().settingsOpen)
      )
        return
      if (!TEST_DETAIL_WORKSPACE && currentTab !== 'Tests' && currentTab !== 'Runs') return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      useSidebar.getState().toggleCollapsed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!active) return <div className={styles.placeholder}>No project in the workspace yet.</div>

  // UI Mode and Codegen are full-width; Tests/Runs retain the sidebar.
  const hasSidebar =
    !externalTraceOpen &&
    !uiModeOpen &&
    !recordOpen &&
    !historyOpen &&
    !settingsOpen &&
    (TEST_DETAIL_WORKSPACE || tab === 'Tests' || tab === 'Runs')
  const healthy = activeHealthState === 'available'
  // once opened for this project, the session's webview stays mounted across
  // tab switches (hidden, not unmounted) so Playwright's UI keeps its state
  const keepUiMounted = healthy && uiStatus !== 'idle' && uiSessionPath === active.path
  const keepRecordMounted =
    healthy &&
    codegenPath === active.path &&
    (codegenStatus === 'starting' || codegenStatus === 'ready' || codegenStatus === 'stopping')
  const historyExecutionActive =
    running ||
    uiRunActive ||
    uiStatus === 'starting' ||
    uiStatus === 'restarting' ||
    uiStatus === 'external' ||
    (uiStatus === 'ready' && !uiRecordingSupported)

  return (
    <div className={styles.row}>
      {hasSidebar && !sidebarCollapsed && (
        <Sidebar />
      )}
      <div className={styles.mainCol}>
        {!TEST_DETAIL_WORKSPACE && (
          <Tabs
            tabs={MAIN_TABS}
            active={tab}
            onChange={setTab}
            leading={
              hasSidebar ? (
                <Button
                  variant="ghost"
                  size={26}
                  padX={5}
                  aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}B)`}
                  onClick={toggleSidebar}
                >
                  <Icon name={sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={12} />
                </Button>
              ) : undefined
            }
            trailing={
              tab === 'Codegen' ? (
                <RecordingPill />
              ) : undefined
            }
          />
        )}
        <div className={styles.contentStack}>
          {TEST_DETAIL_WORKSPACE ? (
            <div
              className={
                uiModeOpen || recordOpen || historyOpen || settingsOpen
                  ? styles.focusedSurfaceHidden
                  : styles.focusedSurface
              }
              aria-hidden={uiModeOpen || recordOpen || historyOpen || settingsOpen || undefined}
              inert={uiModeOpen || recordOpen || historyOpen || settingsOpen || undefined}
            >
              {externalTraceOpen ? (
                <div className={styles.contextTrace}>
                  <div className={styles.contextHeader}>
                    <button type="button" onClick={closeExternalTrace}>
                      <Icon name="chevron-left" size={12} />
                      Back to test
                    </button>
                    <span>Trace opened from disk</span>
                  </div>
                  <TracesView project={active} />
                </div>
              ) : !healthy ? (
                <ProjectUnavailable project={active} kind="health" />
              ) : treeError !== null && tree === null ? (
                <ProjectUnavailable project={active} kind="load" />
              ) : selectedKey ? (
                <>
                  <Toolbar focused />
                  <TestInspector project={active} />
                </>
              ) : (
                <FocusedTestEmpty />
              )}
            </div>
          ) : externalTraceOpen ? (
            <div className={styles.contextTrace}>
              <div className={styles.contextHeader}>
                <button type="button" onClick={closeExternalTrace}>
                  <Icon name="chevron-left" size={12} />
                  Back to tests
                </button>
                <span>Trace opened from disk</span>
              </div>
              <TracesView project={active} />
            </div>
          ) : tab === 'Runs' ? (
            // history is Wrightbench-owned — usable even when the folder is gone
            <RunsView path={active.path} />
          ) : !healthy ? (
            <ProjectUnavailable project={active} kind="health" />
          ) : tab === 'Tests' ? (
            treeError !== null && tree === null ? (
              <ProjectUnavailable project={active} kind="load" />
            ) : (
              <>
                <Toolbar />
                <div className={styles.contentRow}>
                  {selectedKey ? (
                    <TestInspector project={active} />
                  ) : (
                    <ResultsList />
                  )}
                </div>
              </>
            )
          ) : tab === 'Codegen' ? (
            <CodegenView project={active} targetId={tree?.targetId ?? activeTargetId} />
          ) : null}
          {!TEST_DETAIL_WORKSPACE && (tab === 'UI Mode' || keepUiMounted) && healthy && (
            <div
              className={tab === 'UI Mode' ? styles.uiModeHost : styles.uiModeHostHidden}
              aria-hidden={tab !== 'UI Mode'}
            >
              <UiModeView
                project={active}
                targetId={tree?.targetId ?? activeTargetId}
                active={tab === 'UI Mode'}
              />
            </div>
          )}
          {TEST_DETAIL_WORKSPACE && (uiModeOpen || keepUiMounted) && healthy && (
            <div
              className={
                uiModeOpen && !recordOpen && !historyOpen && !settingsOpen && !externalTraceOpen
                  ? styles.uiModeHost
                  : styles.uiModeHostHidden
              }
              aria-hidden={!uiModeOpen || recordOpen || historyOpen || settingsOpen || externalTraceOpen}
            >
              <UiModeView
                project={active}
                targetId={tree?.targetId ?? activeTargetId}
                // Global destinations are only visual overlays. Keep the
                // native lifecycle active underneath so returning does not
                // reload and erase Playwright's current UI state.
                active={uiModeOpen && !externalTraceOpen}
              />
            </div>
          )}
          {TEST_DETAIL_WORKSPACE && (recordOpen || keepRecordMounted) && healthy && (
            <div
              className={
                recordOpen && !settingsOpen && !externalTraceOpen
                  ? styles.recordHost
                  : styles.recordHostHidden
              }
              aria-hidden={!recordOpen || settingsOpen || externalTraceOpen}
              inert={!recordOpen || settingsOpen || externalTraceOpen || undefined}
            >
              <CodegenView project={active} targetId={tree?.targetId ?? activeTargetId} />
            </div>
          )}
          {TEST_DETAIL_WORKSPACE && (
            <div
              className={
                historyOpen && !recordOpen && !settingsOpen && !externalTraceOpen
                  ? styles.historyHost
                  : styles.historyHostHidden
              }
              aria-hidden={!historyOpen || recordOpen || settingsOpen || externalTraceOpen}
              inert={!historyOpen || recordOpen || settingsOpen || externalTraceOpen || undefined}
            >
              <HistoryView project={active} />
            </div>
          )}
          {TEST_DETAIL_WORKSPACE && settingsOpen && (
            <div className={styles.settingsHost}>
              <SettingsView
                onClose={closeSettings}
                returnTo={recordOpen ? 'Record' : historyOpen ? 'Report' : 'Run'}
              />
            </div>
          )}
          {SHOW_MODE_DOCK && !externalTraceOpen && !settingsOpen && (
            <ModeDock uiDisabled={!healthy} />
          )}
        </div>
        {TEST_DETAIL_WORKSPACE && !externalTraceOpen && !settingsOpen && !recordOpen &&
          (historyOpen ? (
            healthy ? (
              historyExecutionActive ? (
                <WsStatusBar project={active} />
              ) : (
                <RunsStatusBar project={active} />
              )
            ) : (
              <UnavailableStatusBar />
            )
          ) : healthy ? (
            <WsStatusBar project={active} />
          ) : (
            <UnavailableStatusBar />
          ))}
        {!TEST_DETAIL_WORKSPACE && !externalTraceOpen && tab === 'Tests' &&
          (healthy ? <WsStatusBar project={active} /> : <UnavailableStatusBar />)}
        {!TEST_DETAIL_WORKSPACE && !externalTraceOpen && tab === 'Runs' &&
          (!healthy ? (
            <UnavailableStatusBar />
          ) : !running ? (
            <RunsStatusBar project={active} />
          ) : (
            <WsStatusBar project={active} />
          ))}
      </div>
    </div>
  )
}

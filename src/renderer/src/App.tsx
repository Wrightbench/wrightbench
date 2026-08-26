import { useEffect, useState, type JSX } from 'react'
import { TitleBar } from './components/TitleBar/TitleBar'
import KitchenSink from './kitchen-sink/KitchenSink'
import { RecordHeaderAction } from './screens/Codegen/RecordHeaderAction'
import { Detection } from './screens/Detection/Detection'
import { SettingsView } from './screens/Settings/SettingsView'
import { UiModeHeaderActions } from './screens/UiMode/UiModeView'
import { Welcome } from './screens/Welcome/Welcome'
import { ProjectSwitcher } from './screens/Workspace/ProjectSwitcher'
import { Workspace } from './screens/Workspace/Workspace'
import { useSidebar } from './state/sidebar'
import { useTraces } from './state/traces'
import { useWorkspace } from './state/workspace'
import styles from './App.module.css'

function useDevRoute(): string {
  const [route, setRoute] = useState(window.location.hash)
  useEffect(() => {
    const onHash = (): void => setRoute(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

/** Lean, launch-context-only import fixture for browser-pane checks. */
const PREVIEW_TARGET = {
  id: 't-preview',
  label: 'playwright.config.ts',
  cwd: '.',
  configPath: 'playwright.config.ts',
  packageDir: '.',
  launcher: 'npm' as const,
  source: 'config' as const,
  scriptName: null,
  playwrightVersion: '1.62.1',
  testCount: 128,
  runnable: true,
  runnableReason: null,
  status: 'ready' as const,
  diagnostic: null,
  recording: { supported: true, reason: null },
  environmentSetupHints: [],
  specFiles: 12,
  projectNames: ['chromium', 'firefox', 'webkit'],
  configuredProjectNames: ['chromium', 'firefox', 'webkit'],
  rootDir: 'tests/e2e'
}

const PREVIEW_INSPECTION = {
  path: '~/dev/acme/web-app',
  name: 'web-app',
  configFile: 'playwright.config.ts',
  playwrightVersion: '1.62.1',
  targets: [PREVIEW_TARGET],
  recommendedTargetId: 't-preview'
}

/** Installed package missing: import stays blocked until Retry detection succeeds. */
const PREVIEW_INSPECTION_MISSING = {
  ...PREVIEW_INSPECTION,
  name: 'checkout-e2e',
  path: '~/dev/acme/checkout-e2e',
  playwrightVersion: null,
  targets: [
    {
      ...PREVIEW_TARGET,
      playwrightVersion: null,
      recording: {
        supported: false,
        reason: 'Install project dependencies to determine recording support.'
      }
    }
  ]
}

/** Multi-configuration import fixture; run recipes intentionally stay hidden. */
const PREVIEW_INSPECTION_MULTI = {
  ...PREVIEW_INSPECTION,
  name: 'acme-monorepo',
  path: '~/dev/acme/acme-monorepo',
  targets: [
    PREVIEW_TARGET,
    {
      ...PREVIEW_TARGET,
      id: 't-preview-admin',
      label: 'packages/admin/playwright.config.ts',
      cwd: 'packages/admin',
      packageDir: 'packages/admin',
      configPath: 'packages/admin/playwright.config.ts',
      testCount: null,
      specFiles: null,
      projectNames: null,
      configuredProjectNames: null,
      rootDir: null,
      runnable: true,
      runnableReason: null,
      status: 'not-validated' as const,
      environmentSetupHints: [],
      diagnostic: null
    },
    {
      ...PREVIEW_TARGET,
      id: 't-preview-generated',
      label: 'packages/extension/playwright.config.ts',
      cwd: 'packages/extension',
      packageDir: 'packages/extension',
      configPath: 'packages/extension/playwright.config.ts',
      testCount: null,
      specFiles: null,
      projectNames: null,
      configuredProjectNames: ['default'],
      rootDir: null,
      runnable: true,
      runnableReason: null,
      status: 'not-validated' as const,
      diagnostic: null
    }
  ],
  recommendedTargetId: 't-preview'
}

/** Full-window drag & drop — a trace opens as a contextual hosted surface. */
function useTraceDrop(): void {
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')

    // preventDefault on both, or Electron navigates to any dropped file
    const onDragOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file || !window.wrightbench) return
      const path = window.wrightbench.getPathForFile(file)
      if (!path || !path.endsWith('.zip')) return
      const ws = useWorkspace.getState()
      const project =
        ws.projects.find((p) => p.id === ws.activeProjectId) ??
        ws.projects[ws.projects.length - 1]
      if (project && ws.screen.name === 'workspace') {
        // drops must land somewhere visible — never behind the Settings screen
        ws.closeSettings()
        ws.openExternalTrace()
        void useTraces.getState().addExternal(project.path, path)
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
}

export default function App(): JSX.Element {
  const route = useDevRoute()
  const screen = useWorkspace((s) => s.screen)
  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const settingsOpen = useWorkspace((s) => s.settingsOpen)
  const externalTraceOpen = useWorkspace((s) => s.externalTraceOpen)
  const uiModeOpen = useWorkspace((s) => s.uiModeOpen)
  const recordOpen = useWorkspace((s) => s.recordOpen)
  const historyOpen = useWorkspace((s) => s.historyOpen)
  const sidebarCollapsed = useSidebar((s) => s.collapsed)
  const toggleSidebar = useSidebar((s) => s.toggleCollapsed)
  const init = useWorkspace((s) => s.init)
  useTraceDrop()

  useEffect(() => {
    void init()
  }, [init])

  // dev routes: boot straight into a screen fixture for pixel checks
  useEffect(() => {
    if (route === '#preview-uimode-error') {
      useWorkspace.setState({
        screen: { name: 'workspace' },
        settingsOpen: false,
        externalTraceOpen: false,
        uiModeOpen: true,
        recordOpen: false,
        historyOpen: false
      })
    } else if (route === '#preview-workspace') {
      useWorkspace.setState({
        settingsOpen: false,
        tab: 'Tests',
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false
      })
    } else if (route === '#preview-settings') {
      useWorkspace.setState({ settingsOpen: true, uiModeOpen: false, recordOpen: false, historyOpen: false })
    } else if (route === '#preview-codegen') {
      useWorkspace.setState({
        screen: { name: 'workspace' },
        settingsOpen: false,
        tab: 'Codegen',
        externalTraceOpen: false,
        uiModeOpen: false,
        recordOpen: true,
        historyOpen: false
      })
    } else if (route === '#preview-traces') {
      useWorkspace.setState({
        settingsOpen: false,
        externalTraceOpen: true,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false
      })
    } else if (route === '#preview-reports') {
      // Reports are now contextual to a selected test run.
      useWorkspace.setState({
        settingsOpen: false,
        tab: 'Tests',
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false
      })
    } else if (route === '#preview-scaffold') {
      useWorkspace.setState({
        settingsOpen: false,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        screen: {
          name: 'scaffold-setup',
          path: '/Users/ada/Projects/checkout-tests',
          version: '1.62.1'
        }
      })
      return () => {
        const current = useWorkspace.getState()
        if (current.screen.name === 'scaffold-setup') {
          useWorkspace.setState({
            screen: current.projects.length > 0 ? { name: 'workspace' } : { name: 'welcome' }
          })
        }
      }
    } else if (
      route === '#preview-detection' ||
      route === '#preview-detection-multi' ||
      route === '#preview-detection-missing'
    ) {
      // store-backed so target selection on the card is interactive
      const fixture =
        route === '#preview-detection-multi'
          ? PREVIEW_INSPECTION_MULTI
          : route === '#preview-detection-missing'
            ? PREVIEW_INSPECTION_MISSING
          : PREVIEW_INSPECTION
      useWorkspace.setState({
        settingsOpen: false,
        uiModeOpen: false,
        recordOpen: false,
        historyOpen: false,
        screen: {
          name: 'detection',
          inspection: fixture,
          selectedTargetId: fixture.recommendedTargetId
        }
      })
      // navigating to another route must not leave the fixture card behind
      return () => {
        const current = useWorkspace.getState()
        if (current.screen.name === 'detection' && current.screen.inspection.path === fixture.path) {
          useWorkspace.setState({
            screen: current.projects.length > 0 ? { name: 'workspace' } : { name: 'welcome' }
          })
        }
      }
    }
    return undefined
  }, [route])

  // Esc leaves Settings (the design gives it no close button)
  useEffect(() => {
    if (!settingsOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useWorkspace.getState().closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  if (route === '#kitchen-sink') return <KitchenSink />

  // Import recovery can open Settings before a workspace exists. That remains
  // the quiet full-window variant; inside a workspace Settings is a global
  // destination layered by Workspace so the active execution surface survives.
  if (settingsOpen && screen.name !== 'workspace') {
    return (
      <div className={styles.shell}>
        <TitleBar title="Wrightbench — Settings" variant="quiet" />
        <SettingsView />
      </div>
    )
  }

  if (
    route === '#preview-detection' ||
    route === '#preview-detection-multi' ||
    route === '#preview-detection-missing'
  ) {
    // the route effect above seeds the store; render from it so the card's
    // target selection and retry actions are live in the preview
    return (
      <div className={styles.shell}>
        <TitleBar title="Wrightbench" variant="quiet" />
        {screen.name === 'detection' && <Detection screen={screen} />}
      </div>
    )
  }

  const active =
    projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null

  const openUiMode = (): void => useWorkspace.getState().openUiMode()
  const openRecord = (): void => useWorkspace.getState().openRecord()
  const openReports = (): void => useWorkspace.getState().openHistory()
  const toggleSettings = (): void => {
    const workspace = useWorkspace.getState()
    if (workspace.settingsOpen) workspace.closeSettings()
    else workspace.openSettings()
  }

  return (
    <div className={styles.shell}>
      {screen.name === 'welcome' && (
        <>
          <TitleBar title="" variant="quiet" borderless />
          <Welcome />
        </>
      )}
      {(screen.name === 'inspecting' ||
        screen.name === 'detection' ||
        screen.name === 'scaffold-setup' ||
        screen.name === 'scaffolding') && (
        <>
          <TitleBar title="Wrightbench" variant="quiet" />
          <Detection screen={screen} />
        </>
      )}
      {screen.name === 'workspace' && (
        <>
          <TitleBar
            title="Wrightbench"
            sidebarCollapsed={sidebarCollapsed}
            onSidebarToggle={
              !externalTraceOpen && !recordOpen && !uiModeOpen && !historyOpen && !settingsOpen && active
                ? toggleSidebar
                : undefined
            }
            projectControl={active ? <ProjectSwitcher placement="titlebar" /> : undefined}
            activeDestination={recordOpen ? 'record' : historyOpen ? 'reports' : 'ui-mode'}
            onRecordClick={active ? openRecord : undefined}
            onUiModeClick={active ? openUiMode : undefined}
            onReportsClick={active ? openReports : undefined}
            settingsActive={settingsOpen}
            onSettingsClick={toggleSettings}
            sessionControls={
              recordOpen ? <RecordHeaderAction /> : uiModeOpen ? <UiModeHeaderActions /> : undefined
            }
          />
          <Workspace />
        </>
      )}
    </div>
  )
}

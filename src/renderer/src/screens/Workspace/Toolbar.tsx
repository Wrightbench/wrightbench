import { useEffect, useMemo, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { Select } from '@/components/Select/Select'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { TogglePill } from '@/components/TogglePill/TogglePill'
import { applicableProjectNames } from '@/lib/sidebar'
import { useRun } from '@/state/run'
import { uiModeBlocksOtherWork, useUiMode } from '@/state/uimode'
import styles from './Toolbar.module.css'

const WORKER_OPTIONS = [
  { value: 'auto', label: 'auto workers' },
  { value: '1', label: '1 worker' },
  { value: '2', label: '2 workers' },
  { value: '4', label: '4 workers' },
  { value: '8', label: '8 workers' }
]

export function Toolbar({ focused = false }: { focused?: boolean }): JSX.Element {
  const running = useRun((s) => s.running)
  const startRun = useRun((s) => s.startRun)
  const stopRun = useRun((s) => s.stopRun)
  const watch = useRun((s) => s.watch)
  const toggleWatch = useRun((s) => s.toggleWatch)
  const tree = useRun((s) => s.tree)
  const selectedKey = useRun((s) => s.selectedKey)
  const project = useRun((s) => s.project)
  const setProject = useRun((s) => s.setProject)
  const workers = useRun((s) => s.workers)
  const setWorkers = useRun((s) => s.setWorkers)
  const workersBusy = useRun((s) => s.workersBusy)
  const statuses = useRun((s) => s.statuses)
  const uiStatus = useUiMode((s) => s.status)
  const uiRun = useUiMode((s) => s.run)
  const uiRecording = useUiMode((s) => s.recording)
  const uiBusy = uiModeBlocksOtherWork({ status: uiStatus, run: uiRun, recording: uiRecording })

  const hasFailures = Object.values(statuses).some((s) => s.status === 'fail')
  const applicableProjects = useMemo(
    () => applicableProjectNames(tree, selectedKey),
    [selectedKey, tree]
  )
  const projectOptions = [
    { value: '', label: selectedKey ? 'All applicable projects' : 'All projects' },
    ...applicableProjects
  ]

  useEffect(() => {
    if (selectedKey && project && !applicableProjects.includes(project)) setProject('')
  }, [applicableProjects, project, selectedKey, setProject])

  return (
    <div className={styles.toolbar}>
      {!focused && (
        <>
          {running ? (
            <Button variant="danger-outline" size={32} onClick={() => void stopRun()}>
              <Icon name="stop" size={11} />
              Stop run
            </Button>
          ) : (
            <Button
              variant="primary"
              size={32}
              disabled={uiBusy}
              title={uiBusy ? 'Stop the active UI Mode session first' : undefined}
              onClick={() => void startRun()}
            >
              <Icon name="play" size={12} />
              Run all
            </Button>
          )}
          <Button
            variant="ghost"
            size={32}
            disabled={running || uiBusy || !hasFailures}
            onClick={() => void startRun({ lastFailed: true })}
          >
            <Icon name="rotate-cw" size={13} color="var(--fail)" />
            Re-run failed
          </Button>
          <TogglePill
            icon="eye"
            active={watch}
            disabled={uiBusy}
            title={uiBusy ? 'Stop the active UI Mode session first' : undefined}
            onClick={() => void toggleWatch()}
          >
            Watch
          </TogglePill>
          <div className={styles.divider} aria-hidden />
        </>
      )}
      <Select
        options={projectOptions}
        value={project ?? ''}
        onChange={setProject}
        dimmed={running}
        aria-label="Playwright project"
      />
      {running && !focused ? (
        <span className={styles.workersBusy}>
          <Spinner size={12} />
          {workersBusy ?? '…'} workers busy
        </span>
      ) : !focused ? (
        <Select
          options={WORKER_OPTIONS}
          value={workers}
          onChange={setWorkers}
          muted
          style={{ marginLeft: 'auto' }}
          aria-label="Worker count"
        />
      ) : null}
    </div>
  )
}

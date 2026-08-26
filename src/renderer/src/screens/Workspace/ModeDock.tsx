import type { JSX } from 'react'
import { Icon } from '@/components/Icon/Icon'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { useRun } from '@/state/run'
import { useUiMode } from '@/state/uimode'
import { useWorkspace } from '@/state/workspace'
import styles from './ModeDock.module.css'

/** Persistent execution-surface navigation. Reports stays in global chrome. */
export function ModeDock({ uiDisabled = false }: { uiDisabled?: boolean }): JSX.Element {
  const uiModeOpen = useWorkspace((state) => state.uiModeOpen)
  const historyOpen = useWorkspace((state) => state.historyOpen)
  const openCliMode = useWorkspace((state) => state.openCliMode)
  const openUiMode = useWorkspace((state) => state.openUiMode)
  const cliRunning = useRun((state) => state.running)
  const uiStatus = useUiMode((state) => state.status)
  const uiRun = useUiMode((state) => state.run)

  const cliActive = !historyOpen && !uiModeOpen
  const uiActive = !historyOpen && uiModeOpen
  const uiBusy = uiRun !== null || uiStatus === 'starting' || uiStatus === 'restarting'

  return (
    <div className={styles.wrap}>
      <div className={styles.dock} role="group" aria-label="Execution mode">
        <button
          type="button"
          className={cliActive ? `${styles.mode} ${styles.modeActive}` : styles.mode}
          aria-pressed={cliActive}
          onClick={openCliMode}
        >
          <span className={styles.icon} aria-hidden>
            {cliRunning ? <Spinner size={11} /> : <Icon name="play" size={10} />}
          </span>
          CLI Mode
        </button>
        <button
          type="button"
          className={uiActive ? `${styles.mode} ${styles.modeActive}` : styles.mode}
          aria-pressed={uiActive}
          disabled={uiDisabled}
          title={uiDisabled ? 'UI Mode is unavailable while the project folder is missing' : undefined}
          onClick={openUiMode}
        >
          <span className={styles.icon} aria-hidden>
            {uiBusy ? <Spinner size={11} /> : <Icon name="grid" size={12} />}
          </span>
          UI Mode
        </button>
      </div>
    </div>
  )
}

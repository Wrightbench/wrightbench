import type { JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { useCodegen } from '@/state/codegen'
import styles from './RecordHeaderAction.module.css'

/**
 * Ends the Wrightbench-owned Record session and closes its headed browser.
 * Playwright's native Stop Recording control only pauses action capture, so
 * this lifecycle action deliberately lives outside the embedded Inspector.
 */
export function RecordHeaderAction(): JSX.Element | null {
  const status = useCodegen((state) => state.status)
  const stop = useCodegen((state) => state.stop)
  const visible = status === 'starting' || status === 'ready' || status === 'stopping'

  if (!visible) return null

  const stopping = status === 'stopping'
  const starting = status === 'starting'
  const label = stopping ? 'Ending session…' : starting ? 'Cancel session' : 'End session'

  return (
    <div className={styles.root}>
      <Button
        className={styles.button}
        variant="danger"
        size={26}
        padX={10}
        disabled={stopping}
        aria-label={`${label}; close the Playwright browser`}
        title="Close the Playwright browser and end the Record session"
        onClick={() => void stop()}
      >
        {stopping ? <Spinner size={11} /> : <Icon name="stop" size={9} />}
        {label}
      </Button>
    </div>
  )
}

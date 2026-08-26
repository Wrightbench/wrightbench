import type { JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { Icon, LogoMark } from '@/components/Icon/Icon'
import { useWorkspace } from '@/state/workspace'
import styles from './Welcome.module.css'

export function Welcome(): JSX.Element {
  const pickAndInspect = useWorkspace((s) => s.pickAndInspect)
  const scaffold = useWorkspace((s) => s.scaffold)

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.brandLockup} aria-label="Wrightbench">
          <LogoMark size={64} color="var(--brand-mark)" />
          <div className={styles.wordmark}>Wrightbench</div>
        </div>
        <div className={styles.tagline}>Multi-project workbench for Playwright.</div>
        <div className={styles.prop}>
          Record, run, debug and review test suites from one window.
        </div>
        <div className={styles.buttons}>
          <Button variant="primary" size={38} onClick={() => void pickAndInspect()}>
            <Icon name="folder" size={14} />
            Import Playwright project…
          </Button>
          <Button variant="ghost" size={38} transparent onClick={() => void scaffold()}>
            <Icon name="plus" size={14} />
            Create a new Playwright project…
          </Button>
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.footerVersion}>Wrightbench v{__APP_VERSION__}</div>
      </footer>
    </>
  )
}

import type { JSX, ReactNode } from 'react'
import styles from './StatusBar.module.css'

export interface StatusBarProps {
  /** left-side clusters (state dot + labels) */
  children?: ReactNode
  /** right-aligned mono cluster, e.g. "Node v20.12.2 · Playwright v1.46.1" */
  mono?: string
  /** mid-run bars tighten their gap from 16px to 14px */
  running?: boolean
}

export function StatusBar({ children, mono, running }: StatusBarProps): JSX.Element {
  return (
    <div className={running ? `${styles.bar} ${styles.running}` : styles.bar}>
      {children}
      {mono !== undefined && <span className={styles.mono}>{mono}</span>}
    </div>
  )
}

/** inline-flex cluster with the reference's 6px gap (dot + label) */
export function StatusBarItem({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.item}>{children}</span>
}

/** 220×4 accent progress bar from the mid-run status bar */
export function StatusBarProgress({ percent }: { percent: number }): JSX.Element {
  return (
    <span className={styles.track}>
      <span className={styles.fill} style={{ width: `${percent}%` }} />
    </span>
  )
}

/** "2 failed so far" */
export function StatusBarFailed({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.failText}>{children}</span>
}

/** mono elapsed timer, e.g. "elapsed 0:58" */
export function StatusBarElapsed({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.elapsed}>{children}</span>
}

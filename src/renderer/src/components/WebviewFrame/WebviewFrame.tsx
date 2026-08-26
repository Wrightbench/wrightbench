import type { JSX, ReactNode } from 'react'
import styles from './WebviewFrame.module.css'

export interface WebviewFrameProps {
  /** mono header label, e.g. "embedded UI Mode", "embedded Trace Viewer" */
  label: string
  /** green dot before the label ("embedded UI Mode — following run") */
  followDot?: boolean
  /** header left side; defaults to the three skeleton pills from the reference */
  headerLeft?: ReactNode
  /** window-control buttons at the far right of the chrome bar (FrameAction) */
  actions?: ReactNode
  /** the hosted surface (a <webview> in later phases) */
  children?: ReactNode
}

export function WebviewFrame({
  label,
  followDot,
  headerLeft,
  actions,
  children
}: WebviewFrameProps): JSX.Element {
  return (
    <div className={styles.frame}>
      <div className={styles.header}>
        {headerLeft ?? (
          <div className={styles.skeletons} aria-hidden>
            <span className={styles.skeleton} style={{ width: 64 }} />
            <span className={styles.skeleton} style={{ width: 40 }} />
            <span className={styles.skeleton} style={{ width: 52 }} />
          </div>
        )}
        <div className={styles.headerRight}>
          <span className={styles.label}>
            {followDot && <span className={styles.followDot} aria-hidden />}
            {label}
          </span>
          {actions}
        </div>
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  )
}

/** icon button living in the frame's theme-matched chrome bar */
export function FrameAction({
  title,
  onClick,
  children
}: {
  title: string
  onClick?: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.action}
      aria-label={title}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

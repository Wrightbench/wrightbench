import type { JSX } from 'react'
import styles from './StatusDot.module.css'

export type TestStatus = 'pass' | 'fail' | 'flaky' | 'queued' | 'running'

/**
 * Circular spinner in the Playwright UI Mode style: a faint full ring with a
 * 270° accent arc rotating over it (1s linear), so it reads as a circle at
 * any frame. The arc is a dash-stroked <circle>, NOT an SVG `A` path command
 * — Chromium's rasterizer here drops arc-command bodies and paints only
 * their endpoint caps, which is what made the old spinner look like two
 * floating dots. Arc stroke follows the theme's icon accent (--ac-icon).
 */
export function Spinner({ size = 12 }: { size?: 11 | 12 }): JSX.Element {
  return (
    <svg
      className={styles.spinner}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle className={styles.spinnerTrack} cx="8" cy="8" r="6.5" />
      <circle
        className={styles.spinnerArc}
        cx="8"
        cy="8"
        r="6.5"
        stroke="var(--ac-icon)"
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

export interface StatusDotProps {
  status: TestStatus
  /** spinner size when running (list rows use 11, headers 12) */
  spinnerSize?: 11 | 12
}

export function StatusDot({ status, spinnerSize = 12 }: StatusDotProps): JSX.Element {
  if (status === 'running') return <Spinner size={spinnerSize} />
  return <span className={`${styles.dot} ${styles[status]}`} aria-hidden />
}

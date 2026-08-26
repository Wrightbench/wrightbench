import type { HTMLAttributes, JSX } from 'react'
import styles from './Chip.module.css'

export type ChipTone = 'pass' | 'fail' | 'flaky' | 'accent'
/**
 * result — runs-table count chips (11.5/500, 1px 8px)
 * caps   — breadcrumb FAILED (11/600, .05em, 2px 10px)
 * sm     — trace-card FAILED/FLAKY (10.5/600, 0 7px)
 * tag    — DEFAULT profile chip (10.5/600, .04em, 1px 8px)
 */
export type ChipVariant = 'result' | 'caps' | 'sm' | 'tag'

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone: ChipTone
  variant?: ChipVariant
}

export function Chip({
  tone,
  variant = 'result',
  className,
  children,
  ...rest
}: ChipProps): JSX.Element {
  const classes = [styles.chip, styles[variant], styles[tone], className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  )
}

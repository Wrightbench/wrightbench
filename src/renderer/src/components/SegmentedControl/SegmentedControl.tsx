import type { JSX } from 'react'
import { Icon, type IconName } from '../Icon/Icon'
import styles from './SegmentedControl.module.css'

export interface Segment<T extends string> {
  value: T
  label: string
  icon?: IconName
}

export interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[]
  value: T
  onChange?: (value: T) => void
  /**
   * rect — inline group (Before/After/Diff): 8px radius, --card base
   * pill — settings group (Light/Dark/System): 999px, --panel base
   */
  variant?: 'rect' | 'pill'
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  variant = 'pill'
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <div className={`${styles.control} ${styles[variant]}`} role="radiogroup">
      {segments.map((segment) => {
        const active = segment.value === value
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? `${styles.segment} ${styles.segmentActive}` : styles.segment}
            onClick={() => onChange?.(segment.value)}
          >
            {segment.icon && (
              <Icon
                name={segment.icon}
                size={12}
                color={active ? 'var(--ac-icon)' : 'currentColor'}
              />
            )}
            {segment.label}
          </button>
        )
      })}
    </div>
  )
}

import type { JSX, ReactNode } from 'react'
import styles from './Tabs.module.css'

export interface TabsProps<T extends string> {
  tabs: readonly T[]
  active: T
  onChange?: (tab: T) => void
  /** left of the first tab (sidebar collapse toggle) */
  leading?: ReactNode
  /** right-aligned strip content (range select, recording pill) */
  trailing?: ReactNode
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  leading,
  trailing
}: TabsProps<T>): JSX.Element {
  return (
    <div className={styles.strip} role="tablist">
      {leading !== undefined && <div className={styles.leading}>{leading}</div>}
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          className={tab === active ? `${styles.tab} ${styles.active}` : styles.tab}
          onClick={() => onChange?.(tab)}
        >
          {tab}
        </button>
      ))}
      {trailing !== undefined && <div className={styles.trailing}>{trailing}</div>}
    </div>
  )
}

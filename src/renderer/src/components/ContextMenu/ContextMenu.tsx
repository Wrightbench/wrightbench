import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { Icon, type IconName } from '../Icon/Icon'
import styles from './ContextMenu.module.css'

export interface ContextMenuItem {
  label: string
  icon?: IconName
  /** defined for single-select menus; the active item receives a check */
  checked?: boolean
  disabled?: boolean
  /** tooltip, e.g. why the item is disabled */
  title?: string
  /** destructive items render in the fail color */
  danger?: boolean
  onSelect: () => void
}

export interface ContextMenuHeading {
  heading: string
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuHeading | 'separator'

export interface ContextMenuProps {
  entries: ContextMenuEntry[]
  label: string
  /** viewport coordinates (pointer or anchor edge); omit to let the parent position it */
  position?: { x: number; y: number }
  /** 'end' aligns the menu's RIGHT edge to position.x (anchored to a button) */
  align?: 'start' | 'end'
  /** returnFocus=true for keyboard-driven closes (Escape, selection) */
  onClose: (returnFocus: boolean) => void
  /** kitchen-sink preview: static layout, no focus stealing */
  embedded?: boolean
  /** caller positioning for anchored (non-pointer) menus */
  className?: string
  /** anchor clicks are handled by the caller and must not count as outside clicks */
  anchorRef?: RefObject<HTMLElement | null>
}

/**
 * Small action menu (test quick actions, project utilities). Proper menu
 * semantics: roles, arrow-key cycling over enabled items, Escape/outside
 * close, focus lands on the first enabled item on open.
 */
export function ContextMenu({
  entries,
  label,
  position,
  align = 'start',
  onClose,
  embedded,
  className,
  anchorRef
}: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (embedded) return
    const selected = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[aria-checked="true"]:not(:disabled)'
    )
    const first = selected ?? menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    first?.focus()
  }, [embedded])

  // keep viewport-positioned menus fully on screen (they render as
  // position:fixed, so scroll containers can never clip them)
  useLayoutEffect(() => {
    if (!position || !menuRef.current) return
    const el = menuRef.current
    const rect = el.getBoundingClientRect()
    const desiredLeft = align === 'end' ? position.x - rect.width : position.x
    const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [position, align])

  useEffect(() => {
    if (embedded) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !anchorRef?.current?.contains(target)) {
        onClose(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [anchorRef, embedded, onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation() // hosts (e.g. the switcher menu) must not also navigate
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={[
        styles.menu,
        embedded ? styles.embedded : position ? styles.pointer : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry === 'separator') {
          return <div key={`sep-${index}`} className={styles.separator} role="none" />
        }
        if ('heading' in entry) {
          return (
            <div key={`${entry.heading}-${index}`} className={styles.heading} role="presentation">
              {entry.heading}
            </div>
          )
        }
        const radio = entry.checked !== undefined
        return (
          <button
            key={`${entry.label}-${index}`}
            type="button"
            role={radio ? 'menuitemradio' : 'menuitem'}
            aria-checked={radio ? entry.checked : undefined}
            className={entry.danger ? `${styles.item} ${styles.itemDanger}` : styles.item}
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => {
              if (entry.disabled) return
              onClose(true)
              entry.onSelect()
            }}
          >
            {radio && (
              <span className={styles.itemMark} aria-hidden>
                {entry.checked && <Icon name="check" size={12} />}
              </span>
            )}
            {entry.icon && <Icon name={entry.icon} size={13} />}
            <span className={styles.itemLabel}>{entry.label}</span>
          </button>
        )
      })}
    </div>
  )
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type JSX
} from 'react'
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu/ContextMenu'
import { Icon } from '../Icon/Icon'
import styles from './Select.module.css'

export interface SelectOption {
  value: string
  label?: string
  /** optional menu heading; adjacent options with the same group stay together */
  group?: string
}

export interface SelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'size' | 'style'> {
  options: readonly (string | SelectOption)[]
  value: string
  onChange?: (value: string) => void
  /** toolbar selects are 30px; settings selects 28px */
  size?: 30 | 28
  /** controls on --bg use card; controls sitting on a card use panel */
  surface?: 'card' | 'panel'
  /** JetBrains Mono value text (destination spec, code font) */
  mono?: boolean
  /** workers select renders its value in --t2 */
  muted?: boolean
  /** run-lifecycle disabled treatment (55%, stays visible) */
  dimmed?: boolean
  disabled?: boolean
  style?: CSSProperties
}

export function Select({
  options,
  value,
  onChange,
  size = 30,
  surface = 'card',
  mono,
  muted,
  dimmed,
  disabled,
  style,
  className,
  onClick,
  onKeyDown,
  ...rest
}: SelectProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
  const current = opts.find((o) => o.value === value)
  const inactive = disabled || dimmed
  const classes = [
    styles.trigger,
    styles[`h${size}`],
    styles[surface],
    mono ? styles.mono : '',
    muted ? styles.muted : '',
    dimmed ? styles.dimmed : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const closeMenu = useCallback((returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  const openMenu = useCallback((): void => {
    if (inactive || opts.length === 0) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setMenuPosition({ x: rect.left, y: rect.bottom + 4 })
    setOpen(true)
  }, [inactive, opts.length])

  useEffect(() => {
    if (inactive) setOpen(false)
  }, [inactive])

  const entries: ContextMenuEntry[] = []
  let previousGroup: string | undefined
  for (const option of opts) {
    if (option.group && option.group !== previousGroup) {
      if (entries.length > 0) entries.push('separator')
      entries.push({ heading: option.group })
    }
    previousGroup = option.group
    entries.push({
      label: option.label ?? option.value,
      checked: option.value === value,
      onSelect: () => {
        if (option.value !== value) onChange?.(option.value)
      }
    })
  }

  return (
    <span className={styles.root} style={style}>
      <button
        ref={triggerRef}
        type="button"
        className={classes}
        disabled={inactive}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented) return
          if (open) closeMenu(false)
          else openMenu()
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event)
          if (event.defaultPrevented) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu()
          }
        }}
        {...rest}
      >
        <span className={styles.value}>{current?.label ?? value}</span>
        <Icon name="chevron-down" size={11} color="var(--t3)" />
      </button>
      {open && (
        <ContextMenu
          entries={entries}
          label={rest['aria-label'] ?? 'Select option'}
          position={menuPosition}
          anchorRef={triggerRef}
          onClose={closeMenu}
          className={[styles.menu, mono ? styles.menuMono : ''].filter(Boolean).join(' ')}
        />
      )}
    </span>
  )
}

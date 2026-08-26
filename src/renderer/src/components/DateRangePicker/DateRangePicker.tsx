import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Button } from '../Button/Button'
import { Icon } from '../Icon/Icon'
import styles from './DateRangePicker.module.css'

export type DateRangePreset = 'all' | 'today' | '7d' | '30d' | '90d' | 'custom'

export interface DateRangeValue {
  preset: DateRangePreset
  /** Inclusive local-day boundary in milliseconds. */
  from: number | null
  /** Inclusive local-day boundary in milliseconds. */
  to: number | null
}

export const ALL_DATE_RANGE: DateRangeValue = {
  preset: 'all',
  from: null,
  to: null
}

interface DateRangePickerProps {
  value: DateRangeValue
  onChange(value: DateRangeValue): void
  minDate?: number
  maxDate?: number
  ariaLabel?: string
  /** Useful when the picker sits inside a narrow preview or side panel. */
  compact?: boolean
  align?: 'start' | 'end'
}

const PRESETS: { value: Exclude<DateRangePreset, 'custom'>; label: string; days: number | null }[] = [
  { value: 'all', label: 'All time', days: null },
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 }
]

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function endOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function startOfMonth(value: number): number {
  const date = new Date(value)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addDays(value: number, amount: number): number {
  const date = new Date(value)
  date.setDate(date.getDate() + amount)
  return startOfDay(date.getTime())
}

function addMonths(value: number, amount: number): number {
  const date = new Date(value)
  date.setDate(1)
  date.setMonth(date.getMonth() + amount)
  return startOfMonth(date.getTime())
}

function presetValue(
  preset: Exclude<DateRangePreset, 'custom'>,
  now: number
): DateRangeValue {
  const entry = PRESETS.find((candidate) => candidate.value === preset)
  if (!entry?.days) return ALL_DATE_RANGE
  const to = endOfDay(now)
  return {
    preset,
    from: startOfDay(addDays(to, -(entry.days - 1))),
    to
  }
}

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(value)
}

function triggerLabel(value: DateRangeValue): string {
  const preset = PRESETS.find((candidate) => candidate.value === value.preset)
  if (preset) return preset.label
  if (value.from === null || value.to === null) return 'Date range'
  return `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value.from)} – ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(value.to)}`
}

function sameDay(left: number | null, right: number): boolean {
  return left !== null && startOfDay(left) === startOfDay(right)
}

export function DateRangePicker({
  value,
  onChange,
  minDate,
  maxDate = Date.now(),
  ariaLabel = 'Filter runs by date range',
  compact = false,
  align = 'end'
}: DateRangePickerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const min = minDate === undefined ? null : startOfDay(minDate)
  const max = endOfDay(maxDate)
  const initialCursor = startOfDay(value.to ?? max)
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(startOfMonth(initialCursor))
  const [cursorDate, setCursorDate] = useState(initialCursor)
  const [draftFrom, setDraftFrom] = useState<number | null>(value.from)
  const [draftTo, setDraftTo] = useState<number | null>(value.to)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const calendarDays = useMemo(() => {
    const month = new Date(visibleMonth)
    const gridStart = addDays(visibleMonth, -month.getDay())
    return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
  }, [visibleMonth])

  const openPicker = (): void => {
    const nextCursor = startOfDay(value.to ?? max)
    setDraftFrom(value.from)
    setDraftTo(value.to)
    setCursorDate(nextCursor)
    setVisibleMonth(startOfMonth(nextCursor))
    setOpen((current) => !current)
  }

  const applyPreset = (preset: Exclude<DateRangePreset, 'custom'>): void => {
    onChange(presetValue(preset, max))
    setOpen(false)
    triggerRef.current?.focus()
  }

  const selectDay = (day: number): void => {
    if (draftFrom === null || draftTo !== null) {
      setDraftFrom(day)
      setDraftTo(null)
    } else if (day < draftFrom) {
      setDraftFrom(day)
      setDraftTo(draftFrom)
    } else {
      setDraftTo(day)
    }
    setCursorDate(day)
  }

  const focusDay = (day: number): void => {
    const bounded = Math.max(min ?? day, Math.min(startOfDay(max), day))
    setCursorDate(bounded)
    setVisibleMonth(startOfMonth(bounded))
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${bounded}"]`)
        ?.focus()
    })
  }

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, day: number): void => {
    const movement: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7
    }
    const amount = movement[event.key]
    if (amount !== undefined) {
      event.preventDefault()
      focusDay(addDays(day, amount))
      return
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      focusDay(addMonths(day, event.key === 'PageUp' ? -1 : 1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const weekday = new Date(day).getDay()
      focusDay(addDays(day, event.key === 'Home' ? -weekday : 6 - weekday))
    }
  }

  const monthDate = new Date(visibleMonth)
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric'
  }).format(monthDate)
  const previousMonth = addMonths(visibleMonth, -1)
  const nextMonth = addMonths(visibleMonth, 1)
  const previousDisabled = min !== null && addMonths(visibleMonth, 0) <= startOfMonth(min)
  const nextDisabled = nextMonth > startOfMonth(max)
  const rangeReady = draftFrom !== null && draftTo !== null

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${value.preset !== 'all' ? styles.triggerActive : ''}`}
        aria-label={`${ariaLabel}: ${triggerLabel(value)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={openPicker}
      >
        <Icon name="calendar" size={12} />
        <span>{triggerLabel(value)}</span>
        <Icon name="chevron-down" size={10} />
      </button>

      {open && (
        <div
          id={dialogId}
          className={[
            styles.popover,
            compact ? styles.popoverCompact : '',
            align === 'start' ? styles.popoverStart : ''
          ].filter(Boolean).join(' ')}
          role="dialog"
          aria-label="Run date range"
        >
          <div className={styles.presets} aria-label="Date range presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={value.preset === preset.value ? styles.presetActive : styles.preset}
                aria-pressed={value.preset === preset.value}
                onClick={() => applyPreset(preset.value)}
              >
                {preset.label}
                {value.preset === preset.value && <Icon name="check" size={11} />}
              </button>
            ))}
          </div>

          <div className={styles.calendar}>
            <div className={styles.calendarHeader}>
              <button
                type="button"
                aria-label="Previous month"
                disabled={previousDisabled}
                onClick={() => setVisibleMonth(previousMonth)}
              >
                <Icon name="chevron-left" size={11} />
              </button>
              <strong aria-live="polite">{monthLabel}</strong>
              <button
                type="button"
                aria-label="Next month"
                disabled={nextDisabled}
                onClick={() => setVisibleMonth(nextMonth)}
              >
                <Icon name="chevron-right" size={11} />
              </button>
            </div>

            <div className={styles.weekdays} aria-hidden>
              {DAY_LABELS.map((label) => <span key={label}>{label}</span>)}
            </div>
            <div className={styles.days} role="grid" aria-label={monthLabel}>
              {calendarDays.map((day) => {
                const date = new Date(day)
                const outsideMonth = date.getMonth() !== monthDate.getMonth()
                const disabled = (min !== null && day < min) || day > startOfDay(max)
                const endpoint = sameDay(draftFrom, day) || sameDay(draftTo, day)
                const inRange =
                  draftFrom !== null && draftTo !== null && day > draftFrom && day < draftTo
                const today = sameDay(startOfDay(Date.now()), day)
                const dayClasses = [
                  styles.day,
                  outsideMonth ? styles.dayOutside : '',
                  inRange ? styles.dayInRange : '',
                  endpoint ? styles.dayEndpoint : '',
                  today ? styles.dayToday : ''
                ].filter(Boolean).join(' ')
                return (
                  <button
                    key={day}
                    type="button"
                    role="gridcell"
                    data-date={day}
                    tabIndex={day === cursorDate ? 0 : -1}
                    className={dayClasses}
                    disabled={disabled}
                    aria-label={dateLabel(day)}
                    aria-selected={endpoint || inRange}
                    aria-current={today ? 'date' : undefined}
                    onClick={() => selectDay(day)}
                    onKeyDown={(event) => handleDayKeyDown(event, day)}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>
          </div>

          <div className={styles.rangeSummary} aria-live="polite">
            <span>{draftFrom === null ? 'Select start date' : dateLabel(draftFrom)}</span>
            <span aria-hidden>→</span>
            <span>{draftTo === null ? 'Select end date' : dateLabel(draftTo)}</span>
          </div>
          <div className={styles.footer}>
            <Button variant="ghost" size={26} muted onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size={26}
              disabled={!rangeReady}
              onClick={() => {
                if (draftFrom === null || draftTo === null) return
                onChange({ preset: 'custom', from: startOfDay(draftFrom), to: endOfDay(draftTo) })
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              Apply range
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

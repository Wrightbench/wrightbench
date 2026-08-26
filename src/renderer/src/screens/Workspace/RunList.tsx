import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react'
import type { TestRunSummary } from '@shared/ipc'
import { formatDuration } from './ResultsList'
import { formatTimestamp, statusLabel, StatusMark } from './RunsShared'
import { useNow } from './useNow'
import styles from './RunList.module.css'

/** the in-flight focused run, shown as the newest row while it streams */
export interface LiveRunRow {
  runId: number
  /** authoritative persisted number; 0 while the main process hasn't assigned it */
  runNumber: number
  startedAt: number
}

function revealRunButton(button: HTMLButtonElement, behavior: ScrollBehavior = 'auto'): void {
  const item = button.closest<HTMLElement>('[role="listitem"]')
  const scroller = button.closest<HTMLElement>('[role="list"]')?.parentElement
  if (!item || !scroller) return
  const itemRect = item.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  const delta =
    itemRect.left < scrollerRect.left
      ? itemRect.left - scrollerRect.left
      : itemRect.right > scrollerRect.right
        ? itemRect.right - scrollerRect.right
        : 0
  if (delta !== 0) scroller.scrollBy({ left: delta, behavior })
}

/**
 * One compact line per run: outcome dot, number, timestamp, duration. The
 * failure story (projects, retries, error) lives in the detail pane below —
 * the card only signals the outcome.
 */
function RunListRow({
  run,
  selected,
  onSelect
}: {
  run: TestRunSummary
  selected: boolean
  onSelect(): void
}): JSX.Element {
  const runName = run.runNumber > 0 ? `Run #${run.runNumber}` : 'Run'
  return (
    <div className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
      <button
        type="button"
        data-run-row
        data-run-id={run.runId}
        className={styles.rowMain}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${runName}: ${statusLabel(run.status)}, ${formatTimestamp(run.finishedAt ?? run.startedAt)}, ${formatDuration(run.durationMs)}. Show overview`}
        onClick={onSelect}
      >
        <span className={styles.rowMark}>
          <StatusMark status={run.status} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTop}>
            <strong className={styles.rowName}>{runName}</strong>
            <span className={styles.rowWhen}>
              <span className={styles.rowTime}>
                {formatTimestamp(run.finishedAt ?? run.startedAt)}
              </span>
              <code className={styles.rowDuration}>{formatDuration(run.durationMs)}</code>
            </span>
          </span>
        </span>
      </button>
    </div>
  )
}

function LiveRow({
  live,
  selected,
  onSelect
}: {
  live: LiveRunRow
  selected: boolean
  onSelect(): void
}): JSX.Element {
  const now = useNow(true)
  const runName = live.runNumber > 0 ? `Run #${live.runNumber}` : 'Run'
  return (
    <div className={`${styles.row} ${styles.rowLive} ${selected ? styles.rowSelected : ''}`}>
      <button
        type="button"
        data-run-row
        data-run-id={live.runId}
        className={styles.rowMain}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${runName}: running. Show live overview`}
        onClick={onSelect}
      >
        <span className={styles.rowMark}>
          <StatusMark status="running" />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTop}>
            <strong className={styles.rowName}>{runName}</strong>
            <span className={styles.rowWhen}>
              <span className={styles.rowTime}>Running now</span>
              <code className={styles.rowDuration}>
                {formatDuration(Math.max(0, now - live.startedAt))}
              </code>
            </span>
          </span>
        </span>
      </button>
    </div>
  )
}

/**
 * Horizontal master rail of the Runs view: every recorded execution of the
 * selected test, newest first. Selecting a row surfaces its evidence in the
 * detail pane's tabs below. Arrow keys walk the rows.
 */
export function RunList({
  rows,
  live,
  selectedRunId,
  onSelectRun
}: {
  rows: TestRunSummary[]
  live: LiveRunRow | null
  selectedRunId: number | null
  onSelectRun(runId: number): void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const revealSelected = (): void => {
      const selected = [...list.querySelectorAll<HTMLButtonElement>('[data-run-row]')].find(
        (button) => button.dataset.runId === String(selectedRunId)
      )
      if (selected) revealRunButton(selected)
    }
    revealSelected()
    const resizeObserver = new ResizeObserver(revealSelected)
    resizeObserver.observe(list.parentElement ?? list)
    return () => resizeObserver.disconnect()
  }, [selectedRunId])

  // Left/Right follow the horizontal rail. Up/Down remain supported for
  // continuity with the former vertical list.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const previous = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const edge = event.key === 'Home' || event.key === 'End'
    if (!previous && !next && !edge) return
    const target = event.target as HTMLElement
    if (!target.hasAttribute('data-run-row')) return
    const rowButtons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-run-row]') ?? [])
    ]
    const index = rowButtons.indexOf(target as HTMLButtonElement)
    if (index === -1) return
    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rowButtons.length - 1
          : previous
            ? index - 1
            : index + 1
    const nextButton = rowButtons[Math.max(0, Math.min(rowButtons.length - 1, nextIndex))]
    nextButton?.focus({ preventScroll: true })
    if (nextButton) revealRunButton(nextButton, 'smooth')
  }

  return (
    <div
      ref={listRef}
      className={styles.list}
      role="list"
      aria-label="Recorded runs"
      onKeyDown={onKeyDown}
    >
      {live && (
        <div role="listitem">
          <LiveRow
            live={live}
            selected={selectedRunId === live.runId}
            onSelect={() => onSelectRun(live.runId)}
          />
        </div>
      )}
      {rows.map((run) => (
        <div key={run.runId} role="listitem">
          <RunListRow
            run={run}
            selected={selectedRunId === run.runId}
            onSelect={() => onSelectRun(run.runId)}
          />
        </div>
      ))}
    </div>
  )
}

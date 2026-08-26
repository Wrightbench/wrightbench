import { useEffect, type JSX } from 'react'
import { Chip } from '@/components/Chip/Chip'
import { Icon } from '@/components/Icon/Icon'
import { StatusBar, StatusBarItem } from '@/components/StatusBar/StatusBar'
import { StatusDot } from '@/components/StatusDot/StatusDot'
import { WebviewFrame } from '@/components/WebviewFrame/WebviewFrame'
import { useSettings } from '@/state/settings'
import { useTraces } from '@/state/traces'
import type { ProjectInfo, TraceLibEntry } from '@shared/ipc'
import styles from './TracesView.module.css'

function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes === 0) return '0 KB'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatWhenClock(timestamp: number): string {
  const date = new Date(timestamp)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return `today ${hhmm}`
  return `${date.getDate()} ${date.toLocaleDateString(undefined, { month: 'short' })} ${hhmm}`
}

/** artboard 12's theme-matched trace-viewer wireframe */
function ViewerPlaceholder({ note }: { note: string | null }): JSX.Element {
  return (
    <>
      <div className={styles.mockStrip}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} className={i === 2 ? `${styles.mockFrame} ${styles.mockFrameActive}` : styles.mockFrame} />
        ))}
      </div>
      <div className={styles.mockBody}>
        <div className={styles.mockActions}>
          {[
            { width: '72%', active: false },
            { width: '86%', active: false },
            { width: '64%', active: true },
            { width: '80%', active: false },
            { width: '70%', active: false },
            { width: '76%', active: false }
          ].map((bar, i) => (
            <span
              key={i}
              className={bar.active ? `${styles.mockBar} ${styles.mockBarActive}` : styles.mockBar}
              style={{ width: bar.width }}
            />
          ))}
        </div>
        <div className={styles.mockSnapshotPane}>
          <div className={styles.mockSnapshotCard}>
            <span className={styles.mockSnapTitle} />
            <span className={styles.mockSnapField} />
            <div className={styles.mockSnapRow}>
              <span className={styles.mockSnapBox} />
              <span className={styles.mockSnapBox} />
            </div>
            <span className={styles.mockSnapLine} />
            {note !== null && <div className={styles.mockNote}>{note}</div>}
          </div>
          <div className={styles.mockTabs}>
            <span className={`${styles.mockTab} ${styles.mockTabActive}`} />
            <span className={styles.mockTab} />
            <span className={styles.mockTab} />
            <span className={styles.mockTab} />
          </div>
        </div>
      </div>
    </>
  )
}

function TraceCard({
  entry,
  selected,
  onSelect
}: {
  entry: TraceLibEntry
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const missing = entry.sizeBytes === null
  return (
    <button
      type="button"
      className={selected ? `${styles.card} ${styles.cardSelected}` : styles.card}
      onClick={onSelect}
      disabled={missing}
      title={missing ? 'trace file no longer on disk' : undefined}
    >
      <span className={styles.cardHead}>
        <span className={styles.cardRun}>#{entry.runNumber}</span>
        <Chip tone={entry.status === 'flaky' ? 'flaky' : 'fail'} variant="sm">
          {entry.status === 'flaky' ? 'FLAKY' : 'FAILED'}
        </Chip>
      </span>
      <span className={selected ? `${styles.cardName} ${styles.cardNameSelected}` : styles.cardName}>
        {entry.title}
      </span>
      <span className={styles.cardMeta}>
        <span className={styles.cardSpec}>{entry.file}</span>
        <span className={styles.cardSize}>{formatSize(entry.sizeBytes)}</span>
      </span>
    </button>
  )
}

export function TracesView({ project }: { project: ProjectInfo }): JSX.Element {
  const entries = useTraces((s) => s.entries)
  const externals = useTraces((s) => s.externals)
  const filter = useTraces((s) => s.filter)
  const selectedPath = useTraces((s) => s.selectedPath)
  const viewerUrl = useTraces((s) => s.viewerUrl)
  const viewerError = useTraces((s) => s.viewerError)
  const load = useTraces((s) => s.load)
  const settings = useSettings((s) => s.settings)
  const loadSettings = useSettings((s) => s.load)

  useEffect(() => {
    void load(project.path)
  }, [project.path, load])

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

  const needle = filter.trim().toLowerCase()
  const visible =
    needle === ''
      ? entries
      : entries.filter(
          (e) =>
            e.title.toLowerCase().includes(needle) ||
            e.file.toLowerCase().includes(needle) ||
            `#${e.runNumber}`.includes(needle)
        )
  const totalBytes = entries.reduce((n, e) => n + (e.sizeBytes ?? 0), 0)
  const selected = entries.find((e) => e.path === selectedPath) ?? null
  const port = viewerUrl !== null ? new URL(viewerUrl).port : null

  const openExternal = async (): Promise<void> => {
    const wb = window.wrightbench
    if (!wb) return
    const picked = await wb.traces.pickFile()
    if (picked) void useTraces.getState().addExternal(project.path, picked)
  }

  const statusMiddle = selected
    ? `Viewing trace from run #${selected.runNumber} · recorded ${formatWhenClock(selected.startedAt)}`
    : selectedPath !== null
      ? `Viewing ${selectedPath.split(/[\\/]/).pop()}`
      : 'Select a trace to open it in the viewer'
  const monoParts = [
    port !== null ? `trace server :${port}` : null,
    project.playwrightVersion ? `Playwright v${project.playwrightVersion}` : null
  ].filter(Boolean)

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <div className={styles.library}>
          <div className={styles.libToolbar}>
            <div className={styles.filterField}>
              <Icon name="search" size={12} />
              <input
                className={styles.filterInput}
                value={filter}
                placeholder="Filter traces"
                spellCheck={false}
                onChange={(e) => useTraces.getState().setFilter(e.target.value)}
                aria-label="Filter traces"
              />
            </div>
            <button type="button" className={styles.openBtn} onClick={() => void openExternal()}>
              <Icon name="folder" size={12} />
              Open…
            </button>
          </div>
          <div className={styles.cardList}>
            {externals.map((ext) => (
              <button
                key={ext.path}
                type="button"
                className={
                  selectedPath === ext.path ? `${styles.card} ${styles.cardSelected}` : styles.card
                }
                onClick={() => void useTraces.getState().select(ext.path)}
              >
                <span className={styles.cardHead}>
                  <span className={styles.cardRun}>opened</span>
                  <Chip tone="accent" variant="sm">
                    FILE
                  </Chip>
                </span>
                <span
                  className={
                    selectedPath === ext.path
                      ? `${styles.cardName} ${styles.cardNameSelected}`
                      : styles.cardName
                  }
                >
                  {ext.fileName}
                </span>
                <span className={styles.cardMeta}>
                  <span className={styles.cardSpec}>{ext.path}</span>
                </span>
              </button>
            ))}
            {visible.map((entry) => (
              <TraceCard
                key={`${entry.runId}:${entry.path}`}
                entry={entry}
                selected={selectedPath === entry.path}
                onSelect={() => void useTraces.getState().select(entry.path)}
              />
            ))}
            {visible.length === 0 && externals.length === 0 && (
              <div className={styles.emptyNote}>
                {entries.length === 0
                  ? 'No traces recorded yet — failing tests keep their traces automatically.'
                  : 'No traces match the filter.'}
              </div>
            )}
            <div className={styles.dropZone}>
              <Icon name="upload" size={13} />
              …or drop a trace.zip here
            </div>
          </div>
          <div className={styles.libFooter}>
            Traces kept {settings?.traceRetentionDays ?? 14} days · {formatSize(totalBytes)} used
          </div>
        </div>

        <div className={styles.viewerArea}>
          <WebviewFrame
            label="embedded Trace Viewer"
            headerLeft={
              <div className={styles.viewerSkeletons} aria-hidden>
                <span style={{ width: 56 }} />
                <span style={{ width: 44 }} />
                <span style={{ width: 60 }} />
              </div>
            }
          >
            {viewerUrl !== null ? (
              <webview className={styles.webview} src={viewerUrl} />
            ) : (
              <ViewerPlaceholder note={viewerError} />
            )}
          </WebviewFrame>
        </div>
      </div>

      <StatusBar mono={monoParts.join(' · ')}>
        <StatusBarItem>
          <StatusDot status="pass" />
          Idle
        </StatusBarItem>
        <span>{statusMiddle}</span>
      </StatusBar>
    </div>
  )
}

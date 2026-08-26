import { useEffect, useState, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { Chip } from '@/components/Chip/Chip'
import { Icon } from '@/components/Icon/Icon'
import { StatusBar, StatusBarItem } from '@/components/StatusBar/StatusBar'
import { StatusDot } from '@/components/StatusDot/StatusDot'
import { useRun } from '@/state/run'
import type { ProjectInfo, ReportInfo, RunRecord } from '@shared/ipc'
import styles from './ReportsView.module.css'

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `today ${hhmm}`
  const yesterday = new Date(Date.now() - 24 * 3600_000)
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${hhmm}`
  return `${date.getDate()} ${date.toLocaleDateString(undefined, { month: 'short' })} ${hhmm}`
}

/** wireframe interior shown while no report exists (artboard 11 skeleton) */
function ReportPlaceholder({ note }: { note: string | null }): JSX.Element {
  const rows: { status: string; width: string }[] = [
    { status: 'var(--wv-pass)', width: '38%' },
    { status: 'var(--wv-fail)', width: '46%' },
    { status: 'var(--wv-pass)', width: '33%' },
    { status: 'var(--wv-pass)', width: '41%' },
    { status: 'var(--wv-flaky)', width: '36%' },
    { status: 'var(--wv-pass)', width: '44%' }
  ]
  return (
    <div className={styles.mockBody}>
      <div className={styles.mockSummary}>
        <span className={styles.mockStat} />
        <span className={styles.mockStat} />
        <span className={styles.mockStat} />
        <span className={styles.mockSpacer} />
        <span className={styles.mockSearch} />
      </div>
      {rows.map((row, i) => (
        <div key={i} className={styles.mockRow}>
          <span className={styles.mockStatus} style={{ background: row.status }} />
          <span className={styles.mockName} style={{ width: row.width }} />
          <span className={styles.mockDuration} />
        </div>
      ))}
      {note !== null && <div className={styles.emptyNote}>{note}</div>}
    </div>
  )
}

export function ReportsView({ project }: { project: ProjectInfo }): JSX.Element {
  const lastRun = useRun((s) => s.lastRun)
  const [latest, setLatest] = useState<RunRecord | null>(null)
  const [info, setInfo] = useState<ReportInfo | null>(null)
  const [port, setPort] = useState<number | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    const wb = window.wrightbench
    if (!wb) return undefined
    setPort(null)
    setServerError(null)
    setExportNote(null)
    void wb.history
      .runs(project.path, { from: null, to: null }, 1)
      .then((runs) => {
        if (!stale) setLatest(runs[0] ?? null)
      })
      .catch(() => {})
    void wb.report
      .info(project.path)
      .then(async (reportInfo) => {
        if (stale) return
        setInfo(reportInfo)
        if (reportInfo.exists) {
          try {
            const { port: served } = await wb.report.start(project.path)
            if (!stale) setPort(served)
          } catch (err) {
            if (!stale) setServerError(err instanceof Error ? err.message : String(err))
          }
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
    // lastRun retriggers so a fresh run picks up its new report
  }, [project.path, lastRun])

  const chips: JSX.Element[] = []
  if (latest) {
    if (latest.passed > 0) chips.push(<Chip key="p" tone="pass">{latest.passed} pass</Chip>)
    if (latest.failed > 0) chips.push(<Chip key="f" tone="fail">{latest.failed} fail</Chip>)
    if (latest.flaky > 0) chips.push(<Chip key="k" tone="flaky">{latest.flaky} flaky</Chip>)
  }

  const exportReport = async (): Promise<void> => {
    const result = await window.wrightbench?.report.export(project.path)
    if (!result) return
    if (result.ok) setExportNote('report exported')
    else if (result.error !== 'cancelled') setExportNote(result.error ?? 'export failed')
  }

  const statusMiddle = info?.exists
    ? `Report generated after run #${latest?.runNumber ?? '…'} · ${formatClock(info.generatedAt ?? Date.now())}`
    : 'No report yet — run the suite to generate one'
  const monoParts = [
    port !== null ? `report server :${port}` : null,
    project.playwrightVersion ? `Playwright v${project.playwrightVersion}` : null
  ].filter(Boolean)

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.runPill}>
          <span className={styles.runNumber}>#{latest?.runNumber ?? '—'}</span>
          <span className={styles.runWhen}>
            · {latest ? formatClock(latest.startedAt) : 'no runs yet'}
          </span>
          <Icon name="chevron-down" size={11} color="var(--t3)" />
        </span>
        {chips.length > 0 && <span className={styles.chips}>{chips}</span>}
        <div className={styles.toolbarActions}>
          <Button
            variant="ghost"
            size={30}
            disabled={!info?.exists}
            onClick={() => void window.wrightbench?.report.openBrowser(project.path)}
          >
            <Icon name="external-link" size={12} />
            Open in browser
          </Button>
          <Button variant="ghost" size={30} disabled={!info?.exists} onClick={() => void exportReport()}>
            <Icon name="download" size={12} />
            Export report…
          </Button>
        </div>
      </div>

      <div className={styles.webviewArea}>
        <div className={styles.frame}>
          <div className={styles.chrome}>
            <div className={styles.chromeSkeletons} aria-hidden>
              <span className={styles.chromeTitle} />
              <span className={styles.chromeChip} />
              <span className={styles.chromeChip} />
              <span className={styles.chromeChip} />
            </div>
            <span className={styles.chromeLabel}>embedded HTML report</span>
          </div>
          {port !== null ? (
            // key on generatedAt: a fresh run rewrites the report in place,
            // and the webview must reload to show it
            <webview
              key={info?.generatedAt ?? 0}
              className={styles.webview}
              src={`http://127.0.0.1:${port}/`}
            />
          ) : (
            <ReportPlaceholder
              note={
                serverError ??
                (info && !info.exists ? 'Run the suite from the Tests tab to generate a report.' : null)
              }
            />
          )}
        </div>
      </div>

      <StatusBar mono={monoParts.join(' · ')}>
        <StatusBarItem>
          <StatusDot status="pass" />
          Idle
        </StatusBarItem>
        <span>{statusMiddle}</span>
        {exportNote !== null && <span>{exportNote}</span>}
      </StatusBar>
    </div>
  )
}

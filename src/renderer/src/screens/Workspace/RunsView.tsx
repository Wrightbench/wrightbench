import { useEffect, type JSX } from 'react'
import { useNow } from './useNow'
import { Chip } from '@/components/Chip/Chip'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { useHistory } from '@/state/history'
import { useRun } from '@/state/run'
import { useUiMode } from '@/state/uimode'
import type { HistoryAnalytics, RunRecord } from '@shared/ipc'
import styles from './RunsView.module.css'

export function formatRunDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** day-first like the reference ("22 May"), regardless of OS locale */
export function formatDayMonth(date: Date): string {
  return `${date.getDate()} ${date.toLocaleDateString(undefined, { month: 'short' })}`
}

function formatWhen(timestamp: number): string {
  const now = Date.now()
  if (now - timestamp < 75_000) return 'just now'
  const date = new Date(timestamp)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `today ${hhmm}`
  const yesterday = new Date(now - 24 * 3600_000)
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${hhmm}`
  if (now - timestamp < 6 * 24 * 3600_000) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`
  }
  return formatDayMonth(date)
}

function StatTiles({ analytics }: { analytics: HistoryAnalytics }): JSX.Element {
  const passDelta =
    analytics.passRatePct !== null && analytics.passRatePriorPct !== null
      ? analytics.passRatePct - analytics.passRatePriorPct
      : null
  const durDelta =
    analytics.avgDurationMs !== null && analytics.avgDurationPriorMs !== null
      ? analytics.avgDurationMs - analytics.avgDurationPriorMs
      : null

  return (
    <div className={styles.tiles}>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Pass rate · {analytics.rangeRuns} runs</div>
        <div className={styles.tileValue}>
          {analytics.passRatePct !== null ? `${analytics.passRatePct.toFixed(1)}%` : '—'}
        </div>
        <div
          className={`${styles.tileNote} ${
            passDelta === null
              ? styles.noteMuted
              : passDelta >= 0
                ? styles.notePass
                : styles.noteFail
          }`}
        >
          {passDelta === null
            ? 'no prior window yet'
            : `${passDelta >= 0 ? '▲' : '▼'} ${Math.abs(passDelta).toFixed(1)} pts vs prior period`}
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Avg duration</div>
        <div className={styles.tileValue}>
          {analytics.avgDurationMs !== null ? formatRunDuration(analytics.avgDurationMs) : '—'}
        </div>
        <div
          className={`${styles.tileNote} ${
            durDelta === null
              ? styles.noteMuted
              : durDelta <= 0
                ? styles.notePass
                : styles.noteFail
          }`}
        >
          {durDelta === null
            ? 'no prior window yet'
            : `${durDelta <= 0 ? '▼' : '▲'} ${Math.round(Math.abs(durDelta) / 1000)}s vs prior period`}
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Flaky tests</div>
        <div className={styles.tileValue}>{analytics.flakyCount}</div>
        <div
          className={`${styles.tileNote} ${analytics.flakyCount > 0 ? styles.noteFlaky : styles.noteMuted}`}
        >
          {analytics.flakyCount > 0
            ? 'failed, then passed on retry'
            : 'no Playwright-flaky outcomes'}
        </div>
      </div>
    </div>
  )
}

/** y-mapping matches the artboard: 100% → y10, 85% → y110, clamped */
function rateToY(rate: number): number {
  const y = 10 + (100 - rate) * (100 / 15)
  return Math.min(105, Math.max(10, y))
}

function PassRateChart({ analytics }: { analytics: HistoryAnalytics }): JSX.Element {
  const series = analytics.series
  const n = series.length
  const xFor = (i: number): number => (n <= 1 ? 590 : 10 + (580 / (n - 1)) * i)
  // all-skipped runs have rate null — the polyline gaps them
  const points = series.flatMap((p, i) =>
    p.rate === null ? [] : [`${xFor(i).toFixed(1)},${rateToY(p.rate).toFixed(1)}`]
  )

  let dipIndex = -1
  for (let i = 0; i < n; i++) {
    const rate = series[i].rate
    if (rate === null) continue
    if (dipIndex === -1 || rate < (series[dipIndex].rate ?? 101)) dipIndex = i
  }
  const dip = dipIndex >= 0 ? series[dipIndex] : null
  const first = series[0]
  const last = series[n - 1]

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartTitleRow}>
        <span className={styles.chartTitle}>
          Pass rate — {analytics.rangeRuns > n ? `latest ${n} runs in range` : `${n} runs`}
        </span>
        {first && last && (
          <span className={styles.chartRange}>
            run #{first.runNumber} → #{last.runNumber}
          </span>
        )}
      </div>
      <svg
        className={styles.chartSvg}
        height="110"
        viewBox="0 0 600 110"
        preserveAspectRatio="none"
      >
        <line x1="10" y1="10" x2="590" y2="10" stroke="var(--bd)" strokeWidth="1" />
        <line x1="10" y1="43" x2="590" y2="43" stroke="var(--bd)" strokeWidth="1" />
        <line x1="10" y1="76" x2="590" y2="76" stroke="var(--bd)" strokeWidth="1" />
        {n > 1 && (
          <polyline
            points={points.join(' ')}
            fill="none"
            stroke="var(--pass)"
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {series.map((p, i) => {
          if (p.rate === null) return null
          if (p.failed > 0) {
            return (
              <circle
                key={i}
                cx={xFor(i)}
                cy={rateToY(p.rate)}
                r="3.5"
                fill="var(--fail)"
              />
            )
          }
          if (p.flaky > 0) {
            return (
              <circle key={i} cx={xFor(i)} cy={rateToY(p.rate)} r="3" fill="var(--flaky)" />
            )
          }
          return null
        })}
        {last && last.rate !== null && (
          <circle cx={xFor(n - 1)} cy={rateToY(last.rate)} r="3.5" fill="var(--pass)" />
        )}
      </svg>
      <div className={styles.chartCaption}>
        <span>100%</span>
        <span>
          {dip && dip.rate !== null && dip.rate < 99.5
            ? `#${dip.runNumber} dipped to ${dip.rate.toFixed(0)}%`
            : ''}
        </span>
        <span>85%</span>
      </div>
    </div>
  )
}

function ResultChips({ run }: { run: RunRecord }): JSX.Element {
  const chips: JSX.Element[] = []
  if (run.passed > 0) {
    chips.push(
      <Chip key="p" tone="pass">
        {run.passed} pass
      </Chip>
    )
  }
  if (run.failed > 0) {
    chips.push(
      <Chip key="f" tone="fail">
        {run.failed} fail
      </Chip>
    )
  }
  if (run.flaky > 0) {
    chips.push(
      <Chip key="k" tone="flaky">
        {run.flaky} flaky
      </Chip>
    )
  }
  if (chips.length === 0) {
    return <span className={styles.duration}>{run.status === 'interrupted' ? 'stopped' : '—'}</span>
  }
  return <span className={styles.chips}>{chips}</span>
}

function RunningRow({ from, to }: { from: number | null; to: number | null }): JSX.Element | null {
  const running = useRun((s) => s.running)
  const runNumber = useRun((s) => s.runNumber)
  const testCount = useRun((s) => Object.keys(s.decls).length)
  const instanceDone = useRun((s) => s.instanceDone)
  const instanceTotal = useRun((s) => s.instanceTotal)
  const startedAt = useRun((s) => s.startedAt)
  const now = useNow(running)
  if (!running) return null
  if (
    startedAt !== null &&
    ((from !== null && startedAt < from) || (to !== null && startedAt > to))
  ) {
    return null
  }

  const elapsed = startedAt ? now - startedAt : 0
  const seconds = Math.floor(elapsed / 1000)
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}…`

  return (
    <div className={styles.tableRow}>
      <span className={styles.runNumber}>{runNumber > 0 ? `#${runNumber}` : '#…'}</span>
      <span className={styles.tests}>{testCount > 0 ? testCount : '—'}</span>
      <span className={styles.runningCell}>
        <Spinner size={11} />
        running · {instanceDone}/{instanceTotal}
      </span>
      <span className={`${styles.duration} ${styles.durationRunning}`}>{clock}</span>
      <span className={styles.when}>just now</span>
    </div>
  )
}

function RunsTable({
  runs,
  selectedRunId,
  onSelectRun,
  dateRange,
  loading
}: {
  runs: RunRecord[]
  selectedRunId: number | null
  onSelectRun?: (runId: number) => void
  dateRange: { preset: string; from: number | null; to: number | null }
  loading: boolean
}): JSX.Element {
  return (
    <div className={styles.tableCard}>
      <div className={styles.tableHeader}>
        <span>RUN</span>
        <span>TESTS</span>
        <span>RESULT</span>
        <span>DURATION</span>
        <span>WHEN</span>
      </div>
      <div className={styles.tableBody}>
        <RunningRow from={dateRange.from} to={dateRange.to} />
        {runs.map((run) => {
          const cells = (
            <>
              <span className={styles.runNumber}>#{run.runNumber}</span>
              <span className={styles.tests}>{run.total}</span>
              <ResultChips run={run} />
              <span className={styles.duration}>
                {run.durationMs !== null ? formatRunDuration(run.durationMs) : '—'}
              </span>
              <span className={styles.when}>{formatWhen(run.startedAt)}</span>
            </>
          )
          return onSelectRun ? (
            <button
              key={run.id}
              type="button"
              className={`${styles.tableRow} ${styles.tableRowInteractive} ${selectedRunId === run.id ? styles.tableRowSelected : ''}`}
              aria-label={`Open run #${run.runNumber}`}
              onClick={() => onSelectRun(run.id)}
            >
              {cells}
            </button>
          ) : (
            <div key={run.id} className={styles.tableRow}>
              {cells}
            </div>
          )
        })}
        {runs.length === 0 && (
          <div className={styles.emptyNote} role={loading ? 'status' : undefined}>
            {loading ? (
              <>
                <Spinner size={11} /> Loading reports…
              </>
            ) : dateRange.preset === 'all' ? (
              'No runs recorded yet.'
            ) : (
              'No runs in this date range.'
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function AttentionPanels({ analytics }: { analytics: HistoryAnalytics }): JSX.Element {
  return (
    <div className={styles.attentionGrid}>
      <section className={styles.attentionPanel}>
        <header className={styles.attentionHeader}>
          <div className={styles.attentionHeading}>Playwright flaky tests</div>
          <div className={styles.attentionDescription}>Failed first, then passed on retry</div>
        </header>
        <div className={styles.attentionList}>
          {analytics.flakiest.map((test) => (
            <div key={`${test.file}:${test.line}:${test.title}`} className={styles.attentionRow}>
              <div className={styles.attentionIdentity}>
                <div className={styles.attentionTestName}>{test.title}</div>
                <div className={styles.attentionMeta}>
                  <span className={styles.attentionSpec}>{test.file}</span>
                  <span
                    className={styles.outcomeDots}
                    aria-label={`${test.flakyRuns} Playwright-flaky of ${test.outcomes.length} executions`}
                  >
                    {test.outcomes.map((outcome, i) => (
                      <span
                        key={i}
                        className={`${styles.outcomeDot} ${
                          outcome === 'pass'
                            ? styles.outcomePass
                            : outcome === 'flaky'
                              ? styles.outcomeFlaky
                              : styles.outcomeFail
                        }`}
                      />
                    ))}
                  </span>
                </div>
              </div>
              <div className={styles.flakyMetric}>
                <strong>{test.flakyPct}%</strong>
                <span>
                  {test.flakyRuns}/{test.outcomes.length} flaky
                </span>
              </div>
            </div>
          ))}
          {analytics.flakiest.length === 0 && (
            <div className={styles.attentionEmpty}>No Playwright-flaky tests detected.</div>
          )}
        </div>
      </section>
      <section className={styles.attentionPanel}>
        <header className={styles.attentionHeader}>
          <div className={styles.attentionHeading}>Duration regressions</div>
          <div className={styles.attentionDescription}>Median of the latest 5 vs prior runs</div>
        </header>
        <div className={styles.attentionList}>
          {analytics.regressions.map((regression) => (
            <div
              key={`${regression.file}:${regression.line}:${regression.title}`}
              className={styles.attentionRow}
            >
              <div className={styles.attentionIdentity}>
                <div className={styles.attentionTestName}>{regression.title}</div>
                <div className={styles.attentionSpec}>{regression.file}</div>
              </div>
              <div className={styles.regressionMetric}>
                {(regression.beforeMs / 1000).toFixed(1)}s →{' '}
                {(regression.afterMs / 1000).toFixed(1)}s
              </div>
            </div>
          ))}
          {analytics.regressions.length === 0 && (
            <div className={styles.attentionEmpty}>No regressions detected.</div>
          )}
        </div>
      </section>
    </div>
  )
}

export function RunsView({
  path,
  selectedRunId = null,
  onSelectRun
}: {
  path: string
  selectedRunId?: number | null
  onSelectRun?: (runId: number) => void
}): JSX.Element {
  const runs = useHistory((s) => s.runs)
  const analytics = useHistory((s) => s.analytics)
  const error = useHistory((s) => s.error)
  const projectPath = useHistory((s) => s.projectPath)
  const loading = useHistory((s) => s.loading)
  const refresh = useHistory((s) => s.refresh)
  const lastRun = useRun((s) => s.lastRun)
  const uiLastSavedAt = useUiMode((s) => s.lastSaved?.at ?? null)
  const dateRange = useHistory((s) => s.dateRange)
  const projectLoaded = projectPath === path

  useEffect(() => {
    void refresh(path)
  }, [
    path,
    refresh,
    lastRun,
    uiLastSavedAt,
    dateRange.preset,
    dateRange.from,
    dateRange.to
  ])

  return (
    <div className={styles.body}>
      <div className={styles.content}>
        {projectLoaded && error && <div className={styles.emptyNote}>{error}</div>}
        {projectLoaded && analytics && <StatTiles analytics={analytics} />}
        {projectLoaded && analytics && <AttentionPanels analytics={analytics} />}
        {projectLoaded && analytics && <PassRateChart analytics={analytics} />}
        <RunsTable
          runs={projectLoaded ? runs : []}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
          dateRange={dateRange}
          loading={!projectLoaded || loading}
        />
      </div>
    </div>
  )
}

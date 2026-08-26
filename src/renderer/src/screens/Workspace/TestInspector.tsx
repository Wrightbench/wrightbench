import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import {
  ALL_DATE_RANGE,
  DateRangePicker,
  type DateRangeValue
} from '@/components/DateRangePicker/DateRangePicker'
import { Icon } from '@/components/Icon/Icon'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { buildTestLocation, buildTestTitleGrep, specRootPath } from '@/lib/sidebar'
import { useCodegen } from '@/state/codegen'
import { legacyTestKey, testKey, useActiveTarget, useRun } from '@/state/run'
import { uiModeBlocksOtherWork, useUiMode } from '@/state/uimode'
import type {
  Last20Cell,
  PersistedAttempt,
  ProjectInfo,
  TestDecl,
  TestInspectorDetail,
  TestRunDetail
} from '@shared/ipc'
import { formatDuration } from './ResultsList'
import { RunDetail, type LiveRunDetail } from './RunDetail'
import { RunList, type LiveRunRow } from './RunList'
import {
  attemptStatus,
  EVIDENCE_KINDS,
  statusLabel,
  StatusMark,
  type EvidenceKind,
  type RunTab
} from './RunsShared'
import styles from './TestInspector.module.css'

/** stands in for the live run's history id until the main process assigns one */
const LIVE_RUN_FALLBACK_ID = -1

function HistoryCell({
  cell,
  selectionKey
}: {
  cell: Last20Cell
  selectionKey: string
}): JSX.Element {
  const openTrace = useRun((s) => s.openTrace)
  const failure = cell.status === 'fail' || cell.status === 'flaky'
  const classes = `${styles.historyCell} ${styles[`history_${cell.status}`]}`
  const label = `Run #${cell.runNumber}: ${statusLabel(cell.status)}`

  if (failure) {
    return (
      <button
        type="button"
        className={classes}
        title={`${label} — open trace`}
        aria-label={`${label}. Open trace`}
        onClick={() => openTrace(selectionKey, cell.runId)}
      />
    )
  }
  return <span className={classes} role="img" title={label} aria-label={label} />
}

function findSelectedTest(
  selectedKey: string | null,
  targetId: string | undefined,
  files: { tests: TestDecl[] }[] | undefined
): TestDecl | null {
  if (!selectedKey || !targetId || !files) return null
  for (const file of files) {
    const match = file.tests.find((test) => testKey(test, targetId) === selectedKey)
    if (match) return match
  }
  return null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle]
}

/** ` · 20 runs` window qualifier for a summary metric; empty when no sample */
function windowLabel(count: number): string {
  if (count === 0) return ''
  return ` · ${count} ${count === 1 ? 'run' : 'runs'}`
}

function playwrightFlakePct(outcomes: Last20Cell['status'][]): number | null {
  if (outcomes.length === 0) return null
  const flaky = outcomes.filter((outcome) => outcome === 'flaky').length
  return Math.round((flaky / outcomes.length) * 1000) / 10
}

/** default attempt for a freshly selected run: decisive failures first */
function pickDefaultAttempt(
  attempts: PersistedAttempt[],
  preferredProject: string | null
): PersistedAttempt {
  const byProject = new Map<string, PersistedAttempt[]>()
  for (const attempt of attempts) {
    const list = byProject.get(attempt.project) ?? []
    list.push(attempt)
    byProject.set(attempt.project, list)
  }
  const finals = [...byProject.values()].map((list) => list[list.length - 1])
  const failedFinal = finals.find((attempt) => attemptStatus(attempt.status) === 'fail')
  if (failedFinal) return failedFinal
  const flakyFinal = finals.find(
    (attempt) =>
      attemptStatus(attempt.status) === 'pass' &&
      (byProject.get(attempt.project) ?? []).some(
        (earlier) => attemptStatus(earlier.status) === 'fail'
      )
  )
  if (flakyFinal) return flakyFinal
  if (preferredProject !== null) {
    const preferredFinal = finals.find((attempt) => attempt.project === preferredProject)
    if (preferredFinal) return preferredFinal
  }
  return attempts[0]
}

export function TestInspector({
  project
}: {
  project: ProjectInfo
}): JSX.Element | null {
  const tree = useRun((s) => s.tree)
  const selectedKey = useRun((s) => s.selectedKey)
  const traceIntent = useRun((s) => s.traceIntent)
  const consumeTraceIntent = useRun((s) => s.consumeTraceIntent)
  const startRun = useRun((s) => s.startRun)
  const stopRun = useRun((s) => s.stopRun)
  const activeTarget = useActiveTarget()
  const running = useRun((s) => s.running)
  const lastRunNumber = useRun((s) => s.lastRun?.number ?? null)
  const lastHistoryRunId = useRun((s) => s.lastRun?.historyRunId ?? null)
  const decls = useRun((s) => s.decls)
  const attempts = useRun((s) => s.attempts)
  const historyRunId = useRun((s) => s.historyRunId)
  const runNumber = useRun((s) => s.runNumber)
  const runTrigger = useRun((s) => s.runTrigger)
  const runCommit = useRun((s) => s.runCommit)
  const runStartedAt = useRun((s) => s.startedAt)
  const statuses = useRun((s) => s.statuses)
  const uiStatus = useUiMode((s) => s.status)
  const uiRun = useUiMode((s) => s.run)
  const uiRecording = useUiMode((s) => s.recording)
  const recording = useCodegen((s) => s.recording)

  const selected = useMemo(
    () => findSelectedTest(selectedKey, tree?.targetId, tree?.files),
    [selectedKey, tree?.targetId, tree?.files]
  )
  const [detail, setDetail] = useState<TestInspectorDetail | null>(null)
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runTab, setRunTab] = useState<RunTab>('overview')
  const [pendingEvidence, setPendingEvidence] = useState<EvidenceKind | null>(null)
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(null)
  const [runDetail, setRunDetail] = useState<TestRunDetail | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [dateRange, setDateRange] = useState<DateRangeValue>(ALL_DATE_RANGE)
  /** the project the user last chose in the selector — kept for this session */
  const preferredProjectRef = useRef<string | null>(null)
  /** newest recorded run id seen for the current test — detects fresh runs */
  const newestRunIdRef = useRef<number | null>(null)

  // switching tests resets the run selection and the date range
  useEffect(() => {
    newestRunIdRef.current = null
    setDetail(null)
    setDetailKey(null)
    setSelectedRunId(null)
    setRunDetail(null)
    setRunTab('overview')
    setPendingEvidence(null)
    setSelectedAttemptId(null)
    setDateRange(ALL_DATE_RANGE)
  }, [selectedKey])

  useEffect(() => {
    if (!selected) return
    const wb = window.wrightbench
    if (!wb) {
      setDetail(null)
      setDetailKey(null)
      setLoading(false)
      return
    }
    let disposed = false
    setLoading(true)
    setLoadError(null)
    void wb.history
      .testInspector(project.path, {
        file: selected.file,
        line: selected.line,
        title: selected.title
      })
      .then((next) => {
        if (!disposed) {
          setDetail(next)
          setDetailKey(selectedKey)
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [
    project.path,
    selectedKey,
    selected?.file,
    selected?.line,
    selected?.title,
    lastRunNumber
  ])

  const key = selected && tree ? testKey(selected, tree.targetId) : null
  const decl = key ? decls[key] : undefined
  const final = key ? statuses[key] : undefined

  /** the in-flight run counts for this test only while it schedules this test */
  const liveRunId = running && decl ? (historyRunId ?? LIVE_RUN_FALLBACK_ID) : null

  // a new focused/watch run immediately becomes the selected run, on Overview
  useEffect(() => {
    if (liveRunId === null) return
    setSelectedRunId(liveRunId)
    setRunTab('overview')
    setPendingEvidence(null)
    setSelectedAttemptId(null)
  }, [liveRunId])

  // the selected run's exact evidence loads on demand (never while it is live)
  useEffect(() => {
    if (!selected || selectedRunId === null || selectedRunId === liveRunId) {
      setRunDetail(null)
      return
    }
    const wb = window.wrightbench
    if (!wb) return
    let disposed = false
    setRunDetail(null)
    setRunLoading(true)
    void wb.history
      .testRunDetail(project.path, selectedRunId, selected)
      .then((next) => {
        if (!disposed) setRunDetail(next)
      })
      .catch((error: unknown) => {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setRunLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [
    project.path,
    selected?.file,
    selected?.line,
    selected?.title,
    selectedRunId,
    liveRunId,
    lastRunNumber
  ])

  // quick-action intent + defaults resolve once the attempt list is known
  useEffect(() => {
    if (!runDetail || runDetail.run.id !== selectedRunId) return
    const runAttempts = runDetail.attempts
    const evidence = pendingEvidence
    if (evidence !== null) setPendingEvidence(null)
    if (runAttempts.length === 0) {
      if (selectedAttemptId !== null) setSelectedAttemptId(null)
      return
    }
    if (evidence !== null) {
      const kinds = EVIDENCE_KINDS[evidence]
      const withKind = runAttempts.filter((attempt) =>
        attempt.artifacts.some((artifact) => kinds.includes(artifact.kind))
      )
      if (withKind.length > 0) {
        const failed = withKind.find((attempt) => attemptStatus(attempt.status) === 'fail')
        setSelectedAttemptId((failed ?? withKind[0]).id)
        return
      }
    }
    if (runAttempts.some((attempt) => attempt.id === selectedAttemptId)) return
    setSelectedAttemptId(pickDefaultAttempt(runAttempts, preferredProjectRef.current).id)
  }, [runDetail, selectedRunId, pendingEvidence, selectedAttemptId])

  const filteredHistory = useMemo(() => {
    const runs = (detail?.runs ?? []).filter((run) => {
      const timestamp = run.finishedAt ?? run.startedAt
      return (
        (dateRange.from === null || timestamp >= dateRange.from) &&
        (dateRange.to === null || timestamp <= dateRange.to)
      )
    })
    const recent20 = runs.slice(0, 20)
    const executed20 = recent20.filter((run) => run.status !== 'skipped')
    const recent10 = runs
      .filter((run) => run.status !== 'skipped')
      .slice(0, 10)
      .map((run) => run.status)
    return {
      runs,
      last20: recent20
        .map((run) => ({
          runId: run.runId,
          runNumber: run.runNumber,
          status: run.status
        }))
        .reverse() as Last20Cell[],
      passRatePct:
        executed20.length === 0
          ? null
          : Math.round(
              (executed20.filter((run) => run.status === 'pass').length /
                executed20.length) *
                1000
            ) / 10,
      flakyPct: playwrightFlakePct(recent10),
      medianDurationMs: median(executed20.map((run) => run.durationMs)),
      /* actual sample sizes behind the recent-window metrics, for labeling */
      windowSize: executed20.length,
      flakyWindowSize: recent10.length
    }
  }, [dateRange.from, dateRange.to, detail?.runs])
  const rows = filteredHistory.runs

  // date filtering keeps the selection when possible, else newest, else none
  useEffect(() => {
    if (loading && detail === null) return
    if (liveRunId !== null && selectedRunId === liveRunId) return
    // The run that just finished stays selected while its refreshed history
    // row is still in flight — snapping to the stale newest here would leave
    // the fresh run unselected once it lands.
    if (
      selectedRunId !== null &&
      selectedRunId === lastHistoryRunId &&
      !rows.some((run) => run.runId === selectedRunId)
    ) {
      return
    }
    if (rows.length === 0) {
      if (liveRunId !== null) {
        setSelectedRunId(liveRunId)
        setRunTab('overview')
      } else if (selectedRunId !== null) {
        setSelectedRunId(null)
      }
      return
    }
    if (selectedRunId === null || !rows.some((run) => run.runId === selectedRunId)) {
      setSelectedRunId(rows[0].runId)
      setSelectedAttemptId(null)
    }
  }, [rows, selectedRunId, liveRunId, loading, detail, lastHistoryRunId])

  // A freshly recorded run always becomes the selected run, however it was
  // produced (focused run, Run all, watch, UI Mode) — matching how a live
  // run claims the selection while it streams. The first history load of a
  // test keeps the plain newest-row default above.
  useEffect(() => {
    const newestId = detail?.runs[0]?.runId ?? null
    const previousId = newestRunIdRef.current
    newestRunIdRef.current = newestId
    if (newestId === null || previousId === null || newestId === previousId) return
    if (liveRunId !== null) return // the streaming run owns the selection
    if (selectedRunId !== newestId) {
      setSelectedRunId(newestId)
      setSelectedAttemptId(null)
      setRunTab('overview')
      setPendingEvidence(null)
    }
    // a custom date window ending in the past would hide the fresh run
    if (!rows.some((run) => run.runId === newestId)) setDateRange(ALL_DATE_RANGE)
  }, [detail, liveRunId, selectedRunId, rows])

  // Failure entry points converge on the selected test's retained Trace tab.
  // Waiting for detailKey prevents a test switch from resolving "latest" from
  // the previously selected declaration's history.
  useEffect(() => {
    if (
      !traceIntent ||
      traceIntent.key !== selectedKey ||
      detailKey !== selectedKey ||
      detail === null
    )
      return
    const requestedRunId = traceIntent.runId ?? detail.latestFailure?.runId ?? null
    consumeTraceIntent(traceIntent.id)
    if (
      requestedRunId === null ||
      !detail.runs.some((run) => run.runId === requestedRunId)
    )
      return
    // A sidebar request may target a failure outside the inspector's current
    // date window. Expand history before selecting so the range effect cannot
    // immediately replace the requested run with the newest visible one.
    setDateRange(ALL_DATE_RANGE)
    setSelectedRunId(requestedRunId)
    setSelectedAttemptId(null)
    setRunTab('trace')
    setPendingEvidence('trace')
  }, [traceIntent, selectedKey, detailKey, detail, consumeTraceIntent])

  const oldestRunTimestamp = useMemo(() => {
    const runs = detail?.runs ?? []
    if (runs.length === 0) return undefined
    return Math.min(...runs.map((run) => run.finishedAt ?? run.startedAt))
  }, [detail?.runs])

  if (!selected || !tree) return null

  const location = buildTestLocation(
    tree?.rootDir ?? null,
    selected.file,
    selected.line,
    selected.column
  )
  const testGrep = buildTestTitleGrep(selected.titlePath)
  const relativeFile = specRootPath(tree?.rootDir ?? null, selected.file)
  // sessions block runs, and so does a target the runner can't execute yet
  const targetRunnable = activeTarget?.runnable ?? true
  const uiBusy = uiModeBlocksOtherWork({ status: uiStatus, run: uiRun, recording: uiRecording })
  const busy = running || uiBusy || recording || !targetRunnable
  const busyTitle = running
    ? 'A Wrightbench run is already in progress'
    : uiStatus === 'external'
      ? 'Stop external UI Mode before starting a Wrightbench run'
      : uiBusy
        ? 'Stop the active UI Mode session before starting a Wrightbench run'
        : recording
          ? 'Stop the active Codegen session first'
          : !targetRunnable
            ? (activeTarget?.runnableReason ?? 'Running this target is not supported yet')
            : undefined
  const legacyMatches = tree.files.reduce(
    (count, file) =>
      count + file.tests.filter((test) => legacyTestKey(test) === legacyTestKey(selected)).length,
    0
  )
  const liveAttempts = Object.values(attempts).filter((attempt) => {
    const attemptKey = testKey(attempt, tree.targetId)
    if (attemptKey === selectedKey) return true
    return (
      attemptKey === legacyTestKey(attempt) &&
      legacyMatches === 1 &&
      legacyTestKey(attempt) === legacyTestKey(selected)
    )
  })
  const hasRuns =
    detail !== null || decl !== undefined || final !== undefined || liveAttempts.length > 0

  const liveRow: LiveRunRow | null =
    liveRunId !== null
      ? {
          runId: liveRunId,
          runNumber,
          startedAt: runStartedAt ?? Date.now()
        }
      : null
  const liveDetail: LiveRunDetail | null =
    liveRunId !== null && selectedRunId === liveRunId
      ? {
          runNumber,
          trigger: runTrigger,
          commitHash: runCommit,
          startedAt: runStartedAt ?? Date.now(),
          attempts: liveAttempts
        }
      : null
  const selectedSummary =
    liveDetail !== null
      ? null
      : (detail?.runs.find((run) => run.runId === selectedRunId) ?? null)

  const orderedRunIds = [
    ...(liveRow ? [liveRow.runId] : []),
    ...rows.map((run) => run.runId)
  ]
  const selectedIndex = selectedRunId === null ? -1 : orderedRunIds.indexOf(selectedRunId)
  const hasOlder = selectedIndex !== -1 && selectedIndex < orderedRunIds.length - 1
  const hasNewer = selectedIndex > 0

  const runTest = (): void => {
    if (!busy) void startRun({ location, grep: testGrep })
  }

  const openFile = (): void => {
    void window.wrightbench?.project.openFile(project.path, relativeFile).then((result) => {
      if (!result.ok) console.error('open file failed:', result.error)
    })
  }

  const chooseRun = (runId: number): void => {
    if (runId !== selectedRunId) setSelectedAttemptId(null)
    setSelectedRunId(runId)
    setRunTab('overview')
    setPendingEvidence(null)
  }

  const selectAttempt = (attemptId: number, attemptProject: string): void => {
    setSelectedAttemptId(attemptId)
    preferredProjectRef.current = attemptProject
  }

  const stepRun = (delta: 1 | -1): void => {
    const nextId = orderedRunIds[selectedIndex + delta]
    if (nextId === undefined) return
    if (nextId !== selectedRunId) setSelectedAttemptId(null)
    setSelectedRunId(nextId)
    setPendingEvidence(null)
    // evidence tabs exist for every recorded run; only the live run is Overview-only
    if (nextId === liveRow?.runId) setRunTab('overview')
  }

  return (
    <div className={styles.inspector} role="region" aria-labelledby="selected-test-heading">
      <div className={styles.topNavigation}>
        <span className={styles.runsHeading}>Runs</span>
      </div>

      <header className={styles.header}>
        <div className={styles.contextLabel}>
          <span>{relativeFile}:{selected.line}</span>
          <span aria-hidden>·</span>
          <strong id="selected-test-heading">{selected.title}</strong>
        </div>
        <div className={styles.headerActions}>
          {hasRuns && (
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              minDate={oldestRunTimestamp}
            />
          )}
          <Button variant="ghost" size={30} padX={10} onClick={openFile}>
            <Icon name="file" size={12} />
            Open file
          </Button>
          {running ? (
            <Button variant="danger-outline" size={30} padX={12} onClick={() => void stopRun()}>
              <Icon name="stop" size={10} />
              Stop run
            </Button>
          ) : (
            <Button
              variant="primary"
              size={30}
              padX={12}
              disabled={busy}
              title={busyTitle}
              onClick={runTest}
            >
              <Icon name="play" size={12} />
              Run and Capture
            </Button>
          )}
        </div>
      </header>

      {loading && !detail && liveAttempts.length === 0 ? (
        <div className={styles.stateWrap}>
          <div className={styles.loading} role="status">
            <Spinner size={12} />
            Loading test history…
          </div>
        </div>
      ) : loadError && !detail ? (
        <div className={styles.stateWrap}>
          <div className={styles.error} role="alert">
            Could not load test details: {loadError}
          </div>
        </div>
      ) : !hasRuns ? (
        <div className={styles.stateWrap}>
          <section className={styles.empty}>
            <StatusMark status="none" />
            <h3>No runs recorded for this test</h3>
            <p>Run and Capture once to unlock test information, history, video, report, and trace evidence.</p>
            <Button variant="primary" size={30} padX={12} disabled={busy} title={busyTitle} onClick={runTest}>
              <Icon name="play" size={12} />
              Run and Capture
            </Button>
          </section>
        </div>
      ) : (
        <div className={styles.runsColumn}>
          {loadError && (
            <div className={styles.error} role="alert">
              Could not refresh test details: {loadError}
            </div>
          )}

          <div className={styles.summaryCard}>
            <div
              className={styles.summaryStrip}
              aria-label={`Recent outcomes, newest ${filteredHistory.last20.length} runs`}
            >
              {filteredHistory.last20.length > 0 ? (
                filteredHistory.last20.map((cell) => (
                  <HistoryCell
                    key={cell.runId}
                    cell={cell}
                    selectionKey={testKey(selected, tree.targetId)}
                  />
                ))
              ) : (
                <span className={styles.summaryStripEmpty}>
                  {detail ? 'No outcomes in this date range' : 'No recorded outcomes yet'}
                </span>
              )}
            </div>
            <div className={styles.summaryMetrics}>
              <div>
                <span>Pass rate{windowLabel(filteredHistory.windowSize)}</span>
                <strong>{filteredHistory.passRatePct === null ? '—' : `${filteredHistory.passRatePct}%`}</strong>
              </div>
              <div>
                <span>Flaky rate{windowLabel(filteredHistory.flakyWindowSize)}</span>
                <strong>{filteredHistory.flakyPct === null ? '—' : `${filteredHistory.flakyPct}%`}</strong>
              </div>
              <div>
                <span>Median duration{windowLabel(filteredHistory.windowSize)}</span>
                <strong>{filteredHistory.medianDurationMs === null ? '—' : formatDuration(filteredHistory.medianDurationMs)}</strong>
              </div>
            </div>
          </div>

          {rows.length === 0 && liveRow === null ? (
            <div className={styles.rangeEmpty}>
              <Icon name="calendar" size={15} />
              <div>
                <strong>No runs in this date range</strong>
                <span>Choose a wider range to see recorded outcomes.</span>
              </div>
              {dateRange.preset !== 'all' && (
                <Button
                  variant="ghost"
                  size={26}
                  padX={9}
                  onClick={() => setDateRange(ALL_DATE_RANGE)}
                >
                  Show all runs
                </Button>
              )}
            </div>
          ) : (
            <div className={styles.runWorkspace}>
              <div className={styles.master}>
                <div className={styles.masterHeading}>
                  <h3>Recorded runs</h3>
                  <div className={styles.masterHeadingMeta}>
                    <span>
                      {rows.length + (liveRow ? 1 : 0)}{' '}
                      {rows.length + (liveRow ? 1 : 0) === 1 ? 'run' : 'runs'}
                    </span>
                    <div className={styles.masterNav}>
                      <button
                        type="button"
                        aria-label="Select newer run"
                        disabled={!hasNewer}
                        onClick={() => stepRun(-1)}
                      >
                        <Icon name="chevron-left" size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="Select older run"
                        disabled={!hasOlder}
                        onClick={() => stepRun(1)}
                      >
                        <Icon name="chevron-right" size={12} />
                      </button>
                    </div>
                  </div>
                </div>
                <div className={styles.masterScroll}>
                  <RunList
                    rows={rows}
                    live={liveRow}
                    selectedRunId={selectedRunId}
                    onSelectRun={chooseRun}
                  />
                </div>
              </div>
              <RunDetail
                project={project}
                summary={selectedSummary}
                live={liveDetail}
                runDetail={runDetail}
                runLoading={runLoading}
                runTab={runTab}
                onTabChange={setRunTab}
                selectedAttemptId={selectedAttemptId}
                onSelectAttempt={selectAttempt}
                onStepRun={stepRun}
                hasNewer={hasNewer}
                hasOlder={hasOlder}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

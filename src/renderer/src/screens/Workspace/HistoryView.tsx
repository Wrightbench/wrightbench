import { useEffect, useMemo, useState, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { DateRangePicker } from '@/components/DateRangePicker/DateRangePicker'
import { Icon } from '@/components/Icon/Icon'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { useHistory } from '@/state/history'
import type {
  HistoryRunTest,
  ProjectInfo,
  RunRecord,
  TestRunDetail,
  TestRunSummary
} from '@shared/ipc'
import { formatDuration } from './ResultsList'
import { RunDetail } from './RunDetail'
import { RunsView } from './RunsView'
import { statusLabel, StatusMark, type RunTab } from './RunsShared'
import styles from './HistoryView.module.css'

function runStatus(run: RunRecord): 'pass' | 'fail' | 'flaky' | 'skipped' {
  if (run.failed > 0) return 'fail'
  if (run.flaky > 0) return 'flaky'
  if (run.passed > 0) return 'pass'
  return 'skipped'
}

function testSummary(run: RunRecord, test: HistoryRunTest): TestRunSummary {
  return {
    runId: run.id,
    runNumber: run.runNumber,
    status: test.status,
    durationMs: test.durationMs,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    trigger: run.trigger,
    commitHash: run.commitHash,
    projectFilter: '',
    attemptCount: test.attemptCount,
    artifactKinds: test.artifactKinds,
    projectStatuses: test.projectStatuses,
    firstErrorLine: test.firstErrorLine
  }
}

function HistoryRunView({
  project,
  run,
  runs,
  onBack,
  onSelectRun
}: {
  project: ProjectInfo
  run: RunRecord
  runs: RunRecord[]
  onBack(): void
  onSelectRun(runId: number): void
}): JSX.Element {
  const [tests, setTests] = useState<HistoryRunTest[]>([])
  const [testsLoading, setTestsLoading] = useState(false)
  const [testsError, setTestsError] = useState<string | null>(null)
  const [selectedTestKey, setSelectedTestKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<TestRunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [runTab, setRunTab] = useState<RunTab>('overview')
  const [selectedAttemptId, setSelectedAttemptId] = useState<number | null>(null)

  const keyOf = (test: HistoryRunTest): string =>
    JSON.stringify([test.file, test.line, test.title])

  useEffect(() => {
    const wb = window.wrightbench
    setTests([])
    setSelectedTestKey(null)
    setDetail(null)
    setTestsError(null)
    setRunTab('overview')
    setSelectedAttemptId(null)
    if (!wb) return
    let disposed = false
    setTestsLoading(true)
    void wb.history
      .runTests(project.path, run.id)
      .then((next) => {
        if (disposed) return
        setTests(next)
        setSelectedTestKey(next[0] ? keyOf(next[0]) : null)
      })
      .catch((error: unknown) => {
        if (!disposed) setTestsError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setTestsLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [project.path, run.id])

  const selectedTest = tests.find((test) => keyOf(test) === selectedTestKey) ?? null

  useEffect(() => {
    const wb = window.wrightbench
    setDetail(null)
    setDetailError(null)
    setSelectedAttemptId(null)
    setRunTab('overview')
    if (!wb || !selectedTest) return
    let disposed = false
    setDetailLoading(true)
    void wb.history
      .testRunDetail(project.path, run.id, {
        file: selectedTest.file,
        line: selectedTest.line,
        title: selectedTest.title
      })
      .then((next) => {
        if (disposed) return
        setDetail(next)
        const firstProject = next?.attempts[0]?.project
        const decisive = firstProject
          ? [...(next?.attempts ?? [])]
              .filter((attempt) => attempt.project === firstProject)
              .sort((a, b) => a.retry - b.retry)
              .at(-1)
          : null
        setSelectedAttemptId(decisive?.id ?? null)
      })
      .catch((error: unknown) => {
        if (!disposed) setDetailError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed) setDetailLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [project.path, run.id, selectedTest?.file, selectedTest?.line, selectedTest?.title])

  const runIndex = runs.findIndex((candidate) => candidate.id === run.id)
  const summary = selectedTest ? testSummary(run, selectedTest) : null
  const status = runStatus(run)

  return (
    <div className={styles.detailSurface}>
      <header className={styles.detailToolbar}>
        <Button variant="ghost" size={30} padX={8} onClick={onBack}>
          <Icon name="chevron-left" size={12} />
          All runs
        </Button>
        <span className={styles.detailDivider} aria-hidden />
        <span className={styles.detailIdentity}>
          <StatusMark status={status} />
          <strong>Run #{run.runNumber}</strong>
          <span>{statusLabel(status)}</span>
        </span>
        <span className={styles.runNavigation} aria-label="Run navigation">
          <button
            type="button"
            className={styles.runNavigationButton}
            aria-label="Newer run"
            title="Newer run"
            disabled={runIndex <= 0}
            onClick={() => {
              const next = runs[runIndex - 1]
              if (next) onSelectRun(next.id)
            }}
          >
            <Icon name="chevron-left" size={12} />
          </button>
          <button
            type="button"
            className={styles.runNavigationButton}
            aria-label="Older run"
            title="Older run"
            disabled={runIndex < 0 || runIndex >= runs.length - 1}
            onClick={() => {
              const next = runs[runIndex + 1]
              if (next) onSelectRun(next.id)
            }}
          >
            <Icon name="chevron-right" size={12} />
          </button>
        </span>
        <span className={styles.detailMeta}>
          {run.total} {run.total === 1 ? 'test' : 'tests'}
          {run.durationMs !== null && ` · ${formatDuration(run.durationMs)}`}
        </span>
      </header>

      <div className={styles.detailBody}>
        <section className={styles.testRail} aria-label={`Tests in run ${run.runNumber}`}>
          <div className={styles.testListHeading}>
            <span>TESTS IN THIS RUN</span>
            <code>{tests.length || run.total}</code>
          </div>
          {testsLoading ? (
            <div className={styles.listState} role="status">
              <Spinner size={12} /> Loading tests…
            </div>
          ) : testsError ? (
            <div className={styles.listError} role="alert">{testsError}</div>
          ) : tests.length === 0 ? (
            <div className={styles.listState}>No declaration details were retained.</div>
          ) : (
            <div className={styles.testRows}>
              {tests.map((test) => {
                const key = keyOf(test)
                const selected = key === selectedTestKey
                return (
                  <button
                    key={key}
                    type="button"
                    className={selected ? `${styles.testRow} ${styles.testRowActive}` : styles.testRow}
                    aria-pressed={selected}
                    aria-label={`${test.title}, ${statusLabel(test.status)}, ${formatDuration(test.durationMs)}`}
                    onClick={() => setSelectedTestKey(key)}
                  >
                    <span className={styles.testMark}><StatusMark status={test.status} /></span>
                    <span className={styles.testText}>
                      <strong>{test.title}</strong>
                      <code>{test.file}:{test.line}</code>
                    </span>
                    <code className={styles.testDuration}>{formatDuration(test.durationMs)}</code>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <main className={styles.evidence}>
          {detailError && (
            <div className={styles.detailError} role="alert">
              <Icon name="warning" size={12} />
              Could not load this run’s evidence: {detailError}
            </div>
          )}
          <RunDetail
            project={project}
            summary={summary}
            live={null}
            runDetail={detail}
            runLoading={detailLoading}
            runTab={runTab}
            onTabChange={setRunTab}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={(attemptId) => setSelectedAttemptId(attemptId)}
          />
        </main>
      </div>
    </div>
  )
}

export function HistoryView({ project }: { project: ProjectInfo }): JSX.Element {
  const dateRange = useHistory((state) => state.dateRange)
  const setDateRange = useHistory((state) => state.setDateRange)
  const runs = useHistory((state) => state.runs)
  const analytics = useHistory((state) => state.analytics)
  const projectPath = useHistory((state) => state.projectPath)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const projectRuns = projectPath === project.path ? runs : []

  const selectedRun = useMemo(
    () => projectRuns.find((run) => run.id === selectedRunId) ?? null,
    [projectRuns, selectedRunId]
  )

  useEffect(() => {
    if (selectedRunId !== null && !selectedRun) setSelectedRunId(null)
  }, [selectedRun, selectedRunId])

  if (selectedRun) {
    return (
      <HistoryRunView
        project={project}
        run={selectedRun}
        runs={projectRuns}
        onBack={() => setSelectedRunId(null)}
        onSelectRun={setSelectedRunId}
      />
    )
  }

  return (
    <div className={styles.root}>
      <header className={styles.toolbar}>
        <div className={styles.heading}>
          <h2>Reports</h2>
        </div>
        <div className={styles.controls}>
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
            minDate={projectPath === project.path ? analytics?.oldestKeptAt ?? undefined : undefined}
            ariaLabel="Filter reports by date range"
          />
        </div>
      </header>
      <RunsView path={project.path} selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
    </div>
  )
}

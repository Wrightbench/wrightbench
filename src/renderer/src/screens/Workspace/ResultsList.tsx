import { useEffect, useState, type JSX } from 'react'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import { declStatus, testKey, useRun, type TestStatus } from '@/state/run'
import type { TestDecl, TestTreeFile } from '@shared/ipc'
import styles from './ResultsList.module.css'

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** re-render twice a second while a run streams, for live durations */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function RowDot({ status }: { status: TestStatus }): JSX.Element {
  if (status === 'running') return <Spinner size={12} />
  if (status === 'none' || status === 'skipped') return <span className={styles.noneDot} aria-hidden />
  if (status === 'queued') return <StatusDot status="queued" />
  return <StatusDot status={status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'flaky'} />
}

function ResultRow({
  test,
  targetId,
  now
}: {
  test: TestDecl
  targetId: string
  now: number
}): JSX.Element {
  const key = testKey(test, targetId)
  const decl = useRun((s) => s.decls[key])
  const final = useRun((s) => s.statuses[key])
  const select = useRun((s) => s.select)

  const status: TestStatus = decl ? declStatus(decl) : (final?.status ?? 'none')
  const declDone = decl ? Object.keys(decl.perProject).length > 0 : false
  const duration = decl && declDone
    ? Math.max(...Object.values(decl.perProject).map((r) => r.duration))
    : (final?.duration ?? null)

  let durationText = ''
  if (status === 'running' && decl?.startedAt) {
    durationText = `${((now - decl.startedAt) / 1000).toFixed(1)}s…`
  } else if (status === 'queued') {
    durationText = 'queued'
  } else if (duration !== null && status !== 'none') {
    durationText = formatDuration(duration)
  }

  const failed = status === 'fail'
  const rowClasses = [
    styles.row,
    failed ? styles.rowFailed : '',
    status === 'queued' ? styles.rowQueued : ''
  ]
    .filter(Boolean)
    .join(' ')
  const titleClasses = [
    styles.title,
    failed ? styles.titleFailed : '',
    status === 'queued' ? styles.titleQueued : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={rowClasses}
      data-result-key={key}
      onClick={() => select(key)}
    >
      <RowDot status={status} />
      <span className={titleClasses}>{test.title}</span>
      <span
        className={
          failed
            ? `${styles.duration} ${decl ? styles.durationFailedLive : styles.durationFailed}`
            : styles.duration
        }
      >
        {durationText}
      </span>
    </button>
  )
}

function Header(): JSX.Element {
  const running = useRun((s) => s.running)
  const runNumber = useRun((s) => s.runNumber)
  const lastRun = useRun((s) => s.lastRun)
  const decls = useRun((s) => s.decls)

  if (running) {
    let passed = 0
    let failed = 0
    let queued = 0
    for (const decl of Object.values(decls)) {
      const status = declStatus(decl)
      if (status === 'pass') passed += 1
      else if (status === 'fail') failed += 1
      else if (status === 'queued') queued += 1
    }
    return (
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          Run{' '}
          <span className={styles.headerRunNumber}>
            {runNumber > 0 ? `#${runNumber}` : '#…'}
          </span>{' '}
          — in progress
        </span>
        <span className={styles.headerCounts}>
          <span className={styles.countPassLive}>{passed} passed</span> ·{' '}
          <span className={styles.countFailLive}>{failed} failed</span> ·{' '}
          <span className={styles.countQueued}>{queued} queued</span>
        </span>
      </div>
    )
  }

  return (
    <div className={styles.header}>
      <span className={styles.headerTitle}>
        {lastRun ? (
          <>
            Last run <span className={styles.headerRunNumber}>#{lastRun.number}</span>
          </>
        ) : (
          'No runs yet'
        )}
      </span>
      {lastRun && (
        <span className={styles.headerCounts}>
          <span className={styles.countPass}>{lastRun.passed} passed</span> ·{' '}
          <span className={styles.countFail}>{lastRun.failed} failed</span> ·{' '}
          <span className={styles.countFlaky}>{lastRun.flaky} flaky</span>
        </span>
      )}
    </div>
  )
}

export function ResultsList(): JSX.Element {
  const tree = useRun((s) => s.tree)
  const testDir = useRun((s) => s.tree?.rootDir)
  const running = useRun((s) => s.running)
  const runError = useRun((s) => s.runError)
  const now = useTicker(running)

  const groupLabel = (file: TestTreeFile): string =>
    testDir && testDir !== '.' ? `${testDir}/${file.file}` : file.file

  return (
    <div className={styles.list}>
      <Header />
      <div className={styles.body}>
        {runError && <div className={styles.runError}>{runError}</div>}
        {tree?.files.map((file, index) => (
          <div key={file.file} style={{ display: 'contents' }}>
            <div className={index === 0 ? `${styles.group} ${styles.groupFirst}` : styles.group}>
              {groupLabel(file)}
            </div>
            {file.tests.map((test) => (
              <ResultRow
                key={testKey(test, tree.targetId)}
                test={test}
                targetId={tree.targetId}
                now={now}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent
} from 'react'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { SegmentedControl } from '@/components/SegmentedControl/SegmentedControl'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { FrameAction, WebviewFrame } from '@/components/WebviewFrame/WebviewFrame'
import type { LiveAttempt } from '@/state/run'
import type {
  PersistedArtifact,
  PersistedAttempt,
  ProjectInfo,
  TestRunDetail,
  TestRunSummary
} from '@shared/ipc'
import { formatDuration } from './ResultsList'
import {
  attemptLabel,
  attemptStatus,
  formatBytes,
  formatTimestamp,
  statusLabel,
  StatusMark,
  type RunTab
} from './RunsShared'
import { runEvidenceTabs } from './run-evidence-tabs'
import { useNow } from './useNow'
import styles from './RunDetail.module.css'

/** the streaming state of the in-flight run while it is the selected run */
export interface LiveRunDetail {
  runNumber: number
  trigger: string
  commitHash: string | null
  startedAt: number
  attempts: LiveAttempt[]
}

const TAB_LABEL: Record<RunTab, string> = {
  overview: 'Overview',
  video: 'Video',
  screenshots: 'Screenshots',
  trace: 'Trace'
}

/** artifact kinds that belong to the Screenshots tab */
const SCREEN_KINDS = ['screenshot', 'diff']

function attemptName(attempt: PersistedAttempt): string {
  return `${attempt.project || 'default'} · ${attemptLabel(attempt.retry)}`
}

function AttemptCard({ attempt }: { attempt: PersistedAttempt | LiveAttempt }): JSX.Element {
  const status = attemptStatus(attempt.status)
  const steps = attempt.steps.map((step) => ({
    key: 'externalId' in step ? step.externalId : step.id,
    title: step.title,
    category: step.category,
    durationMs: step.durationMs,
    error: step.error
  }))
  return (
    <article className={styles.attemptCard}>
      <header className={styles.attemptHeader}>
        <div>
          <StatusMark status={status} />
          <strong>{attempt.project || 'default project'}</strong>
          <span>{attemptLabel(attempt.retry)}</span>
        </div>
        <code>{attempt.durationMs === null ? 'Running…' : formatDuration(attempt.durationMs)}</code>
      </header>
      {attempt.error && <pre className={styles.attemptError}>{attempt.error}</pre>}
      {steps.length > 0 && (
        <div className={styles.steps}>
          {steps.map((step) => (
            <div key={step.key} className={styles.stepRow}>
              <span
                className={`${styles.stepState} ${
                  step.error
                    ? styles.stepStateFail
                    : step.durationMs === null
                      ? styles.stepStatePending
                      : ''
                }`}
              >
                {step.error ? '×' : step.durationMs === null ? '·' : '✓'}
              </span>
              <span className={styles.stepTitle}>{step.title}</span>
              <span className={styles.stepCategory}>{step.category}</span>
              <code>{step.durationMs === null ? '—' : formatDuration(step.durationMs)}</code>
            </div>
          ))}
        </div>
      )}
      {attempt.logs.length > 0 && (
        <details className={styles.logs}>
          <summary>Console output · {attempt.logs.length}</summary>
          <pre>
            {attempt.logs.map((log) => `[${log.stream}] ${log.text}`).join('')}
          </pre>
        </details>
      )}
    </article>
  )
}

function ArtifactList({
  artifacts,
  selectedId,
  onSelect
}: {
  artifacts: PersistedArtifact[]
  selectedId: number | null
  onSelect(artifact: PersistedArtifact): void
}): JSX.Element {
  return (
    <div className={styles.artifactGrid}>
      {artifacts.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          className={`${styles.artifactCard} ${selectedId === artifact.id ? styles.artifactCardActive : ''}`}
          aria-pressed={selectedId === artifact.id}
          onClick={() => onSelect(artifact)}
        >
          <Icon
            name={artifact.kind === 'video' ? 'video' : artifact.kind === 'screenshot' || artifact.kind === 'diff' ? 'image' : 'file'}
            size={15}
          />
          <span>
            <strong>{artifact.name || artifact.fileName}</strong>
            <small>{artifact.kind} · {formatBytes(artifact.sizeBytes)}</small>
          </span>
          <Icon
            name={['screenshot', 'diff', 'video', 'trace'].includes(artifact.kind) ? 'eye' : 'external-link'}
            size={11}
          />
        </button>
      ))}
    </div>
  )
}

/**
 * Enlarged capture over a scrim: bounded ‹ › navigation, arrow keys, Escape,
 * and a two-stop focus trap in the ConfirmDialog style.
 */
function ScreenshotLightbox({
  artifacts,
  urls,
  index,
  attemptCaption,
  onNavigate,
  onClose
}: {
  artifacts: PersistedArtifact[]
  urls: Record<number, string | null>
  index: number
  attemptCaption: string | null
  onNavigate(artifactId: number): void
  onClose(): void
}): JSX.Element {
  const artifact = artifacts[index]
  const url = urls[artifact.id]
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const step = (delta: number): void => {
    const next = artifacts[index + delta]
    if (next) onNavigate(next.id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowLeft') {
      step(-1)
      return
    }
    if (e.key === 'ArrowRight') {
      step(1)
      return
    }
    if (e.key !== 'Tab') return
    const buttons = [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    const next = e.shiftKey
      ? (current - 1 + buttons.length) % buttons.length
      : (current + 1) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div
      ref={rootRef}
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={`${artifact.name || artifact.fileName} enlarged`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={styles.lightboxCard}>
        <header className={styles.lightboxBar}>
          <div>
            <strong>{artifact.name || artifact.fileName}</strong>
            <span>
              {artifact.kind} · {formatBytes(artifact.sizeBytes)} · {index + 1} of{' '}
              {artifacts.length}
              {attemptCaption && ` · ${attemptCaption}`}
            </span>
          </div>
          <div className={styles.lightboxActions}>
            <Button
              variant="ghost"
              size={26}
              padX={9}
              onClick={() => void window.wrightbench?.attachments.open(artifact.path)}
            >
              <Icon name="external-link" size={11} />
              Open externally
            </Button>
            <button
              type="button"
              className={styles.lightboxClose}
              aria-label="Close enlarged view"
              onClick={onClose}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        </header>
        <div className={styles.lightboxStage}>
          {url ? (
            <img src={url} alt={artifact.name || 'Test screenshot'} />
          ) : url === null ? (
            <div className={styles.lightboxMissing}>
              <Icon name="warning" size={14} />
              This capture could not be previewed. Open it externally instead.
            </div>
          ) : (
            <Spinner size={12} />
          )}
          <button
            type="button"
            className={`${styles.lightboxNav} ${styles.lightboxPrev}`}
            aria-label="Previous capture"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <Icon name="chevron-left" size={14} />
          </button>
          <button
            type="button"
            className={`${styles.lightboxNav} ${styles.lightboxNext}`}
            aria-label="Next capture"
            disabled={index === artifacts.length - 1}
            onClick={() => step(1)}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** compact project pills (+ attempt sub-select) when a run has several results */
function RunProjectSelector({
  attempts,
  selectedAttemptId,
  onSelectAttempt
}: {
  attempts: PersistedAttempt[]
  selectedAttemptId: number | null
  onSelectAttempt(attemptId: number, project: string): void
}): JSX.Element | null {
  const byProject = useMemo(() => {
    const map = new Map<string, PersistedAttempt[]>()
    for (const attempt of attempts) {
      const list = map.get(attempt.project) ?? []
      list.push(attempt)
      map.set(attempt.project, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.retry - b.retry)
    return map
  }, [attempts])
  if (attempts.length < 2) return null

  const selected = attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0]
  const projectAttempts = byProject.get(selected.project) ?? []

  const projectRollup = (list: PersistedAttempt[]): ReturnType<typeof attemptStatus> => {
    const final = attemptStatus(list[list.length - 1].status)
    if (final === 'pass' && list.some((attempt) => attemptStatus(attempt.status) === 'fail')) {
      return 'flaky'
    }
    return final
  }

  return (
    <div className={styles.projectSelector}>
      <div className={styles.projectPills} role="radiogroup" aria-label="Playwright project">
        {[...byProject.entries()].map(([project, list]) => {
          const active = project === selected.project
          // entering a project lands on its final attempt (the decisive one)
          const target = list[list.length - 1]
          return (
            <button
              key={project}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? styles.projectPillActive : styles.projectPill}
              onClick={() => onSelectAttempt(target.id, project)}
            >
              <StatusMark status={projectRollup(list)} />
              {project || 'default'}
            </button>
          )
        })}
      </div>
      {projectAttempts.length > 1 && (
        <div className={styles.attemptPills} role="radiogroup" aria-label="Attempt">
          {projectAttempts.map((attempt) => (
            <button
              key={attempt.id}
              type="button"
              role="radio"
              aria-checked={attempt.id === selected.id}
              className={attempt.id === selected.id ? styles.attemptPillActive : styles.attemptPill}
              onClick={() => onSelectAttempt(attempt.id, attempt.project)}
            >
              <StatusMark status={attemptStatus(attempt.status)} />
              {attemptLabel(attempt.retry)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface HostError {
  tab: RunTab
  message: string
}

/**
 * Detail pane for one exact logical run: compact header, run-scoped
 * Overview / Video / Trace / Report tabs, and the hosted evidence surfaces.
 * Evidence hosting state lives here and resets when the run changes.
 */
export function RunDetail({
  project,
  summary,
  live,
  runDetail,
  runLoading,
  runTab,
  onTabChange,
  selectedAttemptId,
  onSelectAttempt,
  onStepRun,
  hasNewer,
  hasOlder
}: {
  project: ProjectInfo
  summary: TestRunSummary | null
  live: LiveRunDetail | null
  runDetail: TestRunDetail | null
  runLoading: boolean
  runTab: RunTab
  onTabChange(tab: RunTab): void
  selectedAttemptId: number | null
  onSelectAttempt(attemptId: number, project: string): void
  onStepRun?(delta: 1 | -1): void
  hasNewer?: boolean
  hasOlder?: boolean
}): JSX.Element {
  const now = useNow(live !== null)
  const runId = summary?.runId ?? null

  const [traceHost, setTraceHost] = useState<{ path: string; url: string } | null>(null)
  /** trace viewer promoted to a full-window overlay for room to explore */
  const [traceExpanded, setTraceExpanded] = useState(false)
  const [videoHost, setVideoHost] = useState<{ artifactId: number; url: string } | null>(null)
  const [videoRatio, setVideoRatio] = useState<number | null>(null)
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null)
  const [hostError, setHostError] = useState<HostError | null>(null)
  /** served preview URL per screenshot artifact id; null marks a failed serve */
  const [screenshotUrls, setScreenshotUrls] = useState<Record<number, string | null>>({})
  const [screenshotView, setScreenshotView] = useState<'gallery' | 'list'>('gallery')
  /** artifact id enlarged in the lightbox (id, not index — scope can change) */
  const [lightboxId, setLightboxId] = useState<number | null>(null)
  /** in-flight hosting request per surface; late resolutions compare keys */
  const hostRequests = useRef<Partial<Record<'trace' | 'video', string>>>({})
  const screenshotRequests = useRef<Set<number>>(new Set())

  // a different run means different evidence — drop every hosted URL
  useEffect(() => {
    hostRequests.current = {}
    screenshotRequests.current.clear()
    setTraceHost(null)
    setTraceExpanded(false)
    setVideoHost(null)
    setVideoRatio(null)
    setVideoPlaybackError(null)
    setHostError(null)
    setScreenshotUrls({})
    setLightboxId(null)
  }, [runId, live !== null])

  const attempts = runDetail?.attempts ?? []
  const selectedAttempt =
    attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0] ?? null
  const runLevelArtifacts = runDetail?.runArtifacts ?? []
  const allArtifacts = [
    ...attempts.flatMap((attempt) => attempt.artifacts),
    ...runLevelArtifacts
  ]
  const scopedArtifacts = [
    ...(selectedAttempt?.artifacts ?? []),
    ...runLevelArtifacts
  ]

  // evidence resolves against the selected attempt; run-level files apply everywhere
  const traceArtifact =
    selectedAttempt?.artifacts.find((artifact) => artifact.kind === 'trace') ??
    runLevelArtifacts.find((artifact) => artifact.kind === 'trace') ??
    null
  const videoArtifacts = [
    ...(selectedAttempt?.artifacts.filter((artifact) => artifact.kind === 'video') ?? []),
    ...runLevelArtifacts.filter((artifact) => artifact.kind === 'video')
  ]
  const primaryVideo = videoArtifacts[0] ?? null

  useEffect(() => {
    setVideoRatio(null)
    setVideoPlaybackError(null)
  }, [primaryVideo?.id])

  const screenshotArtifacts = useMemo(
    () => [
      ...(selectedAttempt?.artifacts.filter((artifact) =>
        SCREEN_KINDS.includes(artifact.kind)
      ) ?? []),
      ...runLevelArtifacts.filter((artifact) => SCREEN_KINDS.includes(artifact.kind))
    ],
    [selectedAttempt, runLevelArtifacts]
  )
  const anyVideo = allArtifacts.some((artifact) => artifact.kind === 'video')
  const anyTrace = allArtifacts.some((artifact) => artifact.kind === 'trace')
  const anyScreens = allArtifacts.some((artifact) => SCREEN_KINDS.includes(artifact.kind))
  /** attachments that have no dedicated evidence tab */
  const customArtifacts = scopedArtifacts.filter(
    (artifact) => !['trace', 'report', 'video', ...SCREEN_KINDS].includes(artifact.kind)
  )
  const attemptsWithKinds = (kinds: string[]): PersistedAttempt[] =>
    attempts.filter(
      (attempt) =>
        attempt !== selectedAttempt &&
        attempt.artifacts.some((artifact) => kinds.includes(artifact.kind))
    )

  // opening an evidence tab is the request that starts its contextual server
  useEffect(() => {
    if (runTab !== 'trace' || !traceArtifact || live) return
    if (traceHost?.path === traceArtifact.path || hostError?.tab === 'trace') return
    const wb = window.wrightbench
    if (!wb) return
    const key = traceArtifact.path
    if (hostRequests.current.trace === key) return
    hostRequests.current.trace = key
    void wb.traces
      .serve(project.path, key)
      .then(({ url }) => {
        if (hostRequests.current.trace === key) setTraceHost({ path: key, url })
      })
      .catch((error: unknown) => {
        if (hostRequests.current.trace === key) {
          setHostError({
            tab: 'trace',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => {
        if (hostRequests.current.trace === key) delete hostRequests.current.trace
      })
  }, [runTab, traceArtifact, traceHost, hostError, live, project.path])

  // the gallery serves every capture in scope; failures degrade per tile
  useEffect(() => {
    if (runTab !== 'screenshots' || runId === null || live) return
    const wb = window.wrightbench
    if (!wb) return
    for (const artifact of screenshotArtifacts) {
      if (artifact.id in screenshotUrls || screenshotRequests.current.has(artifact.id)) continue
      screenshotRequests.current.add(artifact.id)
      void wb.attachments
        .serve(project.path, runId, artifact.id)
        .then(({ url }) => setScreenshotUrls((prev) => ({ ...prev, [artifact.id]: url })))
        .catch(() => setScreenshotUrls((prev) => ({ ...prev, [artifact.id]: null })))
        .finally(() => screenshotRequests.current.delete(artifact.id))
    }
  }, [runTab, screenshotArtifacts, screenshotUrls, runId, live, project.path])

  // the enlarged capture must stay within scope — attempt/tab switches close it
  useEffect(() => {
    if (lightboxId === null) return
    if (runTab !== 'screenshots' || !screenshotArtifacts.some((a) => a.id === lightboxId)) {
      setLightboxId(null)
    }
  }, [lightboxId, runTab, screenshotArtifacts])

  // leaving the Trace tab drops the enlarged overlay with it
  useEffect(() => {
    if (runTab !== 'trace') setTraceExpanded(false)
  }, [runTab])

  // Escape collapses the enlarged trace when focus sits on app chrome
  // (keys pressed inside the webview's guest page never reach the host)
  useEffect(() => {
    if (!traceExpanded) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setTraceExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [traceExpanded])

  useEffect(() => {
    if (runTab !== 'video' || !primaryVideo || runId === null || live) return
    if (videoHost?.artifactId === primaryVideo.id || hostError?.tab === 'video') return
    const wb = window.wrightbench
    if (!wb) return
    const key = String(primaryVideo.id)
    if (hostRequests.current.video === key) return
    hostRequests.current.video = key
    void wb.attachments
      .serve(project.path, runId, primaryVideo.id)
      .then(({ url }) => {
        if (hostRequests.current.video === key) {
          setVideoHost({ artifactId: primaryVideo.id, url })
        }
      })
      .catch((error: unknown) => {
        if (hostRequests.current.video === key) {
          setHostError({
            tab: 'video',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => {
        if (hostRequests.current.video === key) delete hostRequests.current.video
      })
  }, [runTab, primaryVideo, videoHost, hostError, runId, live, project.path])

  const lightboxIndex =
    lightboxId === null
      ? -1
      : screenshotArtifacts.findIndex((artifact) => artifact.id === lightboxId)

  const retainedKinds = new Set([
    ...(summary?.artifactKinds ?? []),
    ...allArtifacts.map((artifact) => artifact.kind)
  ])
  const availableTabs = runEvidenceTabs(live !== null, [...retainedKinds])
  const availableTabsKey = availableTabs.join(':')

  useEffect(() => {
    if (!availableTabs.includes(runTab)) onTabChange('overview')
  }, [availableTabsKey, runTab, onTabChange])

  const runName =
    (live?.runNumber ?? summary?.runNumber ?? 0) > 0
      ? `Run #${live?.runNumber ?? summary?.runNumber}`
      : 'Run'
  const status = live ? 'running' : (summary?.status ?? 'none')
  const durationMs = live ? Math.max(0, now - live.startedAt) : (summary?.durationMs ?? null)
  const timestamp = live ? live.startedAt : (summary?.finishedAt ?? summary?.startedAt ?? null)
  const commitHash = live?.commitHash ?? summary?.commitHash ?? null
  const selectedAttemptFailed = selectedAttempt
    ? attemptStatus(selectedAttempt.status) === 'fail'
    : status === 'fail' || status === 'flaky'
  const failed = !live && selectedAttemptFailed
  const runError = failed ? (selectedAttempt?.error ?? runDetail?.test.error ?? null) : null

  const loadingBody = (
    <div className={styles.loading} role="status">
      <Spinner size={12} />
      Loading run evidence…
    </div>
  )

  // selection resolves in an effect; never flash a half-empty header
  if (summary === null && live === null) {
    return (
      <section className={styles.detail} aria-label="Run details">
        <div className={styles.body}>
          <div className={styles.tabEmpty}>Select a run from the list.</div>
        </div>
      </section>
    )
  }

  return (
    <section className={styles.detail} aria-label={`${runName} details`}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <span className={styles.headerIdentity}>
            <strong>{runName}</strong>
            <span className={`${styles.status} ${styles[`status_${status}`] ?? ''}`}>
              <StatusMark status={status} />
              {statusLabel(status)}
              {durationMs !== null && ` · ${formatDuration(durationMs)}`}
            </span>
          </span>
          {onStepRun && (
            <span className={styles.headerNav}>
              <button
                type="button"
                className={styles.headerNavButton}
                aria-label="Newer run"
                disabled={!hasNewer}
                onClick={() => onStepRun(-1)}
              >
                <Icon name="chevron-left" size={12} />
              </button>
              <button
                type="button"
                className={styles.headerNavButton}
                aria-label="Older run"
                disabled={!hasOlder}
                onClick={() => onStepRun(1)}
              >
                <Icon name="chevron-right" size={12} />
              </button>
            </span>
          )}
        </div>
        <div className={styles.headerMeta}>
          {timestamp !== null && <span>{live ? 'Started now' : formatTimestamp(timestamp)}</span>}
          {commitHash && <code>{commitHash.slice(0, 7)}</code>}
          {!live && runDetail !== null && runDetail.run.total > 0 && (
            <span
              title={
                'Tests this run covered. Run numbers count every recorded run of the ' +
                'project — run-all, a file, or a single test — so one test’s history ' +
                'skips the numbers of runs that didn’t include it.'
              }
            >
              {runDetail.run.total} {runDetail.run.total === 1 ? 'test' : 'tests'}
            </span>
          )}
          {!live && selectedAttempt && <span>{attemptName(selectedAttempt)}</span>}
        </div>
        {!live && (
          <RunProjectSelector
            attempts={attempts}
            selectedAttemptId={selectedAttempt?.id ?? null}
            onSelectAttempt={onSelectAttempt}
          />
        )}
        <nav className={styles.tabs} role="tablist" aria-label="Run evidence">
          {availableTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={runTab === tab}
              className={runTab === tab ? styles.tabActive : styles.tab}
              onClick={() => onTabChange(tab)}
            >
              {TAB_LABEL[tab]}
            </button>
          ))}
        </nav>
      </header>

      {hostError && (
        <div className={styles.hostError} role="alert">
          <Icon name="warning" size={12} />
          <span>{hostError.message}</span>
          <button type="button" onClick={() => setHostError(null)}>
            {hostError.tab === 'overview' ? 'Dismiss' : 'Retry'}
          </button>
        </div>
      )}

      {runTab === 'overview' ? (
        <div className={styles.body}>
          {live ? (
            <>
              <div className={styles.liveBanner}>
                <Spinner size={12} />
                <span>Live run · updates appear as Playwright reports them</span>
              </div>
              {live.attempts.length > 0 ? (
                live.attempts.map((attempt) => (
                  <AttemptCard key={attempt.attemptId} attempt={attempt} />
                ))
              ) : (
                <div className={styles.loading} role="status">
                  <Spinner size={12} />
                  Waiting for the first attempt…
                </div>
              )}
            </>
          ) : runLoading && !runDetail ? (
            loadingBody
          ) : (
            <>
              {failed && runError && (
                <div className={styles.failureCard}>
                  <code>
                    {runError.split('\n').find((line) => line.trim()) ?? 'This run failed.'}
                  </code>
                  <Button
                    variant="danger-outline"
                    size={30}
                    padX={10}
                    onClick={() => onTabChange('trace')}
                  >
                    <Icon name="eye" size={12} />
                    Open Trace Viewer
                  </Button>
                </div>
              )}
              {selectedAttempt ? (
                <AttemptCard key={selectedAttempt.id} attempt={selectedAttempt} />
              ) : runDetail ? (
                <div className={styles.tabEmpty}>
                  No attempt-level evidence was retained for this run.
                </div>
              ) : null}
              {customArtifacts.length > 0 && (
                <section>
                  <div className={styles.sectionHeading}>
                    <h3>Attachments</h3>
                    <span>{customArtifacts.length} retained</span>
                  </div>
                  <ArtifactList
                    artifacts={customArtifacts}
                    selectedId={null}
                    onSelect={(artifact) =>
                      void window.wrightbench?.attachments.open(artifact.path)
                    }
                  />
                </section>
              )}
            </>
          )}
        </div>
      ) : runTab === 'video' ? (
        <div className={primaryVideo ? `${styles.body} ${styles.videoBody}` : styles.body}>
          {runLoading && !runDetail ? (
            loadingBody
          ) : primaryVideo ? (
            <>
              {videoHost?.artifactId === primaryVideo.id ? (
                <section
                  className={`${styles.artifactPreview} ${styles.videoPreview}`}
                  aria-label={`${primaryVideo.name} preview`}
                  style={videoRatio ? ({ '--video-ar': videoRatio } as CSSProperties) : undefined}
                >
                  <header>
                    <div>
                      <strong>{primaryVideo.name || primaryVideo.fileName}</strong>
                      <span>
                        video · {formatBytes(primaryVideo.sizeBytes)}
                        {selectedAttempt && ` · ${attemptName(selectedAttempt)}`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size={26}
                      padX={9}
                      onClick={() => void window.wrightbench?.attachments.open(primaryVideo.path)}
                    >
                      <Icon name="external-link" size={11} />
                      Open externally
                    </Button>
                  </header>
                  <div className={styles.videoStage}>
                    <video
                      src={videoHost.url}
                      controls
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={(event) => {
                        const { videoWidth, videoHeight } = event.currentTarget
                        if (videoWidth > 0 && videoHeight > 0) {
                          setVideoRatio(videoWidth / videoHeight)
                        }
                        setVideoPlaybackError(null)
                      }}
                      onError={(event) => {
                        setVideoPlaybackError(
                          event.currentTarget.error?.message || 'This recording could not be played.'
                        )
                      }}
                    />
                  </div>
                  {videoPlaybackError && (
                    <div className={styles.videoError} role="alert">
                      <Icon name="warning" size={12} />
                      <span>{videoPlaybackError} Try opening the retained file externally.</span>
                    </div>
                  )}
                </section>
              ) : hostError?.tab !== 'video' ? (
                <div className={styles.loading} role="status">
                  <Spinner size={12} />
                  Loading video preview…
                </div>
              ) : null}
              {videoArtifacts.length > 1 && (
                <div className={styles.tabNote}>
                  This attempt retained {videoArtifacts.length} recordings; showing the first.
                </div>
              )}
            </>
          ) : !anyVideo ? (
            <div className={styles.tabEmpty}>
              <Icon name="video" size={16} />
              <h3>No video was retained for this run</h3>
              <p>
                Full evidence records video automatically for browser tests. Lighter capture
                policies and non-browser tests may not produce a recording.
              </p>
            </div>
          ) : (
            <div className={styles.tabEmpty}>
              <Icon name="video" size={16} />
              <h3>
                No video for{' '}
                {selectedAttempt ? attemptName(selectedAttempt) : 'this attempt'}
              </h3>
              <p>Recordings from other attempts of this run stay one click away.</p>
              {attemptsWithKinds(['video']).map((attempt) => (
                <Button
                  key={attempt.id}
                  variant="ghost"
                  size={26}
                  padX={9}
                  onClick={() => onSelectAttempt(attempt.id, attempt.project)}
                >
                  <Icon name="video" size={11} />
                  Show video from {attemptName(attempt)}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : runTab === 'screenshots' ? (
        <div className={styles.body}>
          {runLoading && !runDetail ? (
            loadingBody
          ) : screenshotArtifacts.length > 0 ? (
            <>
              <div className={styles.screensToolbar}>
                <span className={styles.screensCount}>
                  {screenshotArtifacts.length}{' '}
                  {screenshotArtifacts.length === 1 ? 'capture' : 'captures'}
                  {selectedAttempt && ` · ${attemptName(selectedAttempt)}`}
                </span>
                <SegmentedControl
                  variant="rect"
                  segments={[
                    { value: 'gallery', label: 'Gallery', icon: 'grid' },
                    { value: 'list', label: 'List', icon: 'list' }
                  ]}
                  value={screenshotView}
                  onChange={setScreenshotView}
                />
              </div>
              {screenshotView === 'gallery' ? (
                <div className={styles.screenGallery}>
                  {screenshotArtifacts.map((artifact) => {
                    const url = screenshotUrls[artifact.id]
                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        className={styles.screenTile}
                        onClick={() => setLightboxId(artifact.id)}
                      >
                        <span className={styles.screenThumb}>
                          {url ? (
                            <img
                              src={url}
                              alt={artifact.name || artifact.fileName}
                              loading="lazy"
                            />
                          ) : url === null ? (
                            <Icon name="warning" size={14} />
                          ) : (
                            <Spinner size={12} />
                          )}
                        </span>
                        <span className={styles.screenCaption}>
                          <strong>{artifact.name || artifact.fileName}</strong>
                          <small>
                            {artifact.kind} · {formatBytes(artifact.sizeBytes)}
                          </small>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className={styles.screenList}>
                  {screenshotArtifacts.map((artifact) => {
                    const url = screenshotUrls[artifact.id]
                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        className={styles.screenRow}
                        onClick={() => setLightboxId(artifact.id)}
                      >
                        <span className={styles.screenRowThumb}>
                          {url ? (
                            <img
                              src={url}
                              alt={artifact.name || artifact.fileName}
                              loading="lazy"
                            />
                          ) : url === null ? (
                            <Icon name="warning" size={12} />
                          ) : (
                            <Spinner size={11} />
                          )}
                        </span>
                        <span className={styles.screenRowText}>
                          <strong>{artifact.name || artifact.fileName}</strong>
                          <small>
                            {artifact.kind} · {formatBytes(artifact.sizeBytes)}
                          </small>
                        </span>
                        <Icon name="eye" size={11} color="var(--t3)" />
                      </button>
                    )
                  })}
                </div>
              )}
              {lightboxIndex >= 0 && (
                <ScreenshotLightbox
                  artifacts={screenshotArtifacts}
                  urls={screenshotUrls}
                  index={lightboxIndex}
                  attemptCaption={selectedAttempt ? attemptName(selectedAttempt) : null}
                  onNavigate={setLightboxId}
                  onClose={() => setLightboxId(null)}
                />
              )}
            </>
          ) : !anyScreens ? (
            <div className={styles.tabEmpty}>
              <Icon name="image" size={16} />
              <h3>No screenshots were retained for this run</h3>
              <p>
                Full evidence captures browser tests automatically; screenshots attached by
                the test also appear here.
              </p>
            </div>
          ) : (
            <div className={styles.tabEmpty}>
              <Icon name="image" size={16} />
              <h3>
                No screenshots for{' '}
                {selectedAttempt ? attemptName(selectedAttempt) : 'this attempt'}
              </h3>
              <p>Captures from other attempts of this run stay one click away.</p>
              {attemptsWithKinds(SCREEN_KINDS).map((attempt) => (
                <Button
                  key={attempt.id}
                  variant="ghost"
                  size={26}
                  padX={9}
                  onClick={() => onSelectAttempt(attempt.id, attempt.project)}
                >
                  <Icon name="image" size={11} />
                  Show screenshots from {attemptName(attempt)}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.hostBody}>
          {runLoading && !runDetail ? (
            loadingBody
          ) : traceArtifact ? (
            traceHost?.path === traceArtifact.path ? (
              /* one node, two sizes: a class swap promotes it to a full-window
                 overlay without remounting the webview (that would reset the
                 viewer's selection and zoom) */
              <div
                className={traceExpanded ? styles.traceOverlay : styles.traceHost}
                onPointerDown={(e) => {
                  if (traceExpanded && e.target === e.currentTarget) setTraceExpanded(false)
                }}
              >
                <WebviewFrame
                  label={`Trace · ${runName}${selectedAttempt ? ` · ${selectedAttempt.project || 'default'}` : ''}`}
                  actions={
                    <FrameAction
                      title={
                        traceExpanded
                          ? 'Exit enlarged view (Esc)'
                          : 'Enlarge trace viewer'
                      }
                      onClick={() => setTraceExpanded((expanded) => !expanded)}
                    >
                      <Icon name={traceExpanded ? 'collapse' : 'expand'} size={12} />
                    </FrameAction>
                  }
                >
                  <webview src={traceHost.url} className={styles.webview} />
                </WebviewFrame>
              </div>
            ) : hostError?.tab !== 'trace' ? (
              <div className={styles.loading} role="status">
                <Spinner size={12} />
                Starting Playwright's trace viewer…
              </div>
            ) : null
          ) : !anyTrace ? (
            <div className={styles.tabEmpty}>
              <Icon name="eye" size={16} />
              <h3>No trace was retained for this run</h3>
              <p>
                Traces follow the capture policy in Settings. Full evidence records every
                browser test attempt.
              </p>
            </div>
          ) : (
            <div className={styles.tabEmpty}>
              <Icon name="eye" size={16} />
              <h3>
                No trace for{' '}
                {selectedAttempt ? attemptName(selectedAttempt) : 'this attempt'}
              </h3>
              <p>Traces from other attempts of this run stay one click away.</p>
              {attemptsWithKinds(['trace']).map((attempt) => (
                <Button
                  key={attempt.id}
                  variant="ghost"
                  size={26}
                  padX={9}
                  onClick={() => onSelectAttempt(attempt.id, attempt.project)}
                >
                  <Icon name="eye" size={11} />
                  Show trace from {attemptName(attempt)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

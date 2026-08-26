import { useEffect, useRef, useState, type JSX } from 'react'
import { Button } from '@/components/Button/Button'
import { Icon } from '@/components/Icon/Icon'
import { StatusBar, StatusBarItem } from '@/components/StatusBar/StatusBar'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import { useCodegen } from '@/state/codegen'
import type { CodegenInspectorCommand, CodegenInspectorEvent, ProjectInfo } from '@shared/ipc'
import styles from './CodegenView.module.css'

type RecorderWebview = HTMLElement & {
  send?: (channel: string, ...args: unknown[]) => void
  reload?: () => void
}

interface GuestIpcEvent extends Event {
  channel?: string
  args?: unknown[]
}

function isInspectorCommand(value: unknown): value is CodegenInspectorCommand {
  if (typeof value !== 'object' || value === null) return false
  const method = (value as { method?: unknown }).method
  return (
    method === 'clear' ||
    method === 'fileChanged' ||
    method === 'setAutoExpect' ||
    method === 'setMode' ||
    method === 'resume' ||
    method === 'pause' ||
    method === 'step' ||
    method === 'highlightRequested'
  )
}

function InspectorSurface({
  inspectorUrl,
  events,
  onDisplayError
}: {
  inspectorUrl: string
  events: Array<{ revision: number; event: CodegenInspectorEvent }>
  onDisplayError(error: string | null): void
}): JSX.Element {
  const guestRef = useRef<RecorderWebview | null>(null)
  const lastSentRevision = useRef(0)

  useEffect(() => {
    const guest = guestRef.current
    if (!guest) return
    const requestState = (): void => {
      onDisplayError(null)
      void useCodegen.getState().sendCommand({ method: 'wrightbenchReady' })
    }
    const onIpc = (rawEvent: Event): void => {
      const ipcEvent = rawEvent as GuestIpcEvent
      if (ipcEvent.channel === 'wrightbench-recorder-ready') {
        requestState()
        return
      }
      if (ipcEvent.channel !== 'wrightbench-recorder-command') return
      const command = ipcEvent.args?.[0]
      if (isInspectorCommand(command)) void useCodegen.getState().sendCommand(command)
    }
    const onDomReady = (): void => requestState()
    const onFailed = (
      rawEvent: Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
    ): void => {
      // Chromium reports redirected/superseded navigations as aborted.
      if (rawEvent.errorCode === -3 || rawEvent.isMainFrame === false) return
      onDisplayError(rawEvent.errorDescription ?? 'The Playwright Inspector failed to load.')
    }
    const onGone = (): void => {
      onDisplayError('The embedded Playwright Inspector stopped unexpectedly.')
    }
    guest.addEventListener('ipc-message', onIpc)
    guest.addEventListener('dom-ready', onDomReady)
    guest.addEventListener('did-fail-load', onFailed)
    guest.addEventListener('render-process-gone', onGone)
    return () => {
      guest.removeEventListener('ipc-message', onIpc)
      guest.removeEventListener('dom-ready', onDomReady)
      guest.removeEventListener('did-fail-load', onFailed)
      guest.removeEventListener('render-process-gone', onGone)
    }
  }, [inspectorUrl, onDisplayError])

  useEffect(() => {
    const guest = guestRef.current
    if (!guest?.send) return
    for (const item of events) {
      if (item.revision <= lastSentRevision.current) continue
      try {
        guest.send('wrightbench-recorder-event', item.event)
        lastSentRevision.current = item.revision
      } catch {
        // dom-ready will request a complete state replay from the recorder host.
        break
      }
    }
  }, [events])

  return (
    <div className={styles.inspectorSurface}>
      <webview
        ref={guestRef}
        className={styles.webview}
        src={inspectorUrl}
        aria-label="Playwright Inspector"
      />
    </div>
  )
}

function LaunchState({
  status,
  error,
  url,
  onUrlChange,
  onUrlFocus,
  onUrlBlur,
  onStart
}: {
  status: 'idle' | 'starting' | 'stopping' | 'crashed'
  error: string | null
  url: string
  onUrlChange(url: string): void
  onUrlFocus(): void
  onUrlBlur(): void
  onStart(): void
}): JSX.Element {
  const busy = status === 'starting' || status === 'stopping'
  return (
    <div className={styles.emptyState} role={status === 'crashed' ? 'alert' : 'status'}>
      <span className={styles.emptyIcon}>
        {busy ? (
          <Spinner size={12} />
        ) : (
          <Icon name={status === 'crashed' ? 'warning' : 'record'} size={18} />
        )}
      </span>
      <h2>
        {status === 'starting'
          ? 'Starting Playwright Record…'
          : status === 'stopping'
            ? 'Stopping Playwright Record…'
            : status === 'crashed'
              ? 'Record could not start'
              : 'Record with Codegen'}
      </h2>
      <p>
        {status === 'crashed'
          ? error
          : busy
            ? 'The selected project’s Playwright runtime is preparing the browser and Inspector.'
            : 'Wrightbench opens Playwright’s real headed browser and embeds its exact Inspector here.'}
      </p>
      {(status === 'idle' || status === 'crashed') && (
        <form
          className={styles.launchForm}
          onSubmit={(event) => {
            event.preventDefault()
            onStart()
          }}
        >
          <label className={styles.urlField}>
            <Icon name="globe" size={13} color="var(--t3)" />
            <input
              className={styles.urlInput}
              value={url}
              placeholder="https://example.com"
              spellCheck={false}
              onFocus={onUrlFocus}
              onBlur={onUrlBlur}
              onChange={(event) => onUrlChange(event.target.value)}
              aria-label="Initial Record URL"
            />
          </label>
          <Button type="submit" variant="primary" size={34} padX={16}>
            <Icon name={status === 'crashed' ? 'rotate-cw' : 'play'} size={12} />
            {status === 'crashed' ? 'Retry recording' : 'Start recording'}
          </Button>
        </form>
      )}
    </div>
  )
}

export function CodegenView({
  project,
  targetId
}: {
  project: ProjectInfo
  targetId: string | null
}): JSX.Element {
  const status = useCodegen((state) => state.status)
  const url = useCodegen((state) => state.url)
  const browser = useCodegen((state) => state.browser)
  const browserVersion = useCodegen((state) => state.browserVersion)
  const inspectorUrl = useCodegen((state) => state.inspectorUrl)
  const inspectorEvents = useCodegen((state) => state.inspectorEvents)
  const inspectorMode = useCodegen((state) => state.inspectorMode)
  const paused = useCodegen((state) => state.paused)
  const error = useCodegen((state) => state.error)
  const [urlDraft, setUrlDraft] = useState(url)
  const [urlFocused, setUrlFocused] = useState(false)
  const [displayError, setDisplayError] = useState<string | null>(null)
  const store = useCodegen.getState

  const ready = status === 'ready' && inspectorUrl !== null
  const recordingMode =
    inspectorMode === 'recording' ||
    inspectorMode === 'recording-inspecting' ||
    inspectorMode.startsWith('asserting')

  useEffect(() => {
    if (!urlFocused) setUrlDraft(url)
  }, [url, urlFocused])

  useEffect(() => setDisplayError(null), [inspectorUrl])

  const start = (): void => {
    store().setUrl(urlDraft)
    void store().start(project.path, targetId)
  }

  return (
    <div className={styles.root}>
      <main className={styles.main}>
        {ready && displayError === null ? (
          <InspectorSurface
            key={inspectorUrl}
            inspectorUrl={inspectorUrl}
            events={inspectorEvents}
            onDisplayError={setDisplayError}
          />
        ) : ready && displayError !== null ? (
          <div className={styles.emptyState} role="alert">
            <span className={styles.emptyIcon}>
              <Icon name="warning" size={18} />
            </span>
            <h2>Inspector could not be displayed</h2>
            <p>{displayError}</p>
            <Button
              variant="primary"
              size={34}
              padX={16}
              onClick={() => setDisplayError(null)}
            >
              <Icon name="rotate-cw" size={12} />
              Retry Inspector
            </Button>
          </div>
        ) : (
          <LaunchState
            status={status === 'ready' ? 'crashed' : status}
            error={error}
            url={urlDraft}
            onUrlChange={setUrlDraft}
            onUrlFocus={() => setUrlFocused(true)}
            onUrlBlur={() => {
              setUrlFocused(false)
              store().setUrl(urlDraft)
            }}
            onStart={start}
          />
        )}
      </main>

      <StatusBar
        mono={[
          browserVersion ? `${browser} ${browserVersion} · headed browser` : null,
          project.nodeVersion ? `Node ${project.nodeVersion}` : null,
          project.playwrightVersion ? `Playwright v${project.playwrightVersion}` : null
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <StatusBarItem>
          {status === 'starting' || status === 'stopping' ? (
            <>
              <Spinner size={11} />
              {status === 'starting' ? 'Starting Record…' : 'Stopping Record…'}
            </>
          ) : status === 'ready' ? (
            <>
              <StatusDot status={recordingMode && !paused ? 'fail' : 'queued'} />
              {paused
                ? 'Playwright Inspector · paused'
                : recordingMode
                  ? 'Playwright Inspector · recording'
                  : 'Playwright Inspector · browser open'}
            </>
          ) : status === 'crashed' ? (
            <>
              <StatusDot status="fail" />Record unavailable
            </>
          ) : (
            <>
              <StatusDot status="queued" />Record ready
            </>
          )}
        </StatusBarItem>
        {error !== null && <span className={styles.errorNote}>{error}</span>}
      </StatusBar>
    </div>
  )
}

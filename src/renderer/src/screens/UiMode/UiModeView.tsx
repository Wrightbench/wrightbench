import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Button } from '@/components/Button/Button'
import { Icon, LogoMark, type IconName } from '@/components/Icon/Icon'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import { isRunRecipe } from '@/lib/targets'
import { useRun } from '@/state/run'
import {
  shouldAutoStartUiMode,
  useUiMode
} from '@/state/uimode'
import type { ProjectInfo } from '@shared/ipc'
import { uiModeHeaderActionState } from './header-actions'
import styles from './UiModeView.module.css'

function UiModeLaunchState({
  title,
  description,
  actionLabel,
  actionIcon,
  actionTitle,
  actionDisabled = false,
  onAction
}: {
  title: string
  description: string
  actionLabel: string
  actionIcon: IconName
  actionTitle?: string
  actionDisabled?: boolean
  onAction(): void
}): JSX.Element {
  return (
    <div className={styles.launchState}>
      <span className={styles.launchMark}>
        <LogoMark size={52} />
      </span>
      <h2 className={styles.launchTitle}>{title}</h2>
      <p className={styles.launchDescription}>{description}</p>
      <Button
        className={styles.launchAction}
        variant="primary"
        size={34}
        disabled={actionDisabled}
        title={actionTitle}
        onClick={onAction}
      >
        <Icon name={actionIcon} size={12} />
        {actionLabel}
      </Button>
    </div>
  )
}

/** Live native-session ownership controls rendered in the global titlebar. */
export function UiModeHeaderActions(): JSX.Element | null {
  const status = useUiMode((state) => state.status)
  const targetId = useUiMode((state) => state.targetId)
  const recordingSupported = useUiMode((state) => state.recording.supported)
  const run = useUiMode((state) => state.run)
  const restart = useUiMode((state) => state.restart)
  const stop = useUiMode((state) => state.stop)
  const cliRunning = useRun((state) => state.running)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const controls = uiModeHeaderActionState({
    status,
    targetId,
    recordingSupported,
    run,
    cliRunning
  })

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])

  useEffect(() => {
    setOpen(false)
  }, [status])

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return
    if (event.key === 'Escape') {
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  if (!controls.visible) return null

  const sessionLabel =
    run !== null
      ? `Run #${run.runNumber} · ${run.done}/${run.total}`
      : status === 'starting'
        ? 'UI Mode starting'
        : status === 'restarting'
          ? 'UI Mode restarting'
          : status === 'external'
            ? 'External UI Mode'
            : 'UI Mode ready'
  const busy = run !== null || status === 'starting' || status === 'restarting'

  return (
    <div ref={rootRef} className={styles.sessionMenu} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.sessionTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${sessionLabel}; UI Mode session menu`}
        onClick={() => setOpen((value) => !value)}
      >
        {busy ? <Spinner size={11} /> : <StatusDot status={status === 'ready' ? 'pass' : 'queued'} />}
        <span className={styles.sessionLabel}>{sessionLabel}</span>
        <Icon name="chevron-down" size={10} color="var(--t3)" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="UI Mode session actions"
          className={styles.sessionPopover}
        >
          {controls.restartVisible && (
            <button
              type="button"
              role="menuitem"
              className={styles.sessionMenuItem}
              disabled={controls.restartDisabled}
              title={controls.restartReason ?? 'Restart UI Mode'}
              onClick={() => {
                close(false)
                void restart()
              }}
            >
              <Icon name="rotate-cw" size={13} />
              <span className={styles.sessionMenuItemBody}>
                <span>Restart UI Mode</span>
                {controls.restartReason && (
                  <span className={styles.sessionMenuHint}>{controls.restartReason}</span>
                )}
              </span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={`${styles.sessionMenuItem} ${styles.sessionMenuDanger}`}
            onClick={() => {
              close(false)
              void stop()
            }}
          >
            <Icon name="stop" size={10} />
            {status === 'external' ? 'Stop external UI Mode' : 'Stop UI Mode'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Full-width native Playwright UI Mode contextual takeover. The webview is an
 * opaque Playwright-owned surface — Wrightbench adds only its slim integration
 * bar; global mode navigation lives outside this component.
 */
export function UiModeView({
  project,
  targetId,
  active
}: {
  project: ProjectInfo
  targetId: string | null
  active: boolean
}): JSX.Element {
  const status = useUiMode((s) => s.status)
  const sessionPath = useUiMode((s) => s.path)
  const sessionTargetId = useUiMode((s) => s.targetId)
  const url = useUiMode((s) => s.url)
  const error = useUiMode((s) => s.error)
  const recordingSupported = useUiMode((s) => s.recording.supported)
  const recipeMappedToBase = useUiMode((s) => s.recipeMappedToBase)
  const run = useUiMode((s) => s.run)
  const cliRunning = useRun((s) => s.running)
  const targets = useRun((s) => s.targets)
  const open = useUiMode((s) => s.open)
  const restart = useUiMode((s) => s.restart)
  const webviewRef = useRef<HTMLElement | null>(null)
  const wasActiveRef = useRef(false)
  const [webviewError, setWebviewError] = useState<string | null>(null)

  const requestedTarget = targets.find((target) => target.id === targetId) ?? null
  const mappedRecipe = recipeMappedToBase || Boolean(requestedTarget && isRunRecipe(requestedTarget))
  const startEmbedded = (): void => {
    if (!targetId) return
    void open({
      path: project.path,
      targetId,
      // UI Mode inherits the environment Playwright's project resolves.
      profile: null
    })
  }

  useEffect(() => {
    // On demand: entering the contextual takeover starts the exact harness
    // target that produced the visible tree. Target changes replace a
    // hidden idle server instead of silently reusing stale Playwright context.
    const wasActive = wasActiveRef.current
    wasActiveRef.current = active
    if (!active || cliRunning || !targetId) return
    // External and unobservable embedded sessions remain explicit ownership
    // boundaries even if registry state changes underneath the hidden view.
    const identityChanged = sessionPath !== project.path || sessionTargetId !== targetId
    // A recorded CLI run drains an idle embedded server and leaves `stopped`.
    // Re-entering through Debug starts it again, while an explicit Stop made
    // inside this active view remains stopped until the user chooses otherwise.
    if (
      shouldAutoStartUiMode({
        active,
        wasActive,
        status,
        identityChanged,
        opaque: run !== null || (status === 'ready' && !recordingSupported)
      })
    ) {
      startEmbedded()
    }
  }, [
    active,
    status,
    cliRunning,
    project.path,
    targetId,
    sessionPath,
    sessionTargetId,
    run,
    recordingSupported,
    open
  ])

  useEffect(() => {
    if (status !== 'ready' || url === null) {
      setWebviewError(null)
      return
    }
    const guest = webviewRef.current
    if (!guest) return
    const onFailed = (
      event: Event & {
        errorCode?: number
        errorDescription?: string
        isMainFrame?: boolean
      }
    ): void => {
      // Chromium reports redirects/cancelled superseded navigations as -3.
      if (event.errorCode === -3 || event.isMainFrame === false) return
      setWebviewError(event.errorDescription ?? 'The embedded page failed to load.')
    }
    const onGone = (): void => {
      setWebviewError('The embedded UI Mode renderer stopped unexpectedly.')
    }
    guest.addEventListener('did-fail-load', onFailed)
    guest.addEventListener('render-process-gone', onGone)
    return () => {
      guest.removeEventListener('did-fail-load', onFailed)
      guest.removeEventListener('render-process-gone', onGone)
    }
  }, [active, status, url])

  const mustStopExplicitly =
    run !== null ||
    status === 'starting' ||
    status === 'restarting' ||
    status === 'external' ||
    (status === 'ready' && !recordingSupported)

  return (
    <div className={styles.root}>
      {mappedRecipe && (
        <div className={styles.contextNote} role="status">
          <Icon name="warning" size={12} />
          UI Mode opens the full configuration. Run-recipe filters and arguments don’t apply.
        </div>
      )}
      {error && status !== 'crashed' && (
        <div className={styles.sessionError} role="alert">
          <Icon name="warning" size={12} />
          {error}
        </div>
      )}
      <div
        className={styles.surface}
        aria-label={
          status === 'external'
            ? 'Native UI Mode — external window'
            : run !== null
              ? 'Embedded UI Mode — recording'
              : 'Embedded UI Mode'
        }
      >
        {!cliRunning && targetId && status === 'ready' && webviewError === null && url !== null ? (
          <webview ref={webviewRef} className={styles.webview} src={url} />
        ) : (
          <div
            className={styles.emptyState}
            role={status === 'crashed' || webviewError !== null ? 'alert' : 'status'}
            aria-label={status === 'stopped' ? 'UI Mode stopped' : undefined}
          >
            {cliRunning ? (
              <div className={styles.note}>
                UI Mode is unavailable while a Tests run is in progress.
              </div>
            ) : !targetId ? (
              <div className={styles.note}>
                Select a valid Playwright configuration before opening UI Mode.
              </div>
            ) : status === 'ready' && webviewError !== null ? (
              <UiModeLaunchState
                title="UI Mode could not be displayed"
                description={webviewError}
                actionLabel="Retry UI Mode"
                actionIcon="rotate-cw"
                actionDisabled={mustStopExplicitly}
                actionTitle={
                  mustStopExplicitly ? 'Stop UI Mode before replacing this session' : undefined
                }
                onAction={() => void restart()}
              />
            ) : status === 'external' ? (
              <div className={styles.note}>
                <Icon name="external-link" size={18} />
                <strong>Native UI Mode is open in another window</strong>
                <span>
                  Runs in this external debug session aren’t recorded. Wrightbench remains locked
                  until the session exits or you stop it here.
                </span>
              </div>
            ) : status === 'crashed' ? (
              <UiModeLaunchState
                title="UI Mode could not start"
                description={error ?? 'The Playwright session stopped before it became ready.'}
                actionLabel="Retry UI Mode"
                actionIcon="rotate-cw"
                onAction={() => void restart()}
              />
            ) : status === 'stopped' ? (
              <UiModeLaunchState
                title="UI Mode is paused"
                description="Start Playwright’s interactive test runner for this project."
                actionLabel="Start UI Mode"
                actionIcon="play"
                onAction={startEmbedded}
              />
            ) : (
              <div className={styles.note}>
                <span className={styles.noteRow}>
                  <Spinner size={12} />
                  {status === 'restarting' ? 'restarting UI Mode…' : 'starting UI Mode…'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

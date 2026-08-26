import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Button } from '@/components/Button/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog/ConfirmDialog'
import { ContextMenu, type ContextMenuEntry } from '@/components/ContextMenu/ContextMenu'
import { Icon } from '@/components/Icon/Icon'
import { Spinner } from '@/components/StatusDot/StatusDot'
import { useCodegen } from '@/state/codegen'
import { useRun } from '@/state/run'
import { useSidebar } from '@/state/sidebar'
import { uiModeBlocksOtherWork, useUiMode } from '@/state/uimode'
import { useWorkspace } from '@/state/workspace'
import type { ProjectWithHealth } from '@shared/ipc'
import styles from './ProjectSwitcher.module.css'

const WORK_BUSY_NOTE = 'Stop the active session for this project first.'
const RECORD_BUSY_NOTE = 'Recording is active. End the session to switch projects.'
const RUN_BUSY_NOTE = 'A test run is active. Stop it before switching projects.'
const UI_MODE_BUSY_NOTE = 'UI Mode is using this project. Stop UI Mode before switching projects.'

function revealLabel(): string {
  const platform = navigator.platform
  if (platform.includes('Mac')) return 'Reveal in Finder'
  if (platform.includes('Win')) return 'Reveal in File Explorer'
  return 'Open containing folder'
}

function healthLabel(project: ProjectWithHealth): string {
  return project.health.state === 'missing' ? 'Missing' : 'Unavailable'
}

/**
 * Compact project switcher used in global chrome (and retained sidebar
 * previews): the active project as an expandable row, a menu of every
 * workspace project with live filesystem health and project actions.
 * Switching defers entirely to setActiveProject — the run/uimode/codegen
 * stores own the lifecycle.
 */
export function ProjectSwitcher({
  placement = 'sidebar'
}: {
  placement?: 'sidebar' | 'titlebar'
}): JSX.Element {
  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const setActiveProject = useWorkspace((s) => s.setActiveProject)
  const removeProject = useWorkspace((s) => s.removeProject)
  const pickAndInspect = useWorkspace((s) => s.pickAndInspect)
  const scaffold = useWorkspace((s) => s.scaffold)
  const tree = useRun((s) => s.tree)
  const running = useRun((s) => s.running)
  const runPath = useRun((s) => s.path)
  const uiStatus = useUiMode((s) => s.status)
  const uiRun = useUiMode((s) => s.run)
  const uiRecording = useUiMode((s) => s.recording)
  const uiPath = useUiMode((s) => s.path)
  const codegenStatus = useCodegen((s) => s.status)
  const recording = useCodegen((s) => s.recording)
  const codegenPath = useCodegen((s) => s.path)
  const stopRecording = useCodegen((s) => s.stop)

  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<ProjectWithHealth | null>(null)
  const [utilityFor, setUtilityFor] = useState<string | null>(null)
  const [utilityPosition, setUtilityPosition] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const utilityButtonRef = useRef<HTMLButtonElement | null>(null)

  // same resolution the workspace/title bar use, so all three always agree
  const active =
    projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null
  const uiBusy = uiModeBlocksOtherWork({
    status: uiStatus,
    run: uiRun,
    recording: uiRecording
  })
  const busy = running || uiBusy || recording
  const busyNote = recording
    ? RECORD_BUSY_NOTE
    : running
      ? RUN_BUSY_NOTE
      : UI_MODE_BUSY_NOTE

  // which project paths currently own live work (removal is blocked per project)
  const busyPaths = new Set<string>()
  if (running && runPath) busyPaths.add(runPath)
  if (uiBusy && uiPath) busyPaths.add(uiPath)
  if (recording && codegenPath) busyPaths.add(codegenPath)

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }

  // the utility menu never outlives the list it belongs to — closing the
  // switcher by any path (Escape, trigger toggle, selection) drops it too
  useEffect(() => {
    if (!open) {
      setUtilityFor(null)
      setUtilityPosition(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // focus lands on the active project (or the first enabled item) on open
  useEffect(() => {
    if (!open) return
    const target =
      menuRef.current?.querySelector<HTMLButtonElement>('button[data-active]:not(:disabled)') ??
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    target?.focus()
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const selectProject = (id: string): void => {
    close(true)
    // re-clicking the current project must not re-run the switch lifecycle
    if (id !== active?.id) setActiveProject(id)
  }

  const runCommand = (command: () => Promise<void>): void => {
    close(false)
    void command()
  }

  const askRemove = (project: ProjectWithHealth): void => {
    close(false)
    setConfirmRemove(project)
  }

  /** project utility entries (reveal / copy path / refresh / remove) */
  const utilityEntries = (project: ProjectWithHealth): ContextMenuEntry[] => {
    const wb = window.wrightbench
    const healthy = project.health.state === 'available'
    const workBusy = busyPaths.has(project.path)
    const copyPath: ContextMenuEntry = {
      label: 'Copy project path',
      icon: 'copy',
      onSelect: () => {
        void navigator.clipboard.writeText(project.path)
        useSidebar.getState().showCopied()
      }
    }
    const refresh: ContextMenuEntry = {
      label: healthy ? 'Refresh project' : 'Retry',
      icon: 'rotate-cw',
      disabled: workBusy,
      title: workBusy ? WORK_BUSY_NOTE : undefined,
      onSelect: () => {
        void useWorkspace.getState().refreshProjects()
        const run = useRun.getState()
        if (healthy && run.path === project.path) {
          void run.loadTree(true)
        }
      }
    }
    const remove: ContextMenuEntry = {
      label: 'Remove from Wrightbench',
      icon: 'x',
      danger: true,
      disabled: workBusy,
      title: workBusy ? WORK_BUSY_NOTE : undefined,
      onSelect: () => askRemove(project)
    }
    if (!healthy) return [copyPath, refresh, 'separator', remove]
    return [
      {
        label: revealLabel(),
        icon: 'folder',
        onSelect: () => {
          void wb?.project.reveal(project.path)
        }
      },
      copyPath,
      refresh,
      'separator',
      remove
    ]
  }

  return (
    <div
      ref={rootRef}
      className={placement === 'titlebar' ? `${styles.root} ${styles.rootTitlebar}` : styles.root}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={
          placement === 'titlebar'
            ? `${styles.trigger} ${styles.triggerTitlebar}`
            : styles.trigger
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Switch project — current: ${active.name}` : 'Switch project'}
        onClick={() => setOpen((v) => !v)}
      >
        {active && active.health.state !== 'available' ? (
          <Icon name="warning" size={13} color="var(--flaky)" />
        ) : (
          <Icon name="folder" size={13} color="var(--ac-icon)" />
        )}
        <span className={styles.triggerName}>{active?.name ?? 'No project'}</span>
        {active && active.health.state !== 'available' ? (
          <span className={styles.healthLabel} title={active.health.reason ?? undefined}>
            {healthLabel(active)}
          </span>
        ) : active && running ? (
          <Spinner size={12} />
        ) : (
          <span className={styles.count}>
            {active ? (tree ? tree.totalTests : (active.testCount ?? '')) : ''}
          </span>
        )}
        <Icon name="chevron-down" size={11} color="var(--t3)" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Projects"
          className={
            placement === 'titlebar' ? `${styles.menu} ${styles.menuTitlebar}` : styles.menu
          }
        >
          <div className={styles.menuList} role="none">
            {projects.map((project) => {
              const isActive = project.id === active?.id
              const healthy = project.health.state === 'available'
              const disabled = busy && !isActive
              return (
                <div key={project.id} className={styles.itemRow} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    data-active={isActive || undefined}
                    className={isActive ? `${styles.item} ${styles.itemActive}` : styles.item}
                    disabled={disabled}
                    title={disabled ? busyNote : undefined}
                    onClick={() => selectProject(project.id)}
                  >
                    {healthy ? (
                      <Icon
                        name="folder"
                        size={13}
                        color={isActive ? 'var(--ac-icon)' : 'currentColor'}
                      />
                    ) : (
                      <Icon name="warning" size={13} color="var(--flaky)" />
                    )}
                    <span className={styles.itemName}>{project.name}</span>
                    {healthy ? (
                      <span className={styles.count}>
                        {isActive && tree ? tree.totalTests : (project.testCount ?? '')}
                      </span>
                    ) : (
                      <span
                        className={styles.healthLabel}
                        title={project.health.reason ?? undefined}
                      >
                        {healthLabel(project)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.itemAction}
                    aria-haspopup="menu"
                    aria-expanded={utilityFor === project.id}
                    aria-label={`Project actions — ${project.name}`}
                    title="Project actions"
                    onClick={(e) => {
                      utilityButtonRef.current = e.currentTarget
                      // fixed positioning anchored to the button — the menu
                      // list scrolls, so an absolute child would be clipped
                      const rect = e.currentTarget.getBoundingClientRect()
                      setUtilityPosition({ x: rect.right, y: rect.bottom + 2 })
                      setUtilityFor(utilityFor === project.id ? null : project.id)
                    }}
                  >
                    <Icon name="ellipsis" size={12} />
                  </button>
                  {utilityFor === project.id && utilityPosition && (
                    <ContextMenu
                      label={`Actions for ${project.name}`}
                      entries={utilityEntries(project)}
                      position={utilityPosition}
                      align="end"
                      onClose={(returnFocus) => {
                        setUtilityFor(null)
                        if (returnFocus) utilityButtonRef.current?.focus()
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          <div className={styles.separator} role="none" />
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={busy}
            title={busy ? busyNote : undefined}
            onClick={() => runCommand(pickAndInspect)}
          >
            <Icon name="folder" size={13} />
            <span className={styles.itemName}>Import Playwright project…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            disabled={busy}
            title={busy ? busyNote : undefined}
            onClick={() => runCommand(scaffold)}
          >
            <Icon name="plus" size={13} />
            <span className={styles.itemName}>Create a new Playwright project…</span>
          </button>
          {busy && (
            <div className={styles.busyState} aria-live="polite">
              <div className={styles.busyNote}>{busyNote}</div>
              {recording && (
                <Button
                  className={styles.busyAction}
                  variant="danger"
                  size={26}
                  padX={10}
                  role="menuitem"
                  disabled={codegenStatus === 'stopping'}
                  title="Close the Playwright browser and end the Record session"
                  onClick={() => void stopRecording()}
                >
                  {codegenStatus === 'stopping' ? (
                    <Spinner size={11} />
                  ) : (
                    <Icon name="stop" size={9} />
                  )}
                  {codegenStatus === 'stopping' ? 'Ending session…' : 'End session'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {confirmRemove && (
        <ConfirmDialog
          danger
          title={`Remove “${confirmRemove.name}” from Wrightbench?`}
          body="The project’s files will not be changed. Existing run history will be preserved."
          detail={confirmRemove.path}
          confirmLabel="Remove from Wrightbench"
          onConfirm={() => {
            const id = confirmRemove.id
            setConfirmRemove(null)
            void removeProject(id)
            triggerRef.current?.focus()
          }}
          onCancel={() => {
            setConfirmRemove(null)
            triggerRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Button } from '@/components/Button/Button'
import { ContextMenu, type ContextMenuEntry } from '@/components/ContextMenu/ContextMenu'
import { Icon, type IconName } from '@/components/Icon/Icon'
import { Input } from '@/components/Input/Input'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import {
  buildTestFolderTree,
  buildTestLocation,
  buildTestTitleGrep,
  filterTree,
  specRootPath,
  specSummary,
  testKeyOf,
  type TestFolderNode,
  type KnownStatus
} from '@/lib/sidebar'
import { groupTargets, isRunRecipe, targetConfigurationKey } from '@/lib/targets'
import { useCodegen } from '@/state/codegen'
import { clampWidth, useSidebar } from '@/state/sidebar'
import { declStatus, testKey, useActiveTarget, useRun, type TestStatus } from '@/state/run'
import { uiModeBlocksOtherWork, useUiMode } from '@/state/uimode'
import { useWorkspace } from '@/state/workspace'
import type { TestStatusFilter, TestTreeFile } from '@shared/ipc'
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@shared/ipc'
import styles from './Sidebar.module.css'

const STATUS_FILTER_OPTIONS: { value: TestStatusFilter; label: string }[] = [
  { value: 'all', label: 'All tests' },
  { value: 'passed', label: 'Passed' },
  { value: 'failed', label: 'Failed' },
  { value: 'flaky', label: 'Flaky' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'not-run', label: 'Not run' }
]

function StatusFilterSelect({
  value,
  onChange
}: {
  value: TestStatusFilter
  onChange: (value: TestStatusFilter) => void
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const current = STATUS_FILTER_OPTIONS.find((option) => option.value === value)

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    setPosition(null)
    if (returnFocus) triggerRef.current?.focus()
  }

  const entries: ContextMenuEntry[] = STATUS_FILTER_OPTIONS.map((option) => ({
    label: option.label,
    checked: option.value === value,
    onSelect: () => onChange(option.value)
  }))

  return (
    <div className={styles.statusFilterControl}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.statusFilterButton}
        aria-label={`Status filter: ${current?.label ?? value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          if (open) {
            close(false)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setPosition({ x: rect.left, y: rect.bottom + 4 })
          setOpen(true)
        }}
      >
        <span>{current?.label ?? value}</span>
        <Icon name="chevron-down" size={11} color="var(--t3)" />
      </button>
      {open && position && (
        <ContextMenu
          label="Test result status"
          entries={entries}
          position={position}
          className={styles.statusFilterMenu}
          onClose={close}
        />
      )}
    </div>
  )
}

function TargetMenuControl({
  label,
  value,
  icon,
  entries
}: {
  label: string
  value: string
  icon: IconName
  entries: ContextMenuEntry[]
}): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  const close = (returnFocus: boolean): void => {
    setOpen(false)
    setPosition(null)
    if (returnFocus) triggerRef.current?.focus()
  }

  return (
    <div className={styles.targetControl}>
      <div className={styles.targetControlLabel}>{label}</div>
      <button
        ref={triggerRef}
        type="button"
        className={styles.targetButton}
        aria-label={`${label}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={value}
        onClick={(event) => {
          if (open) {
            close(false)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setPosition({ x: rect.left, y: rect.bottom + 4 })
          setOpen(true)
        }}
      >
        <Icon name={icon} size={12} color="var(--ac-icon)" />
        <span className={styles.targetButtonLabel}>{value}</span>
        <Icon name="chevron-down" size={11} color="var(--t3)" />
      </button>
      {open && position && (
        <ContextMenu
          label={label}
          entries={entries}
          position={position}
          className={styles.targetMenu}
          onClose={close}
        />
      )}
    </div>
  )
}

/** Configurations choose the inventory; recipes add an optional fixed context. */
function TargetSelect(): JSX.Element | null {
  const targets = useRun((s) => s.targets)
  const activeTargetId = useRun((s) => s.activeTargetId)
  const setActiveTarget = useRun((s) => s.setActiveTarget)
  const pickConfig = useRun((s) => s.pickConfigTarget)
  const busy = useExecutionBusy()
  const groups = groupTargets(targets)
  const active = targets.find((t) => t.id === activeTargetId) ?? targets[0]
  if (!active) return null
  const activeGroup =
    groups.find((group) => group.key === targetConfigurationKey(active)) ?? groups[0]
  if (!activeGroup) return null
  const configurationGroups = groups.filter((group) => group.configuration !== null)
  const showConfiguration = configurationGroups.length > 1
  const showRecipe = activeGroup.configuration !== null && activeGroup.recipes.length > 0
  if (!showConfiguration && !showRecipe) return null

  const configurationEntries: ContextMenuEntry[] = [
    ...configurationGroups.map((group) => {
      const target = group.configuration!
      return {
        label: target.label,
        checked: group.key === activeGroup.key,
        disabled: busy && group.key !== activeGroup.key,
        title: [
          target.cwd === '.' ? null : `in ${target.cwd}`,
          target.playwrightVersion ? `Playwright v${target.playwrightVersion}` : null,
          target.testCount !== null ? `${target.testCount} tests` : null,
          busy && group.key !== activeGroup.key
            ? 'Stop the active session before switching'
            : null
        ]
          .filter(Boolean)
          .join(' · '),
        onSelect: () => {
          if (group.key !== activeGroup.key) void setActiveTarget(target.id)
        }
      }
    }),
    'separator' as const,
    {
      label: 'Choose a config file…',
      icon: 'file' as const,
      disabled: busy,
      title: busy ? 'Stop the active session before switching configurations' : undefined,
      onSelect: () => void pickConfig()
    }
  ]

  const recipeEntries: ContextMenuEntry[] = activeGroup.configuration
    ? [
        {
          label: 'Full suite',
          checked: !isRunRecipe(active),
          disabled: busy && isRunRecipe(active),
          onSelect: () => void setActiveTarget(activeGroup.configuration!.id)
        },
        ...activeGroup.recipes.map((target) => ({
          label: target.label,
          checked: target.id === active.id,
          disabled: busy && target.id !== active.id,
          title: [
            target.playwrightVersion ? `Playwright v${target.playwrightVersion}` : null,
            target.testCount !== null ? `${target.testCount} tests` : null,
            busy && target.id !== active.id ? 'Stop the active session before switching' : null
          ]
            .filter(Boolean)
            .join(' · '),
          onSelect: () => void setActiveTarget(target.id)
        }))
      ]
    : []

  return (
    <div className={styles.targetBlock}>
      {showConfiguration && activeGroup.configuration && (
        <TargetMenuControl
          label="Configuration"
          value={activeGroup.configuration.label}
          icon="file"
          entries={configurationEntries}
        />
      )}
      {showRecipe && (
        <TargetMenuControl
          label="Run recipe"
          value={isRunRecipe(active) ? active.label : 'Full suite'}
          icon="play"
          entries={recipeEntries}
        />
      )}
    </div>
  )
}

function TreeDot({ status }: { status: TestStatus }): JSX.Element {
  if (status === 'running') return <Spinner size={11} />
  if (status === 'none' || status === 'skipped') return <span className={styles.noneDot} aria-hidden />
  if (status === 'queued') return <StatusDot status="queued" />
  return <StatusDot status={status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'flaky'} />
}

/** live status lookup for filtering + rollups */
function useStatusOf(): (key: string) => KnownStatus {
  const decls = useRun((s) => s.decls)
  const statuses = useRun((s) => s.statuses)
  return useMemo(
    () => (key: string) => {
      const decl = decls[key]
      if (decl) return declStatus(decl)
      return statuses[key]?.status ?? 'none'
    },
    [decls, statuses]
  )
}

/** everything that blocks starting a run or mutating the repo right now */
function useExecutionBusy(): boolean {
  const running = useRun((s) => s.running)
  const uiStatus = useUiMode((s) => s.status)
  const uiRun = useUiMode((s) => s.run)
  const uiRecording = useUiMode((s) => s.recording)
  const recording = useCodegen((s) => s.recording)
  return (
    running ||
    uiModeBlocksOtherWork({ status: uiStatus, run: uiRun, recording: uiRecording }) ||
    recording
  )
}

const TREE_INDENT = 14
const MAX_TREE_DEPTH = 6

function depthPadding(depth: number, base: number): number {
  return base + Math.min(depth, MAX_TREE_DEPTH) * TREE_INDENT
}

function TreeRollup({
  summary,
  expanded
}: {
  summary: ReturnType<typeof specSummary>
  expanded: boolean
}): JSX.Element {
  if (summary.running) {
    if (summary.allQueued) return <span className={styles.queuedLabel}>queued</span>
    return (
      <span className={styles.specTrailing}>
        {summary.done}/{summary.total}
        {summary.anyRunning && <Spinner size={11} />}
      </span>
    )
  }
  return (
    <span className={styles.specTrailing}>
      {summary.total}
      {!expanded && <TreeDot status={summary.worst} />}
    </span>
  )
}

function folderStatuses(
  folder: TestFolderNode,
  targetId: string,
  statusOf: (key: string) => KnownStatus
): KnownStatus[] {
  return [
    ...folder.files.flatMap((file) =>
      file.tests.map((test) => statusOf(testKeyOf(test, targetId)))
    ),
    ...folder.folders.flatMap((child) => folderStatuses(child, targetId, statusOf))
  ]
}

function folderPaths(folders: readonly TestFolderNode[]): string[] {
  return folders.flatMap((folder) => [folder.path, ...folderPaths(folder.folders)])
}

function FolderHeader({
  folder,
  targetId,
  depth,
  expanded,
  onToggle,
  statusOf
}: {
  folder: TestFolderNode
  targetId: string
  depth: number
  expanded: boolean
  onToggle: () => void
  statusOf: (key: string) => KnownStatus
}): JSX.Element {
  const summary = specSummary(folderStatuses(folder, targetId, statusOf))
  const classes = [
    styles.folderRow,
    expanded ? styles.folderRowExpanded : '',
    summary.allQueued ? styles.specRowQueued : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      style={{ paddingLeft: depthPadding(depth, 6) }}
      data-tree-row="true"
      aria-label={`Folder ${folder.path}`}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' && !expanded) {
          event.preventDefault()
          onToggle()
        } else if (event.key === 'ArrowLeft' && expanded) {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <Icon
        name={expanded ? 'chevron-down-tree' : 'chevron-right'}
        size={11}
        color={expanded ? 'var(--t2)' : 'currentColor'}
      />
      <Icon name="folder" size={12} color={expanded ? 'var(--ac-icon)' : 'currentColor'} />
      <span className={styles.specName}>{folder.name}</span>
      <TreeRollup summary={summary} expanded={expanded} />
    </button>
  )
}

function SpecHeader({
  file,
  targetId,
  displayName,
  depth = 0,
  expanded,
  onToggle,
  statusOf
}: {
  file: TestTreeFile
  targetId: string
  displayName?: string
  depth?: number
  expanded: boolean
  onToggle: () => void
  statusOf: (key: string) => KnownStatus
}): JSX.Element {
  const summary = specSummary(file.tests.map((t) => statusOf(testKeyOf(t, targetId))))

  const classes = [
    styles.specRow,
    expanded ? styles.specRowExpanded : '',
    summary.allQueued ? styles.specRowQueued : ''
  ]
    .filter(Boolean)
    .join(' ')

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowRight' && !expanded) {
      event.preventDefault()
      onToggle()
    } else if (event.key === 'ArrowLeft' && expanded) {
      event.preventDefault()
      onToggle()
    }
  }

  return (
    <button
      type="button"
      className={classes}
      style={{ paddingLeft: depthPadding(depth, 6) }}
      data-tree-row="true"
      aria-label={`Spec file ${file.file}`}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <Icon
        name={expanded ? 'chevron-down-tree' : 'chevron-right'}
        size={11}
        color={expanded ? 'var(--t2)' : 'currentColor'}
      />
      <span className={styles.specName}>{displayName ?? file.file}</span>
      <TreeRollup summary={summary} expanded={expanded} />
    </button>
  )
}

interface TestMenuState {
  key: string
  file: string
  line: number
  column: number
  title: string
  titlePath: string[]
  /** viewport coordinates (pointer, or the trigger button's corner) */
  position: { x: number; y: number }
  /** 'end' when anchored to the row's menu button */
  align?: 'start' | 'end'
}

function TestRow({
  file,
  test,
  depth = 0,
  busy,
  busyTitle,
  onOpenMenu
}: {
  file: string
  test: TestTreeFile['tests'][number]
  depth?: number
  busy: boolean
  /** why run actions are disabled (session active, or target not runnable) */
  busyTitle: string
  onOpenMenu: (menu: TestMenuState) => void
}): JSX.Element {
  const targetId = useRun((s) => s.tree?.targetId ?? s.activeTargetId)
  const key = testKey(test, targetId)
  const decl = useRun((s) => s.decls[key])
  const final = useRun((s) => s.statuses[key])
  const selected = useRun((s) => s.selectedKey === key)
  const select = useRun((s) => s.select)
  const startRun = useRun((s) => s.startRun)
  const testDir = useRun((s) => s.tree?.rootDir ?? null)

  const status: TestStatus = decl ? declStatus(decl) : (final?.status ?? 'none')
  const hasResult = final !== undefined
  const classes = [
    styles.testRow,
    status === 'running' ? styles.testRowRunning : '',
    status === 'queued' ? styles.testRowQueued : ''
  ]
    .filter(Boolean)
    .join(' ')

  const runLabel = hasResult ? 'Re-run test' : 'Run test'
  const runTest = (): void => {
    if (busy) return
    void startRun({
      location: buildTestLocation(testDir, test.file, test.line, test.column),
      grep: buildTestTitleGrep(test.titlePath)
    })
  }

  return (
    <div
      className={
        selected ? `${styles.testRowWrap} ${styles.testRowWrapSelected}` : styles.testRowWrap
      }
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu({
          key,
          file,
          line: test.line,
          column: test.column,
          title: test.title,
          titlePath: test.titlePath,
          position: { x: e.clientX, y: e.clientY }
        })
      }}
    >
      <button
        type="button"
        className={classes}
        style={{ paddingLeft: depthPadding(depth, status === 'running' ? 22 : 24) }}
        data-tree-row="true"
        aria-current={selected ? 'true' : undefined}
        onClick={() => select(key)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !selected) return
          event.preventDefault()
          select(null)
        }}
      >
        <TreeDot status={status} />
        <span className={styles.testTitle}>{test.title}</span>
      </button>
      <button
        type="button"
        className={styles.rowAction}
        aria-label={`${runLabel} — ${test.title}`}
        title={busy ? busyTitle : runLabel}
        disabled={busy}
        onClick={runTest}
      >
        <Icon name={hasResult ? 'rotate-cw' : 'play'} size={11} />
      </button>
      <button
        type="button"
        className={styles.rowAction}
        aria-haspopup="menu"
        aria-label={`Test actions — ${test.title}`}
        title="Test actions"
        onClick={(e) => {
          // fixed positioning anchored to the button — the tree scrolls, so
          // an absolutely positioned menu inside it would be clipped
          const rect = e.currentTarget.getBoundingClientRect()
          onOpenMenu({
            key,
            file,
            line: test.line,
            column: test.column,
            title: test.title,
            titlePath: test.titlePath,
            position: { x: rect.right, y: rect.bottom + 2 },
            align: 'end'
          })
        }}
      >
        <Icon name="ellipsis" size={11} />
      </button>
    </div>
  )
}

function TreeNote({
  title,
  detail,
  actionLabel,
  onAction
}: {
  title: string
  /** capped diagnostic cause / suggested recovery under the headline */
  detail?: string | null
  actionLabel?: string
  onAction?: () => void
}): JSX.Element {
  return (
    <div className={styles.treeNote}>
      <span>{title}</span>
      {detail != null && detail !== '' && <span className={styles.treeNoteDetail}>{detail}</span>}
      {actionLabel !== undefined && onAction !== undefined && (
        <Button variant="ghost" muted size={26} padX={8} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

function TestsBlock(): JSX.Element {
  const tree = useRun((s) => s.tree)
  const treeLoading = useRun((s) => s.treeLoading)
  const treeError = useRun((s) => s.treeError)
  const expandedFiles = useRun((s) => s.expandedFiles)
  const toggleFile = useRun((s) => s.toggleFile)
  const setExpandedFiles = useRun((s) => s.setExpandedFiles)
  const loadTree = useRun((s) => s.loadTree)
  const startRun = useRun((s) => s.startRun)
  const openTrace = useRun((s) => s.openTrace)
  const testDir = tree?.rootDir ?? null
  const projectPath = useRun((s) => s.path)
  const treeErrorDetail = useRun((s) => s.treeErrorDetail)
  const treeDiagnostic = useRun((s) => s.treeDiagnostic)
  const statusOf = useStatusOf()
  const busy = useExecutionBusy()
  const activeTarget = useActiveTarget()

  const projects = useWorkspace((s) => s.projects)
  const activeProjectId = useWorkspace((s) => s.activeProjectId)
  const active =
    projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1] ?? null
  const healthy = (active?.health.state ?? 'available') === 'available'

  // run actions stop for live sessions, a vanished folder, or a target the
  // runner cannot faithfully execute yet — never silently the wrong context
  const targetRunnable = activeTarget?.runnable ?? true
  const runBlocked = busy || !healthy || !targetRunnable
  const runBlockedTitle = busy
    ? 'Stop the active session first'
    : !healthy
      ? 'Project folder unavailable'
      : (activeTarget?.runnableReason ?? 'Running this target is not supported yet')

  const query = useSidebar((s) => s.query)
  const statusFilter = useSidebar((s) => s.statusFilter)
  const filterOpen = useSidebar((s) => s.filterOpen)
  const setQuery = useSidebar((s) => s.setQuery)
  const setStatusFilter = useSidebar((s) => s.setStatusFilter)
  const setFilterOpen = useSidebar((s) => s.setFilterOpen)
  const clearFilters = useSidebar((s) => s.clearFilters)
  const noteScroll = useSidebar((s) => s.noteScroll)
  const consumePendingScroll = useSidebar((s) => s.consumePendingScroll)
  const copiedNote = useSidebar((s) => s.copiedNote)
  const showCopied = useSidebar((s) => s.showCopied)

  const [menu, setMenu] = useState<TestMenuState | null>(null)
  const [viewMode, setViewMode] = useState<'folder' | 'flat'>('folder')
  /** folder disclosure is view-only; spec disclosure stays in the persisted run store */
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set())
  /** local, never-persisted collapse while a filter temporarily expands */
  const [filterCollapsed, setFilterCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [filterCollapsedFolders, setFilterCollapsedFolders] = useState<ReadonlySet<string>>(
    new Set()
  )
  const [treeActionsPosition, setTreeActionsPosition] = useState<{
    x: number
    y: number
  } | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const filterToggleRef = useRef<HTMLButtonElement>(null)
  const treeActionsRef = useRef<HTMLButtonElement>(null)

  const filtered = useMemo(
    () => (tree ? filterTree(tree, statusOf, { query, statusFilter }) : null),
    [tree, statusOf, query, statusFilter]
  )
  const folderTree = useMemo(
    () => (filtered ? buildTestFolderTree(filtered.files) : null),
    [filtered]
  )
  const allFolderPaths = useMemo(
    () => (folderTree ? folderPaths(folderTree.folders) : []),
    [folderTree]
  )
  const visibleFolderPaths = viewMode === 'folder' ? allFolderPaths : []
  const filtering = filtered?.filtering ?? false

  // temporary filter expansion resets whenever the filter changes
  useEffect(() => {
    setFilterCollapsed(new Set())
    setFilterCollapsedFolders(new Set())
  }, [query, statusFilter])

  // a similarly named directory in another target is unrelated state
  useEffect(() => {
    setCollapsedFolders(new Set())
  }, [tree?.targetId])

  useEffect(() => {
    setTreeActionsPosition(null)
  }, [tree?.targetId, viewMode])

  // restore the persisted scroll offset once the tree is on screen
  useEffect(() => {
    if (!tree || !treeRef.current) return
    const pending = consumePendingScroll()
    if (pending !== null) treeRef.current.scrollTop = pending
  }, [tree, consumePendingScroll])

  // close a stale row menu if the row disappears (refresh, filter change)
  useEffect(() => {
    if (!menu) return
    const stillThere = filtered?.files.some((f) =>
      f.tests.some((t) => testKey(t, tree?.targetId) === menu.key)
    )
    if (!stillThere) setMenu(null)
  }, [filtered, menu])

  const filterActive = filtering || filterOpen

  const onFilterAreaKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    setFilterOpen(false)
    filterToggleRef.current?.focus()
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    const target = event.target as HTMLElement
    if (target.dataset.treeRow !== 'true') return
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-tree-row="true"]')
    )
    const index = rows.indexOf(target as HTMLButtonElement)
    if (index === -1 || rows.length === 0) return
    event.preventDefault()
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : event.key === 'ArrowUp'
            ? Math.max(0, index - 1)
            : Math.min(rows.length - 1, index + 1)
    rows[nextIndex]?.focus()
  }

  const menuEntries = (state: TestMenuState): ContextMenuEntry[] => {
    const status = statusOf(state.key)
    const hasResult = status !== 'none' && status !== 'queued' && status !== 'running'
    const failureKnown = status === 'fail' || status === 'flaky'
    const location = buildTestLocation(testDir, state.file, state.line, state.column)
    const grep = buildTestTitleGrep(state.titlePath)
    const rootRelative = specRootPath(testDir, state.file)
    return [
      {
        label: hasResult ? 'Re-run test' : 'Run test',
        icon: hasResult ? ('rotate-cw' as const) : ('play' as const),
        disabled: runBlocked,
        title: runBlocked ? runBlockedTitle : undefined,
        onSelect: () => void startRun({ location, grep })
      },
      {
        label: 'Open latest trace',
        icon: 'eye' as const,
        disabled: !failureKnown,
        title: failureKnown ? undefined : 'No recorded failure for this test',
        onSelect: () => openTrace(state.key, null)
      },
      'separator' as const,
      {
        label: 'Open file',
        icon: 'file' as const,
        onSelect: () => {
          if (!projectPath) return
          void window.wrightbench?.project
            .openFile(projectPath, rootRelative)
            .then((result) => {
              if (!result.ok) console.error('open file failed:', result.error)
            })
        }
      },
      {
        label: 'Copy test location',
        icon: 'copy' as const,
        onSelect: () => {
          void navigator.clipboard.writeText(location)
          showCopied()
        }
      }
    ]
  }

  const specExpanded = (file: string): boolean =>
    filtering ? !filterCollapsed.has(file) : Boolean(expandedFiles[file])

  const toggleSpec = (file: string): void => {
    if (!filtering) {
      toggleFile(file)
      return
    }
    setFilterCollapsed((current) => {
      const next = new Set(current)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const folderExpanded = (path: string): boolean =>
    filtering ? !filterCollapsedFolders.has(path) : !collapsedFolders.has(path)

  const toggleFolder = (path: string): void => {
    const update = (current: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    }
    if (filtering) setFilterCollapsedFolders(update)
    else setCollapsedFolders(update)
  }

  const visibleFiles = filtered?.files ?? []
  const canExpandAll =
    visibleFolderPaths.some((path) => !folderExpanded(path)) ||
    visibleFiles.some((file) => !specExpanded(file.file))
  const canCollapseAll =
    visibleFolderPaths.some((path) => folderExpanded(path)) ||
    visibleFiles.some((file) => specExpanded(file.file))
  const treeActionsAvailable = visibleFolderPaths.length > 0 || visibleFiles.length > 0

  const expandAll = (): void => {
    if (filtering) {
      setFilterCollapsed(new Set())
      if (viewMode === 'folder') setFilterCollapsedFolders(new Set())
      return
    }
    setExpandedFiles(visibleFiles.map((file) => file.file))
    if (viewMode === 'folder') setCollapsedFolders(new Set())
  }

  const collapseAll = (): void => {
    if (filtering) {
      setFilterCollapsed(new Set(visibleFiles.map((file) => file.file)))
      if (viewMode === 'folder') setFilterCollapsedFolders(new Set(visibleFolderPaths))
      return
    }
    setExpandedFiles([])
    if (viewMode === 'folder') setCollapsedFolders(new Set(visibleFolderPaths))
  }

  const closeTreeActions = (returnFocus: boolean): void => {
    setTreeActionsPosition(null)
    if (returnFocus) treeActionsRef.current?.focus()
  }

  const renderSpec = (file: TestTreeFile, depth: number, basenameOnly: boolean): JSX.Element => {
    const expanded = specExpanded(file.file)
    return (
      <div key={`spec:${file.file}`} style={{ display: 'contents' }}>
        <SpecHeader
          file={file}
          targetId={tree!.targetId}
          displayName={basenameOnly ? file.file.split('/').at(-1) : undefined}
          depth={depth}
          expanded={expanded}
          onToggle={() => toggleSpec(file.file)}
          statusOf={statusOf}
        />
        {expanded &&
          file.tests.map((test) => (
            <TestRow
              key={testKey(test, tree!.targetId)}
              file={file.file}
              test={test}
              depth={depth}
              busy={runBlocked}
              busyTitle={runBlockedTitle}
              onOpenMenu={setMenu}
            />
          ))}
      </div>
    )
  }

  const renderFolder = (folder: TestFolderNode, depth: number): JSX.Element => {
    const expanded = folderExpanded(folder.path)
    return (
      <div key={`folder:${folder.path}`} style={{ display: 'contents' }}>
        <FolderHeader
          folder={folder}
          targetId={tree!.targetId}
          depth={depth}
          expanded={expanded}
          onToggle={() => toggleFolder(folder.path)}
          statusOf={statusOf}
        />
        {expanded && (
          <>
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.files.map((file) => renderSpec(file, depth + 1, true))}
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <div className={styles.testsLabel}>
        <span>TESTS</span>
        <span className={styles.testsLabelSide}>
          {copiedNote && <span className={styles.copiedNote}>Copied</span>}
          {filtering && filtered && (
            <span className={styles.matchCount}>{filtered.matchCount}</span>
          )}
          <span className={styles.viewToggle} role="group" aria-label="Test list view">
            <button
              type="button"
              className={
                viewMode === 'folder'
                  ? `${styles.viewToggleButton} ${styles.viewToggleButtonActive}`
                  : styles.viewToggleButton
              }
              aria-label="Folder view"
              aria-pressed={viewMode === 'folder'}
              title="Folder view"
              onClick={() => setViewMode('folder')}
            >
              <Icon
                name="folder"
                size={12}
                color={viewMode === 'folder' ? 'var(--ac-icon)' : 'var(--t3)'}
              />
            </button>
            <button
              type="button"
              className={
                viewMode === 'flat'
                  ? `${styles.viewToggleButton} ${styles.viewToggleButtonActive}`
                  : styles.viewToggleButton
              }
              aria-label="Flat list view"
              aria-pressed={viewMode === 'flat'}
              title="Flat list view"
              onClick={() => setViewMode('flat')}
            >
              <Icon
                name="list"
                size={12}
                color={viewMode === 'flat' ? 'var(--ac-icon)' : 'var(--t3)'}
              />
            </button>
          </span>
          <button
            ref={treeActionsRef}
            type="button"
            className={
              treeActionsPosition
                ? `${styles.treeActionsToggle} ${styles.treeActionsToggleActive}`
                : styles.treeActionsToggle
            }
            aria-label="Tree actions"
            aria-haspopup="menu"
            aria-expanded={treeActionsPosition !== null}
            title="Tree actions"
            disabled={!treeActionsAvailable}
            onClick={(event) => {
              if (treeActionsPosition) {
                closeTreeActions(false)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              setTreeActionsPosition({ x: rect.right, y: rect.bottom + 4 })
            }}
          >
            <Icon
              name="ellipsis"
              size={12}
              color={treeActionsPosition ? 'var(--t1)' : 'var(--t3)'}
            />
          </button>
          <button
            ref={filterToggleRef}
            type="button"
            className={filterActive ? `${styles.filterToggle} ${styles.filterToggleActive}` : styles.filterToggle}
            aria-label={filterOpen ? 'Hide test filters' : 'Filter tests'}
            aria-expanded={filterOpen}
            title="Filter tests"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Icon name="filter" size={13} color={filterActive ? 'var(--ac-icon)' : 'var(--t3)'} />
          </button>
        </span>
      </div>

      {treeActionsPosition && (
        <ContextMenu
          label="Test tree actions"
          entries={[
            {
              label: 'Expand all',
              icon: 'expand',
              disabled: !canExpandAll,
              onSelect: expandAll
            },
            {
              label: 'Collapse all',
              icon: 'collapse',
              disabled: !canCollapseAll,
              onSelect: collapseAll
            }
          ]}
          position={treeActionsPosition}
          align="end"
          className={styles.treeActionsMenu}
          anchorRef={treeActionsRef}
          onClose={closeTreeActions}
        />
      )}

      {filterOpen && (
        <div className={styles.filterArea} onKeyDown={onFilterAreaKeyDown}>
          <Input
            icon="search"
            iconSize={11}
            size={26}
            padX={9}
            gap={7}
            fontSize={12}
            surface="card"
            placeholder="Filter tests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter tests"
          />
          <div className={styles.filterRow}>
            <StatusFilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
            />
            {filtering && (
              <Button
                variant="ghost"
                muted
                size={26}
                padX={8}
                className={styles.filterClear}
                onClick={clearFilters}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      )}

      <div
        ref={treeRef}
        className={styles.tree}
        role="group"
        aria-label="Project tests"
        onScroll={(e) => noteScroll(e.currentTarget.scrollTop)}
        onKeyDown={onTreeKeyDown}
      >
        {!healthy ? (
          <TreeNote title="Project folder unavailable" />
        ) : treeLoading && !tree ? (
          <div className={styles.treeNote}>Listing tests…</div>
        ) : treeError && !tree ? (
          <TreeNote
            title={treeError}
            detail={treeDiagnostic?.suggestion ?? treeErrorDetail}
            actionLabel="Retry"
            onAction={() => void loadTree()}
          />
        ) : tree && tree.files.length === 0 ? (
          <TreeNote
            title="No Playwright tests found"
            actionLabel="Retry"
            onAction={() => void loadTree()}
          />
        ) : filtered && filtering && filtered.files.length === 0 ? (
          <TreeNote
            title="No tests match these filters."
            actionLabel={filterOpen ? undefined : 'Clear filters'}
            onAction={filterOpen ? undefined : clearFilters}
          />
        ) : (
          viewMode === 'folder' && folderTree ? (
            <>
              {folderTree.folders.map((folder) => renderFolder(folder, 0))}
              {folderTree.files.map((file) => renderSpec(file, 0, true))}
            </>
          ) : (
            filtered?.files.map((file) => renderSpec(file, 0, false))
          )
        )}
        {menu && (
          <ContextMenu
            label={`Actions for ${menu.title}`}
            entries={menuEntries(menu)}
            position={menu.position}
            align={menu.align}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </>
  )
}

/** the draggable right edge — 1px visible line, wider hit target */
function ResizeHandle(): JSX.Element {
  const width = useSidebar((s) => s.width)
  const setWidth = useSidebar((s) => s.setWidth)
  const commitWidth = useSidebar((s) => s.commitWidth)
  const resetWidth = useSidebar((s) => s.resetWidth)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = { startX: e.clientX, startWidth: width }
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    setWidth(clampWidth(drag.startWidth + (e.clientX - drag.startX)))
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    commitWidth()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      setWidth(clampWidth(width + (e.key === 'ArrowRight' ? 10 : -10)))
      commitWidth()
    } else if (e.key === 'Home') {
      e.preventDefault()
      setWidth(SIDEBAR_MIN_WIDTH)
      commitWidth()
    } else if (e.key === 'End') {
      e.preventDefault()
      setWidth(SIDEBAR_MAX_WIDTH)
      commitWidth()
    }
  }

  return (
    <div
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetWidth}
      onKeyDown={onKeyDown}
      title={`Resize sidebar (double-click: ${SIDEBAR_DEFAULT_WIDTH}px)`}
    />
  )
}

export function Sidebar(): JSX.Element {
  const width = useSidebar((s) => s.width)

  return (
    <div className={styles.sidebar} style={{ width }}>
      <TargetSelect />
      <TestsBlock />
      <ResizeHandle />
    </div>
  )
}

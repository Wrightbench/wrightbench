import {
  declIdentity,
  type TestDecl,
  type ProjectViewContext,
  type TestStatusFilter,
  type TestTree,
  type TestTreeFile
} from '@shared/ipc'

/**
 * Pure sidebar logic — filtering, spec rollups, view-context pruning, test
 * locations. No React, no window: the node test suite exercises this
 * directly, and the components stay thin.
 */

/** the run store's per-test status vocabulary (subset used here) */
export type KnownStatus = 'pass' | 'fail' | 'flaky' | 'skipped' | 'running' | 'queued' | 'none'

export function testKeyOf(ref: TestDecl, targetId?: string | null): string {
  if (targetId) return declIdentity(targetId, ref)
  return `${ref.file}:${ref.line}:${ref.title}`
}

/**
 * Named Playwright projects that can execute the selected declaration.
 * Configuration order stays stable; unlisted reporter names are appended.
 * Older JSON reporters did not always include projectName per test, so an
 * empty per-test list falls back to the target's declared project names.
 */
export function applicableProjectNames(
  tree: TestTree | null,
  selectedKey: string | null
): string[] {
  if (!tree) return []
  if (!selectedKey) return tree.projectNames

  const selected = tree.files
    .flatMap((file) => file.tests)
    .find((test) => testKeyOf(test, tree.targetId) === selectedKey)
  if (!selected || selected.projects.length === 0) return tree.projectNames

  const applicable = new Set(selected.projects.filter((name) => name !== ''))
  const names = tree.projectNames.filter((name) => applicable.delete(name))
  return [...names, ...applicable]
}

export interface TestFolderNode {
  /** one path segment, not the whole folder path */
  name: string
  /** rootDir-relative folder path, always '/'-separated */
  path: string
  folders: TestFolderNode[]
  /** specs directly inside this folder */
  files: TestTreeFile[]
  /** declarations in this folder and every descendant */
  testCount: number
}

export interface TestFolderTree {
  folders: TestFolderNode[]
  /** specs directly inside rootDir */
  files: TestTreeFile[]
}

interface MutableTestFolder {
  name: string
  path: string
  folders: Map<string, MutableTestFolder>
  files: TestTreeFile[]
}

/**
 * Build an explorer-style hierarchy solely from Playwright's discovered spec
 * paths. This never reads the imported repository, so custom testMatch and
 * generated/virtual listings remain authoritative.
 */
export function buildTestFolderTree(files: TestTreeFile[]): TestFolderTree {
  const root: MutableTestFolder = { name: '', path: '', folders: new Map(), files: [] }

  for (const file of files) {
    const segments = file.file.split('/').filter(Boolean)
    if (segments.length <= 1) {
      root.files.push(file)
      continue
    }

    segments.pop()
    let parent = root
    for (const segment of segments) {
      const path = parent.path === '' ? segment : `${parent.path}/${segment}`
      let folder = parent.folders.get(segment)
      if (!folder) {
        folder = { name: segment, path, folders: new Map(), files: [] }
        parent.folders.set(segment, folder)
      }
      parent = folder
    }
    parent.files.push(file)
  }

  const finalize = (folder: MutableTestFolder): TestFolderNode => {
    const folders = [...folder.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finalize)
    const directTests = folder.files.reduce((count, file) => count + file.tests.length, 0)
    return {
      name: folder.name,
      path: folder.path,
      folders,
      files: [...folder.files].sort((a, b) => a.file.localeCompare(b.file)),
      testCount: directTests + folders.reduce((count, child) => count + child.testCount, 0)
    }
  }

  const finalized = finalize(root)
  return { folders: finalized.folders, files: finalized.files }
}

/** project-root-relative spec path ('/'-separated) for git comparison */
export function specRootPath(testDir: string | null, file: string): string {
  const normalizedFile = file.replaceAll('\\', '/')
  if (!testDir || testDir === '.') return normalizedFile
  const dir = testDir.replaceAll('\\', '/').replace(/\/+$/, '')
  return `${dir}/${normalizedFile}`
}

/** the runner's positional filter for one test */
export function buildTestLocation(
  testDir: string | null,
  file: string,
  line: number,
  column?: number
): string {
  const suffix = column !== undefined && column > 0 ? `:${line}:${column}` : `:${line}`
  return `${specRootPath(testDir, file)}${suffix}`
}

/** Literal full-title suffix used with a location to select one declaration. */
export function buildTestTitleGrep(titlePath: string[]): string {
  const literal = titlePath.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `${literal}$`
}

export interface TreeFilterInput {
  query: string
  statusFilter: TestStatusFilter
}

export function isFiltering(input: Pick<TreeFilterInput, 'query' | 'statusFilter'>): boolean {
  return input.query.trim() !== '' || input.statusFilter !== 'all'
}

function statusMatches(
  filter: TestStatusFilter,
  status: KnownStatus
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'passed':
      return status === 'pass'
    case 'failed':
      return status === 'fail'
    case 'flaky':
      return status === 'flaky'
    case 'skipped':
      return status === 'skipped'
    case 'not-run':
      return status === 'none'
  }
}

export interface FilteredTree {
  files: TestTreeFile[]
  matchCount: number
  filtering: boolean
}

/**
 * Query and status combine with AND. A spec-path match admits the spec's
 * tests (still status-filtered); otherwise individual titles must match.
 * Case-insensitive, whitespace-trimmed.
 */
export function filterTree(
  tree: TestTree,
  statusOf: (key: string) => KnownStatus,
  input: TreeFilterInput
): FilteredTree {
  const filtering = isFiltering(input)
  if (!filtering) {
    return {
      files: tree.files,
      matchCount: tree.files.reduce((n, f) => n + f.tests.length, 0),
      filtering: false
    }
  }
  const query = input.query.trim().toLowerCase()
  const files: TestTreeFile[] = []
  let matchCount = 0
  for (const file of tree.files) {
    const fileMatches = query === '' || file.file.toLowerCase().includes(query)
    const tests = file.tests.filter((test) => {
      const titleMatches =
        query === '' || fileMatches || test.title.toLowerCase().includes(query)
      if (!titleMatches) return false
      return statusMatches(input.statusFilter, statusOf(testKeyOf(test, tree.targetId)))
    })
    if (tests.length > 0) {
      files.push({ ...file, tests })
      matchCount += tests.length
    }
  }
  return { files, matchCount, filtering: true }
}

export interface SpecSummary {
  total: number
  /** declarations with at least one finished instance (never browser-instance count) */
  done: number
  anyRunning: boolean
  allQueued: boolean
  worst: 'fail' | 'flaky' | 'pass' | 'none'
  running: boolean
}

/** rollup priority: fail > flaky > pass > skipped/not-run */
export function specSummary(statuses: KnownStatus[]): SpecSummary {
  const anyRunning = statuses.includes('running')
  const inRun = statuses.some((s) => s === 'running' || s === 'queued')
  const done = statuses.filter(
    (s) => s === 'pass' || s === 'fail' || s === 'flaky' || s === 'skipped'
  ).length
  return {
    total: statuses.length,
    done,
    anyRunning,
    allQueued: statuses.length > 0 && statuses.every((s) => s === 'queued'),
    worst: statuses.includes('fail')
      ? 'fail'
      : statuses.includes('flaky')
        ? 'flaky'
        : statuses.includes('pass')
          ? 'pass'
          : 'none',
    running: inRun
  }
}

/**
 * Fit a persisted view context to the freshly listed tree: expansion only
 * for specs that still exist, selection only if that exact test still
 * exists. Never resurrects removed entries.
 */
export function pruneViewContext(
  ctx: ProjectViewContext,
  tree: TestTree
): ProjectViewContext {
  const specFiles = new Set(tree.files.map((f) => f.file))
  const validKeys = new Set<string>()
  const legacyMatches = new Map<string, string[]>()
  for (const file of tree.files) {
    for (const test of file.tests) {
      const key = testKeyOf(test, tree.targetId)
      validKeys.add(key)
      const legacy = testKeyOf(test)
      legacyMatches.set(legacy, [...(legacyMatches.get(legacy) ?? []), key])
    }
  }
  const selectedKey =
    ctx.selectedKey !== null && validKeys.has(ctx.selectedKey)
      ? ctx.selectedKey
      : ctx.selectedKey !== null && legacyMatches.get(ctx.selectedKey)?.length === 1
        ? legacyMatches.get(ctx.selectedKey)![0]
        : null
  return {
    ...ctx,
    expandedFiles: ctx.expandedFiles.filter((file) => specFiles.has(file)),
    selectedKey
  }
}

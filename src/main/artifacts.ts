import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent
} from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { ArtifactKind, AttachmentRef, WrightbenchSettings } from '@shared/ipc'
import {
  addArtifactRecord,
  clearRunArtifactRecords,
  deleteRunRecords,
  runStorageRows
} from './db'
import { wrightbenchDir } from './settings'

export interface RunStorageLayout {
  root: string
  outputDir: string
  reportDir: string
  inlineDir: string
}

export interface ArchivedAttachment extends AttachmentRef {
  kind: ArtifactKind
  sizeBytes: number | null
}

export function artifactsRoot(): string {
  return join(wrightbenchDir(), 'artifacts')
}

function projectKey(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
}

export function createRunStorage(projectPath: string, runId: number): RunStorageLayout {
  const root = join(artifactsRoot(), projectKey(projectPath), String(runId))
  const layout = {
    root,
    outputDir: join(root, 'test-results'),
    reportDir: join(root, 'report'),
    inlineDir: join(root, 'inline-attachments')
  }
  mkdirSync(layout.outputDir, { recursive: true })
  mkdirSync(layout.reportDir, { recursive: true })
  mkdirSync(layout.inlineDir, { recursive: true })
  return layout
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return clean.slice(0, 90) || 'artifact'
}

export function classifyArtifact(name: string, contentType: string, path: string): ArtifactKind {
  const lower = `${name} ${basename(path)} ${contentType}`.toLowerCase()
  if (lower.includes('trace') || extname(path).toLowerCase() === '.zip') return 'trace'
  if (lower.includes('diff')) return 'diff'
  if (contentType.startsWith('video/') || /\.(webm|mp4)$/i.test(path)) return 'video'
  if (contentType.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(path)) return 'screenshot'
  return 'custom'
}

function inside(child: string, parent: string): boolean {
  const fullChild = resolve(child)
  const fullParent = resolve(parent)
  return fullChild === fullParent || fullChild.startsWith(fullParent + sep)
}

/** Copy every reported file into the immutable run directory and register it. */
export function archiveAttemptAttachments(
  layout: RunStorageLayout,
  runId: number,
  attemptExternalId: string,
  attachments: AttachmentRef[]
): ArchivedAttachment[] {
  const destDir = join(layout.root, 'attempts', safeSegment(attemptExternalId))
  mkdirSync(destDir, { recursive: true })
  const archived: ArchivedAttachment[] = []
  attachments.forEach((attachment, index) => {
    let sourceSize: number
    try {
      const stat = statSync(attachment.path)
      if (!stat.isFile()) return
      sourceSize = stat.size
    } catch {
      return
    }
    const originalName = safeSegment(basename(attachment.path) || attachment.name)
    const destination = inside(attachment.path, layout.root)
      ? resolve(attachment.path)
      : join(destDir, `${String(index + 1).padStart(2, '0')}-${originalName}`)
    if (destination !== resolve(attachment.path)) {
      try {
        copyFileSync(attachment.path, destination)
      } catch {
        return
      }
    }
    const kind = classifyArtifact(attachment.name, attachment.contentType, destination)
    const item: ArchivedAttachment = {
      name: attachment.name || originalName,
      contentType: attachment.contentType,
      path: destination,
      kind,
      sizeBytes: sourceSize
    }
    archived.push(item)
    addArtifactRecord(runId, attemptExternalId, item)
  })
  return archived
}

function directorySize(path: string): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directorySize(child)
    else if (entry.isFile()) {
      try {
        total += statSync(child).size
      } catch {
        // raced with cleanup
      }
    }
  }
  return total
}

/** Register the run-scoped HTML report once Playwright has finalized it. */
export function registerRunReport(layout: RunStorageLayout, runId: number): void {
  const index = join(layout.reportDir, 'index.html')
  if (!existsSync(index)) return
  addArtifactRecord(runId, null, {
    name: 'HTML report',
    kind: 'report',
    contentType: 'text/html',
    path: index,
    sizeBytes: directorySize(layout.reportDir)
  })
}

function removeOwnedDirectory(path: string | null): number {
  if (!path || !inside(path, artifactsRoot())) return 0
  const bytes = directorySize(path)
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    return 0
  }
  return bytes
}

export interface PruneResult {
  removedRuns: number
  removedArtifacts: number
  freedBytes: number
}

/**
 * Apply history age, evidence age, and storage-budget policies. Evidence can
 * disappear while the compact run/result history remains queryable.
 */
export function pruneArtifactStore(settings: WrightbenchSettings): PruneResult {
  const now = Date.now()
  const runCutoff = now - settings.runRetentionDays * 24 * 60 * 60 * 1000
  const artifactCutoff = now - settings.traceRetentionDays * 24 * 60 * 60 * 1000
  let rows = runStorageRows()
  let removedRuns = 0
  let removedArtifacts = 0
  let freedBytes = 0

  const expiredRuns = rows.filter((row) => row.startedAt < runCutoff)
  for (const row of expiredRuns) freedBytes += removeOwnedDirectory(row.artifactDir)
  removedRuns += deleteRunRecords(expiredRuns.map((row) => row.id))

  rows = runStorageRows()
  for (const row of rows.filter((item) => item.startedAt < artifactCutoff)) {
    freedBytes += removeOwnedDirectory(row.artifactDir)
    removedArtifacts += clearRunArtifactRecords(row.id)
  }

  rows = runStorageRows()
  const sized = rows.map((row) => ({ ...row, bytes: row.artifactDir ? directorySize(row.artifactDir) : 0 }))
  let used = sized.reduce((sum, row) => sum + row.bytes, 0)
  const budget = settings.artifactBudgetGb * 1024 ** 3
  for (const row of sized) {
    if (used <= budget) break
    const freed = removeOwnedDirectory(row.artifactDir)
    used = Math.max(0, used - freed)
    freedBytes += freed
    removedArtifacts += clearRunArtifactRecords(row.id)
  }

  return { removedRuns, removedArtifacts, freedBytes }
}

export function artifactStoreBytes(): number {
  return directorySize(artifactsRoot())
}

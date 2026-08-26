import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { wrightbenchDir } from './settings'
import type {
  ArtifactKind,
  AttachmentRef,
  CaptureMode,
  DurationRegression,
  FlakyTestInfo,
  HistoryAnalytics,
  HistoryDateRange,
  HistoryFilter,
  HistoryRunTest,
  Last20Cell,
  PassRatePoint,
  PersistedTestStatus,
  PersistedArtifact,
  PersistedAttempt,
  PersistedLog,
  PersistedStep,
  RunProjectStatus,
  RunRecord,
  TestInspectorDetail,
  TestAttemptRef,
  TestResultRef,
  TestRunDetail,
  TraceLibEntry
} from '@shared/ipc'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  commit_hash TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  project_filter TEXT NOT NULL DEFAULT 'all',
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  flaky INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  capture_mode TEXT NOT NULL DEFAULT 'full',
  artifact_dir TEXT,
  report_dir TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_path, id);
CREATE TABLE IF NOT EXISTS test_results (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (run_id, file, line, title)
);
CREATE TABLE IF NOT EXISTS attachments (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  title TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_result ON attachments(run_id, file, line, title);
CREATE TABLE IF NOT EXISTS test_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  title TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  retry INTEGER NOT NULL DEFAULT 0,
  worker_index INTEGER,
  parallel_index INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  duration_ms INTEGER,
  error TEXT,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(run_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_attempts_test
  ON test_attempts(run_id, file, line, title, project, retry);
CREATE TABLE IF NOT EXISTS test_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  parent_external_id TEXT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  error TEXT,
  UNIQUE(attempt_id, external_id)
);
CREATE TABLE IF NOT EXISTS test_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES test_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_attempt ON test_logs(attempt_id, sequence);
CREATE TABLE IF NOT EXISTS run_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES test_attempts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  content_type TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  size_bytes INTEGER,
  UNIQUE(run_id, attempt_id, path)
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id, attempt_id);
`

const SCHEMA_VERSION = 2

let db: Database.Database | null = null
let openedPath: string | null = null

/** injectable for tests */
export function openHistoryDb(path?: string): Database.Database {
  if (db) {
    if (path !== undefined && path !== openedPath) {
      throw new Error(`history db already open at ${openedPath}`)
    }
    return db
  }
  const file = path ?? join(wrightbenchDir(), 'history.db')
  if (!path) mkdirSync(wrightbenchDir(), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((row) => row.name)
  )
  const addColumn = (name: string, sql: string): void => {
    if (!columns.has(name)) db!.exec(`ALTER TABLE runs ADD COLUMN ${sql}`)
  }
  addColumn('project_filter', `project_filter TEXT NOT NULL DEFAULT 'all'`)
  addColumn('capture_mode', `capture_mode TEXT NOT NULL DEFAULT 'full'`)
  addColumn('artifact_dir', `artifact_dir TEXT`)
  addColumn('report_dir', `report_dir TEXT`)
  db.pragma(`user_version = ${SCHEMA_VERSION}`)
  openedPath = file
  return db
}

/** app quit/crash can leave runs stuck 'running' — settle them at startup */
export function sweepOrphanRuns(): void {
  openHistoryDb()
    .prepare(
      `UPDATE runs SET status = 'interrupted', finished_at = started_at, duration_ms = 0
       WHERE status = 'running'`
    )
    .run()
}

export function closeHistoryDb(): void {
  db?.close()
  db = null
  openedPath = null
}

export function pruneOldRuns(retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const result = openHistoryDb().prepare(`DELETE FROM runs WHERE started_at < ?`).run(cutoff)
  return result.changes
}

export interface RunStorageRow {
  id: number
  startedAt: number
  artifactDir: string | null
  reportDir: string | null
}

export function runStorageRows(): RunStorageRow[] {
  const rows = openHistoryDb()
    .prepare(
      `SELECT id, started_at, artifact_dir, report_dir FROM runs
       WHERE artifact_dir IS NOT NULL ORDER BY started_at, id`
    )
    .all() as {
    id: number
    started_at: number
    artifact_dir: string | null
    report_dir: string | null
  }[]
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    artifactDir: row.artifact_dir,
    reportDir: row.report_dir
  }))
}

export function deleteRunRecords(ids: number[]): number {
  if (ids.length === 0) return 0
  const database = openHistoryDb()
  const remove = database.prepare(`DELETE FROM runs WHERE id = ?`)
  const tx = database.transaction(() => {
    let count = 0
    for (const id of ids) count += remove.run(id).changes
    return count
  })
  return tx()
}

export function clearRunArtifactRecords(runId: number): number {
  const database = openHistoryDb()
  const tx = database.transaction(() => {
    const modern = database.prepare(`DELETE FROM run_artifacts WHERE run_id = ?`).run(runId).changes
    database.prepare(`DELETE FROM attachments WHERE run_id = ?`).run(runId)
    database
      .prepare(`UPDATE runs SET artifact_dir = NULL, report_dir = NULL WHERE id = ?`)
      .run(runId)
    return modern
  })
  return tx()
}

export function reportDirectoryForRun(projectPath: string, runId: number): string | null {
  const row = openHistoryDb()
    .prepare(`SELECT report_dir FROM runs WHERE id = ? AND project_path = ?`)
    .get(runId, projectPath) as { report_dir: string | null } | undefined
  return row?.report_dir ?? null
}

export interface RunArtifactFile {
  path: string
  contentType: string
  fileName: string
}

/** Resolve only an artifact that belongs to the requested project + run. */
export function artifactFileForRun(
  projectPath: string,
  runId: number,
  artifactId: number
): RunArtifactFile | null {
  const row = openHistoryDb()
    .prepare(
      `SELECT ra.path, ra.content_type
       FROM run_artifacts ra JOIN runs r ON r.id = ra.run_id
       WHERE ra.id = ? AND ra.run_id = ? AND r.project_path = ?`
    )
    .get(artifactId, runId, projectPath) as
    | { path: string; content_type: string }
    | undefined
  if (!row) return null
  return {
    path: row.path,
    contentType: row.content_type,
    fileName: row.path.split(/[\\/]/).pop() ?? 'artifact'
  }
}

/** trace.zip attachments joined with their runs/results, newest first */
export function listTraceAttachments(
  projectPath: string,
  limit: number
): Omit<TraceLibEntry, 'sizeBytes'>[] {
  const rows = openHistoryDb()
    .prepare(
      `SELECT a.path, a.run_id, r.run_number, r.started_at, tr.status, tr.file, tr.line, tr.title
       FROM attachments a
       JOIN runs r ON r.id = a.run_id
       JOIN test_results tr
         ON tr.run_id = a.run_id AND tr.file = a.file AND tr.line = a.line AND tr.title = a.title
       WHERE r.project_path = ? AND a.name = 'trace'
       ORDER BY a.run_id DESC, tr.file, tr.line LIMIT ?`
    )
    .all(projectPath, limit) as {
    path: string
    run_id: number
    run_number: number
    started_at: number
    status: string
    file: string
    line: number
    title: string
  }[]
  return rows.map((row) => ({
    runId: row.run_id,
    runNumber: row.run_number,
    startedAt: row.started_at,
    status: row.status,
    file: row.file,
    line: row.line,
    title: row.title,
    path: row.path
  }))
}

/** distinct artifact paths (all projects) for the storage meter; caller stats */
export function listArtifactPaths(limit = 5000): string[] {
  const rows = openHistoryDb()
    .prepare(
      `SELECT path FROM (
         SELECT path FROM run_artifacts
         UNION
         SELECT path FROM attachments
       ) LIMIT ?`
    )
    .all(limit) as { path: string }[]
  return rows.map((r) => r.path)
}

export function artifactRecordStats(): {
  count: number
  traceBytes: number
  videoBytes: number
  categorizedBytes: number
} {
  const rows = openHistoryDb()
    .prepare(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes
       FROM run_artifacts GROUP BY kind`
    )
    .all() as { kind: string; n: number; bytes: number }[]
  let count = 0
  let traceBytes = 0
  let videoBytes = 0
  let categorizedBytes = 0
  for (const row of rows) {
    count += row.n
    categorizedBytes += row.bytes
    if (row.kind === 'trace') traceBytes += row.bytes
    else if (row.kind === 'video') videoBytes += row.bytes
  }
  return { count, traceBytes, videoBytes, categorizedBytes }
}

export function runTotals(): { totalRuns: number; oldestKeptAt: number | null } {
  const row = openHistoryDb()
    .prepare(`SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM runs`)
    .get() as { n: number; oldest: number | null }
  return { totalRuns: row.n, oldestKeptAt: row.oldest }
}

export function createRun(
  projectPath: string,
  trigger: string,
  commitHash: string | null,
  startedAt: number,
  projectFilter: string = 'all',
  captureMode: CaptureMode = 'full'
): { id: number; runNumber: number } {
  const database = openHistoryDb()
  const insert = database.transaction(() => {
    const row = database
      .prepare(`SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs WHERE project_path = ?`)
      .get(projectPath) as { next: number }
    const result = database
      .prepare(
        `INSERT INTO runs
           (project_path, run_number, trigger, commit_hash, started_at, project_filter, capture_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectPath, row.next, trigger, commitHash, startedAt, projectFilter, captureMode)
    return { id: Number(result.lastInsertRowid), runNumber: row.next }
  })
  return insert()
}

export function setRunStorage(id: number, artifactDir: string, reportDir: string): void {
  openHistoryDb()
    .prepare(`UPDATE runs SET artifact_dir = ?, report_dir = ? WHERE id = ?`)
    .run(artifactDir, reportDir, id)
}

function attemptIdFor(runId: number, externalId: string): number | null {
  const row = openHistoryDb()
    .prepare(`SELECT id FROM test_attempts WHERE run_id = ? AND external_id = ?`)
    .get(runId, externalId) as { id: number } | undefined
  return row?.id ?? null
}

export function beginAttemptRecord(
  runId: number,
  ref: TestAttemptRef,
  startedAt: number
): number {
  const database = openHistoryDb()
  database
    .prepare(
      `INSERT INTO test_attempts
         (run_id, external_id, file, line, title, project, retry, worker_index,
          parallel_index, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
       ON CONFLICT(run_id, external_id) DO UPDATE SET
         worker_index = excluded.worker_index,
         parallel_index = excluded.parallel_index,
         started_at = MIN(test_attempts.started_at, excluded.started_at)`
    )
    .run(
      runId,
      ref.attemptId,
      ref.file,
      ref.line,
      ref.title,
      ref.project,
      ref.retry,
      ref.workerIndex,
      ref.parallelIndex,
      startedAt
    )
  return attemptIdFor(runId, ref.attemptId)!
}

export function finishAttemptRecord(
  runId: number,
  ref: TestAttemptRef,
  data: {
    finishedAt: number
    status: string
    durationMs: number
    error: string | null
    annotations: { type: string; description: string | null }[]
  }
): number {
  const id = beginAttemptRecord(runId, ref, Math.max(0, data.finishedAt - data.durationMs))
  openHistoryDb()
    .prepare(
      `UPDATE test_attempts SET finished_at = ?, status = ?, duration_ms = ?, error = ?,
         annotations_json = ? WHERE id = ?`
    )
    .run(
      data.finishedAt,
      data.status,
      Math.round(data.durationMs),
      data.error,
      JSON.stringify(data.annotations),
      id
    )
  return id
}

export function beginStepRecord(
  runId: number,
  ref: TestAttemptRef,
  step: {
    stepId: string
    parentStepId: string | null
    stepTitle: string
    category: string
    startedAt: number
  }
): void {
  const attemptId = beginAttemptRecord(runId, ref, step.startedAt)
  openHistoryDb()
    .prepare(
      `INSERT INTO test_steps
         (attempt_id, external_id, parent_external_id, title, category, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(attempt_id, external_id) DO UPDATE SET
         parent_external_id = excluded.parent_external_id,
         title = excluded.title,
         category = excluded.category,
         started_at = MIN(test_steps.started_at, excluded.started_at)`
    )
    .run(
      attemptId,
      step.stepId,
      step.parentStepId,
      step.stepTitle,
      step.category,
      step.startedAt
    )
}

export function finishStepRecord(
  runId: number,
  ref: TestAttemptRef,
  step: { stepId: string; durationMs: number; error: string | null }
): void {
  const attemptId = beginAttemptRecord(runId, ref, Date.now() - step.durationMs)
  openHistoryDb()
    .prepare(
      `UPDATE test_steps SET finished_at = started_at + ?, duration_ms = ?, error = ?
       WHERE attempt_id = ? AND external_id = ?`
    )
    .run(Math.round(step.durationMs), Math.round(step.durationMs), step.error, attemptId, step.stepId)
}

export function appendLogRecord(
  runId: number,
  attemptExternalId: string | null,
  sequence: number,
  stream: 'stdout' | 'stderr',
  timestamp: number,
  text: string
): void {
  openHistoryDb()
    .prepare(
      `INSERT INTO test_logs (run_id, attempt_id, sequence, stream, timestamp, text)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      attemptExternalId ? attemptIdFor(runId, attemptExternalId) : null,
      sequence,
      stream,
      timestamp,
      text
    )
}

export function addArtifactRecord(
  runId: number,
  attemptExternalId: string | null,
  artifact: {
    name: string
    kind: ArtifactKind
    contentType: string
    path: string
    sizeBytes: number | null
  }
): number {
  const database = openHistoryDb()
  const attemptId = attemptExternalId ? attemptIdFor(runId, attemptExternalId) : null
  database
    .prepare(
      `INSERT INTO run_artifacts
         (run_id, attempt_id, name, kind, content_type, path, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, attempt_id, path) DO UPDATE SET
         name = excluded.name, kind = excluded.kind,
         content_type = excluded.content_type, size_bytes = excluded.size_bytes`
    )
    .run(
      runId,
      attemptId,
      artifact.name,
      artifact.kind,
      artifact.contentType,
      artifact.path,
      artifact.sizeBytes
    )
  const row = database
    .prepare(
      `SELECT id FROM run_artifacts WHERE run_id = ? AND attempt_id IS ? AND path = ?`
    )
    .get(runId, attemptId, artifact.path) as { id: number }
  return row.id
}

export interface FinishedTestResult {
  file: string
  line: number
  title: string
  status: 'pass' | 'fail' | 'flaky' | 'skipped'
  durationMs: number
  error: string | null
  attachments?: AttachmentRef[]
}

export function finishRunRecord(
  id: number,
  data: {
    finishedAt: number
    status: string
    results: FinishedTestResult[]
  }
): void {
  const database = openHistoryDb()
  const counts = { pass: 0, fail: 0, flaky: 0, skipped: 0 }
  for (const r of data.results) counts[r.status] += 1
  const write = database.transaction(() => {
    database
      .prepare(
        `UPDATE runs SET finished_at = ?, duration_ms = ? - started_at, status = ?,
           passed = ?, failed = ?, flaky = ?, skipped = ?, total = ?
         WHERE id = ?`
      )
      .run(
        data.finishedAt,
        data.finishedAt,
        data.status,
        counts.pass,
        counts.fail,
        counts.flaky,
        counts.skipped,
        data.results.length,
        id
      )
    const insert = database.prepare(
      `INSERT OR REPLACE INTO test_results (run_id, file, line, title, status, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const clearAttachments = database.prepare(
      `DELETE FROM attachments WHERE run_id = ? AND file = ? AND line = ? AND title = ?`
    )
    const insertAttachment = database.prepare(
      `INSERT INTO attachments (run_id, file, line, title, name, content_type, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of data.results) {
      insert.run(id, r.file, r.line, r.title, r.status, Math.round(r.durationMs), r.error)
      clearAttachments.run(id, r.file, r.line, r.title)
      for (const a of r.attachments ?? []) {
        insertAttachment.run(id, r.file, r.line, r.title, a.name, a.contentType, a.path)
      }
    }
  })
  write()
}

interface RunRow {
  id: number
  run_number: number
  trigger: string
  commit_hash: string | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  status: string
  passed: number
  failed: number
  flaky: number
  skipped: number
  total: number
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    runNumber: row.run_number,
    trigger: row.trigger,
    commitHash: row.commit_hash,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status,
    passed: row.passed,
    failed: row.failed,
    flaky: row.flaky,
    skipped: row.skipped,
    total: row.total
  }
}

function runDateWhere(range?: HistoryDateRange, column = 'started_at'): {
  sql: string
  params: number[]
} {
  if (range?.from === null || range?.to === null || range === undefined) {
    return { sql: '', params: [] }
  }
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from > range.to) {
    return { sql: '', params: [] }
  }
  return {
    sql: `AND ${column} >= ? AND ${column} <= ?`,
    params: [Math.trunc(range.from), Math.trunc(range.to)]
  }
}

export function listRuns(
  projectPath: string,
  filter: HistoryFilter,
  limit: number,
  range?: HistoryDateRange
): RunRecord[] {
  const where =
    filter === 'cli'
      ? `AND trigger != 'ui-mode'`
      : filter === 'ui-mode'
        ? `AND trigger = 'ui-mode'`
        : filter === 'failed'
          ? `AND failed > 0`
          : filter === 'flaky'
            ? `AND flaky > 0`
            : filter === 'watch'
              ? `AND trigger = 'watch'`
              : ''
  const date = runDateWhere(range)
  const rows = openHistoryDb()
    .prepare(
      `SELECT * FROM runs WHERE project_path = ? AND status != 'running' ${where} ${date.sql}
       ORDER BY id DESC LIMIT ?`
    )
    .all(projectPath, ...date.params, limit) as RunRow[]
  return rows.map(toRecord)
}

/** Project-level history drill-down: declarations first, evidence on demand. */
export function historyRunTests(projectPath: string, runId: number): HistoryRunTest[] {
  const database = openHistoryDb()
  const run = database
    .prepare(`SELECT id FROM runs WHERE id = ? AND project_path = ? AND status != 'running'`)
    .get(runId, projectPath) as { id: number } | undefined
  if (!run) return []

  const results = database
    .prepare(
      `SELECT file, line, title, status, duration_ms, error
       FROM test_results
       WHERE run_id = ?
       ORDER BY CASE status
         WHEN 'fail' THEN 0 WHEN 'flaky' THEN 1 WHEN 'pass' THEN 2 ELSE 3 END,
         file, line, title`
    )
    .all(runId) as {
    file: string
    line: number
    title: string
    status: string
    duration_ms: number
    error: string | null
  }[]

  const keyOf = (row: { file: string; line: number; title: string }): string =>
    JSON.stringify([row.file, row.line, row.title])
  const attemptCounts = new Map<string, number>()
  const projectStatuses = new Map<string, RunProjectStatus[]>()
  const attempts = database
    .prepare(
      `SELECT file, line, title, project, retry, status
       FROM test_attempts WHERE run_id = ?
       ORDER BY file, line, title, project, retry, id`
    )
    .all(runId) as {
    file: string
    line: number
    title: string
    project: string
    retry: number
    status: string
  }[]

  for (const attempt of attempts) {
    const key = keyOf(attempt)
    attemptCounts.set(key, (attemptCounts.get(key) ?? 0) + 1)
    const projects = projectStatuses.get(key) ?? []
    const status = attemptResultStatus(attempt.status)
    const existing = projects.find((entry) => entry.project === attempt.project)
    if (!existing) {
      projects.push({ project: attempt.project, status })
    } else {
      existing.status =
        status === 'pass' && (existing.status === 'fail' || existing.status === 'flaky')
          ? 'flaky'
          : status
    }
    projectStatuses.set(key, projects)
  }

  const sharedKinds = new Set<ArtifactKind>()
  const kindsByTest = new Map<string, Set<ArtifactKind>>()
  const artifacts = database
    .prepare(
      `SELECT ra.kind, ta.file, ta.line, ta.title
       FROM run_artifacts ra
       LEFT JOIN test_attempts ta ON ta.id = ra.attempt_id
       WHERE ra.run_id = ?
       ORDER BY ra.id`
    )
    .all(runId) as {
    kind: string
    file: string | null
    line: number | null
    title: string | null
  }[]
  for (const artifact of artifacts) {
    const kind = artifactKind(artifact.kind)
    if (artifact.file === null || artifact.line === null || artifact.title === null) {
      sharedKinds.add(kind)
      continue
    }
    const key = keyOf({ file: artifact.file, line: artifact.line, title: artifact.title })
    const kinds = kindsByTest.get(key) ?? new Set<ArtifactKind>()
    kinds.add(kind)
    kindsByTest.set(key, kinds)
  }

  return results.map((result) => {
    const key = keyOf(result)
    return {
      file: result.file,
      line: result.line,
      title: result.title,
      status: resultStatus(result.status),
      durationMs: result.duration_ms,
      attemptCount: attemptCounts.get(key) ?? 0,
      artifactKinds: [...new Set([...sharedKinds, ...(kindsByTest.get(key) ?? [])])],
      projectStatuses: projectStatuses.get(key) ?? [],
      firstErrorLine: firstErrorLine(result.error)
    }
  })
}

/**
 * Sidebar hydration is a projection of retained history, not a second status
 * store. The newest completed run for each legacy file/line/title identity
 * wins; current precise declaration matching remains a renderer concern.
 */
export function latestTestStatuses(projectPath: string): PersistedTestStatus[] {
  return openHistoryDb()
    .prepare(
      `WITH latest AS (
         SELECT tr.file, tr.line, tr.title, MAX(tr.run_id) AS run_id
         FROM test_results tr
         JOIN runs r ON r.id = tr.run_id
         WHERE r.project_path = ? AND r.status != 'running'
         GROUP BY tr.file, tr.line, tr.title
       )
       SELECT tr.file, tr.line, tr.title, tr.status, tr.duration_ms
       FROM latest
       JOIN test_results tr
         ON tr.run_id = latest.run_id
        AND tr.file = latest.file
        AND tr.line = latest.line
        AND tr.title = latest.title
       ORDER BY tr.file, tr.line, tr.title`
    )
    .all(projectPath)
    .map((row) => {
      const result = row as {
        file: string
        line: number
        title: string
        status: string
        duration_ms: number
      }
      return {
        file: result.file,
        line: result.line,
        title: result.title,
        status: resultStatus(result.status),
        durationMs: result.duration_ms
      }
    })
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function startOfWeek(now: number): number {
  const date = new Date(now)
  const day = (date.getDay() + 6) % 7 // Monday = 0
  date.setHours(0, 0, 0, 0)
  return date.getTime() - day * 24 * 60 * 60 * 1000
}

/** Playwright flaky = failed initially, then passed on retry. */
function playwrightFlakePct(outcomes: readonly string[]): number {
  if (outcomes.length === 0) return 0
  const flaky = outcomes.filter((outcome) => outcome === 'flaky').length
  return Math.round((flaky / outcomes.length) * 100)
}

function resultStatus(status: string): Last20Cell['status'] {
  return ['pass', 'fail', 'flaky', 'skipped'].includes(status)
    ? (status as Last20Cell['status'])
    : 'skipped'
}

/** raw reporter attempt status (passed/failed/timedOut/…) → summary status */
function attemptResultStatus(status: string): Last20Cell['status'] {
  if (status === 'passed' || status === 'expected' || status === 'pass') return 'pass'
  if (status === 'skipped') return 'skipped'
  if (status === 'flaky') return 'flaky'
  return 'fail'
}

/** first non-empty stored error line, bounded for list rows */
function firstErrorLine(error: string | null): string | null {
  if (!error) return null
  const line = error.split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? null
  if (line === null) return null
  return line.length > 220 ? `${line.slice(0, 219)}…` : line
}

interface InspectorResultRow {
  run_id: number
  run_number: number
  trigger: string
  commit_hash: string | null
  started_at: number
  finished_at: number | null
  status: string
  duration_ms: number
  error: string | null
  project_filter: string
}

/**
 * Read-only history summary for the selected-test inspector. All retained
 * summaries are returned so renderer date ranges remain exact; analytics
 * still use the bounded recent windows below.
 */
export function testInspector(
  projectPath: string,
  ref: TestResultRef
): TestInspectorDetail | null {
  const rows = openHistoryDb()
    .prepare(
      `SELECT r.id AS run_id, r.run_number, r.trigger, r.commit_hash,
              r.started_at, r.finished_at, r.project_filter,
              tr.status, tr.duration_ms, tr.error
       FROM test_results tr JOIN runs r ON r.id = tr.run_id
       WHERE r.project_path = ? AND r.status != 'running'
         AND tr.file = ? AND tr.line = ? AND tr.title = ?
       ORDER BY r.id DESC`
    )
    .all(projectPath, ref.file, ref.line, ref.title) as InspectorResultRow[]

  if (rows.length === 0) return null
  const newest = rows[0]
  const recent20 = rows.slice(0, 20)
  const executed20 = recent20.filter((row) => row.status !== 'skipped')
  const passRatePct =
    executed20.length === 0
      ? null
      : Math.round(
          (executed20.filter((row) => row.status === 'pass').length / executed20.length) * 1000
        ) / 10
  const executed10 = rows.filter((row) => row.status !== 'skipped').slice(0, 10)
  const failure = rows.find((row) => row.status === 'fail' || row.status === 'flaky')
  const database = openHistoryDb()
  // one bounded query: attempt counts AND per-project rollups both derive from it
  const attemptRows = database
    .prepare(
      `SELECT ta.run_id, ta.project, ta.retry, ta.status
       FROM test_attempts ta JOIN runs r ON r.id = ta.run_id
       WHERE r.project_path = ? AND r.status != 'running'
         AND ta.file = ? AND ta.line = ? AND ta.title = ?
       ORDER BY ta.run_id, ta.project, ta.retry`
    )
    .all(projectPath, ref.file, ref.line, ref.title) as {
    run_id: number
    project: string
    retry: number
    status: string
  }[]
  const attemptCounts = new Map<number, number>()
  const projectStatusesByRun = new Map<number, RunProjectStatus[]>()
  for (const attempt of attemptRows) {
    attemptCounts.set(attempt.run_id, (attemptCounts.get(attempt.run_id) ?? 0) + 1)
    const projects = projectStatusesByRun.get(attempt.run_id) ?? []
    const status = attemptResultStatus(attempt.status)
    const existing = projects.find((entry) => entry.project === attempt.project)
    if (!existing) {
      projects.push({ project: attempt.project, status })
    } else {
      // rows arrive retry-ordered: the final retry wins; a pass after an
      // earlier failure is the project's flaky signal
      existing.status =
        status === 'pass' && (existing.status === 'fail' || existing.status === 'flaky')
          ? 'flaky'
          : status
    }
    projectStatusesByRun.set(attempt.run_id, projects)
  }
  const artifactKindsByRun = new Map<number, ArtifactKind[]>()
  const artifactRows = database
    .prepare(
      `SELECT ra.run_id, ra.kind
       FROM run_artifacts ra
       JOIN runs r ON r.id = ra.run_id
       LEFT JOIN test_attempts ta ON ta.id = ra.attempt_id
       WHERE r.project_path = ? AND r.status != 'running' AND (
         ra.attempt_id IS NULL OR
         (ta.file = ? AND ta.line = ? AND ta.title = ?)
       )
       GROUP BY ra.run_id, ra.kind`
    )
    .all(projectPath, ref.file, ref.line, ref.title) as { run_id: number; kind: string }[]
  for (const row of artifactRows) {
    const kinds = artifactKindsByRun.get(row.run_id) ?? []
    kinds.push(artifactKind(row.kind))
    artifactKindsByRun.set(row.run_id, kinds)
  }
  const runs = rows.map((row) => {
    const status = resultStatus(row.status)
    return {
      runId: row.run_id,
      runNumber: row.run_number,
      status,
      durationMs: row.duration_ms,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      trigger: row.trigger,
      commitHash: row.commit_hash,
      projectFilter: row.project_filter,
      attemptCount: attemptCounts.get(row.run_id) ?? 0,
      artifactKinds: artifactKindsByRun.get(row.run_id) ?? [],
      projectStatuses: projectStatusesByRun.get(row.run_id) ?? [],
      firstErrorLine:
        status === 'fail' || status === 'flaky' ? firstErrorLine(row.error) : null
    }
  })

  return {
    latest: {
      runId: newest.run_id,
      runNumber: newest.run_number,
      status: resultStatus(newest.status),
      durationMs: newest.duration_ms,
      startedAt: newest.started_at,
      finishedAt: newest.finished_at,
      trigger: newest.trigger,
      commitHash: newest.commit_hash
    },
    last20: recent20
      .map((row) => ({
        runId: row.run_id,
        runNumber: row.run_number,
        status: resultStatus(row.status)
      }))
      .reverse(),
    passRatePct,
    flakyPct: playwrightFlakePct(executed10.map((row) => row.status)),
    medianDurationMs: median(executed20.map((row) => row.duration_ms)),
    latestFailure: failure
      ? {
          runId: failure.run_id,
          runNumber: failure.run_number,
          status: failure.status as 'fail' | 'flaky',
          error: failure.error
        }
      : null,
    runs
  }
}

function artifactKind(value: string): ArtifactKind {
  return ['trace', 'screenshot', 'video', 'diff', 'report'].includes(value)
    ? (value as ArtifactKind)
    : 'custom'
}

function parseAnnotations(value: string): { type: string; description: string | null }[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const row = entry as Record<string, unknown>
      if (typeof row.type !== 'string') return []
      return [
        {
          type: row.type,
          description: typeof row.description === 'string' ? row.description : null
        }
      ]
    })
  } catch {
    return []
  }
}

function toArtifact(row: {
  id: number
  attempt_id: number | null
  name: string
  kind: string
  content_type: string
  path: string
  size_bytes: number | null
}): PersistedArtifact {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    name: row.name,
    kind: artifactKind(row.kind),
    contentType: row.content_type,
    path: row.path,
    fileName: row.path.split(/[\\/]/).pop() ?? row.path,
    sizeBytes: row.size_bytes
  }
}

export function testRunDetail(
  projectPath: string,
  runId: number,
  ref: TestResultRef
): TestRunDetail | null {
  const database = openHistoryDb()
  const runRow = database
    .prepare(`SELECT * FROM runs WHERE id = ? AND project_path = ? AND status != 'running'`)
    .get(runId, projectPath) as (RunRow & { capture_mode: string }) | undefined
  if (!runRow) return null
  const testRow = database
    .prepare(
      `SELECT * FROM test_results WHERE run_id = ? AND file = ? AND line = ? AND title = ?`
    )
    .get(runId, ref.file, ref.line, ref.title) as ResultRow | undefined
  if (!testRow) return null

  const attemptRows = database
    .prepare(
      `SELECT * FROM test_attempts
       WHERE run_id = ? AND file = ? AND line = ? AND title = ?
       ORDER BY project, retry, id`
    )
    .all(runId, ref.file, ref.line, ref.title) as {
    id: number
    external_id: string
    project: string
    retry: number
    worker_index: number | null
    parallel_index: number | null
    started_at: number
    finished_at: number | null
    status: string
    duration_ms: number | null
    error: string | null
    annotations_json: string
  }[]

  const attempts: PersistedAttempt[] = attemptRows.map((attempt) => {
    const steps = database
      .prepare(`SELECT * FROM test_steps WHERE attempt_id = ? ORDER BY started_at, id`)
      .all(attempt.id) as {
      id: number
      external_id: string
      parent_external_id: string | null
      title: string
      category: string
      started_at: number
      finished_at: number | null
      duration_ms: number | null
      error: string | null
    }[]
    const logs = database
      .prepare(`SELECT * FROM test_logs WHERE attempt_id = ? ORDER BY sequence, id`)
      .all(attempt.id) as {
      id: number
      stream: string
      text: string
      timestamp: number
    }[]
    const artifacts = database
      .prepare(`SELECT * FROM run_artifacts WHERE attempt_id = ? ORDER BY id`)
      .all(attempt.id) as Parameters<typeof toArtifact>[0][]
    return {
      id: attempt.id,
      externalId: attempt.external_id,
      project: attempt.project,
      retry: attempt.retry,
      workerIndex: attempt.worker_index,
      parallelIndex: attempt.parallel_index,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      status: attempt.status,
      durationMs: attempt.duration_ms,
      error: attempt.error,
      annotations: parseAnnotations(attempt.annotations_json),
      steps: steps.map(
        (step): PersistedStep => ({
          id: step.id,
          externalId: step.external_id,
          parentExternalId: step.parent_external_id,
          title: step.title,
          category: step.category,
          startedAt: step.started_at,
          finishedAt: step.finished_at,
          durationMs: step.duration_ms,
          error: step.error
        })
      ),
      logs: logs.map(
        (log): PersistedLog => ({
          id: log.id,
          stream: log.stream === 'stderr' ? 'stderr' : 'stdout',
          text: log.text,
          timestamp: log.timestamp
        })
      ),
      artifacts: artifacts.map(toArtifact)
    }
  })
  const runArtifacts = database
    .prepare(`SELECT * FROM run_artifacts WHERE run_id = ? AND attempt_id IS NULL ORDER BY id`)
    .all(runId) as Parameters<typeof toArtifact>[0][]

  return {
    run: toRecord(runRow),
    test: {
      file: testRow.file,
      line: testRow.line,
      title: testRow.title,
      status: testRow.status,
      durationMs: testRow.duration_ms,
      error: testRow.error
    },
    captureMode: ['balanced', 'full', 'failures'].includes(runRow.capture_mode)
      ? (runRow.capture_mode as CaptureMode)
      : 'full',
    attempts,
    runArtifacts: runArtifacts.map(toArtifact)
  }
}

export function historyAnalytics(
  projectPath: string,
  seriesLimit = 30,
  range?: HistoryDateRange
): HistoryAnalytics {
  const database = openHistoryDb()
  const date = runDateWhere(range)

  const finished = database
    .prepare(
      `SELECT * FROM runs WHERE project_path = ? AND status != 'running' ${date.sql}
       ORDER BY id DESC`
    )
    .all(projectPath, ...date.params) as RunRow[]

  const priorRange =
    range?.from !== null &&
    range?.to !== null &&
    range !== undefined &&
    Number.isFinite(range.from) &&
    Number.isFinite(range.to) &&
    range.from <= range.to
      ? {
          from: range.from - (range.to - range.from + 1),
          to: range.from - 1
        }
      : undefined
  const priorDate = runDateWhere(priorRange)
  const prior = priorRange
    ? (database
        .prepare(
          `SELECT * FROM runs WHERE project_path = ? AND status != 'running' ${priorDate.sql}
           ORDER BY id DESC`
        )
        .all(projectPath, ...priorDate.params) as RunRow[])
    : []

  const seriesRows = finished.slice(0, seriesLimit)
  const series: PassRatePoint[] = [...seriesRows].reverse().map((row) => {
    const executed = row.passed + row.failed + row.flaky
    return {
      runNumber: row.run_number,
      // a run with nothing executed (all skipped) has no rate — chart gaps it
      rate: executed > 0 ? (row.passed / executed) * 100 : null,
      failed: row.failed,
      flaky: row.flaky
    }
  })

  const executedTotal = finished.reduce((n, r) => n + r.passed + r.failed + r.flaky, 0)
  const passRatePct =
    executedTotal > 0
      ? (finished.reduce((n, r) => n + r.passed, 0) / executedTotal) * 100
      : null

  const durations = finished
    .map((r) => r.duration_ms)
    .filter((d): d is number => d !== null && d > 0)
  const avgDurationMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null

  const priorExecuted = prior.reduce((n, r) => n + r.passed + r.failed + r.flaky, 0)
  const passRatePriorPct =
    priorExecuted > 0 ? (prior.reduce((n, r) => n + r.passed, 0) / priorExecuted) * 100 : null
  const priorDurations = prior
    .map((r) => r.duration_ms)
    .filter((d): d is number => d !== null && d > 0)
  const avgDurationPriorMs =
    priorDurations.length > 0
      ? priorDurations.reduce((a, b) => a + b, 0) / priorDurations.length
      : null

  const weekStart = startOfWeek(Date.now())
  const weekRows = database
    .prepare(
      `SELECT trigger, COUNT(*) AS n FROM runs
       WHERE project_path = ? AND started_at >= ? AND status != 'running' GROUP BY trigger`
    )
    .all(projectPath, weekStart) as { trigger: string; n: number }[]
  const runsThisWeek = weekRows.reduce((a, r) => a + r.n, 0)
  const weekWatch = weekRows.find((r) => r.trigger === 'watch')?.n ?? 0
  const weekManual = runsThisWeek - weekWatch

  const totals = database
    .prepare(
      `SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM runs
       WHERE project_path = ? AND status != 'running'`
    )
    .get(projectPath) as { n: number; oldest: number | null }

  const filterCounts = {
    all: 0,
    failed: (
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE project_path = ? AND status != 'running' AND failed > 0`
        )
        .get(projectPath) as { n: number }
    ).n,
    flaky: (
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE project_path = ? AND status != 'running' AND flaky > 0`
        )
        .get(projectPath) as { n: number }
    ).n,
    watch: (
      database
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE project_path = ? AND status != 'running' AND trigger = 'watch'`
        )
        .get(projectPath) as { n: number }
    ).n
  }

  // per-test outcome history, newest first, bounded to the 25 recent runs
  // (the JS below keeps at most 10/25 entries per test anyway — an unbounded
  // scan would block the main thread on large histories)
  const resultRows = database
    .prepare(
      `SELECT tr.file, tr.line, tr.title, tr.status, tr.duration_ms, r.project_filter
       FROM test_results tr JOIN runs r ON r.id = tr.run_id
       WHERE tr.run_id IN (
         SELECT id FROM runs WHERE project_path = ? AND status != 'running' ${date.sql}
         ORDER BY id DESC LIMIT 25
       ) AND tr.status != 'skipped'
       ORDER BY tr.run_id DESC`
    )
    .all(projectPath, ...date.params) as {
    file: string
    line: number
    title: string
    status: string
    duration_ms: number
    project_filter: string
  }[]

  interface PerTest {
    file: string
    line: number
    title: string
    outcomes: ('pass' | 'fail' | 'flaky')[]
    durations: number[]
  }
  // durations are only comparable between runs with the same --project
  // filter; compare against whatever config the latest run used
  const latestFilter = resultRows[0]?.project_filter ?? 'all'
  const perTest = new Map<string, PerTest>()
  for (const row of resultRows) {
    const key = `${row.file}:${row.line}:${row.title}`
    let entry = perTest.get(key)
    if (!entry) {
      entry = { file: row.file, line: row.line, title: row.title, outcomes: [], durations: [] }
      perTest.set(key, entry)
    }
    // newest-first; keep up to 25 (10 for flakiness, 25 for regressions)
    if (entry.outcomes.length < 10) {
      entry.outcomes.push(
        row.status === 'pass' ? 'pass' : row.status === 'flaky' ? 'flaky' : 'fail'
      )
    }
    if (
      entry.durations.length < 25 &&
      row.duration_ms > 0 &&
      row.project_filter === latestFilter
    ) {
      entry.durations.push(row.duration_ms)
    }
  }

  const flakiest: FlakyTestInfo[] = [...perTest.values()]
    .map((t) => {
      const chronological = [...t.outcomes].reverse()
      const flakyRuns = chronological.filter((outcome) => outcome === 'flaky').length
      return {
        file: t.file,
        line: t.line,
        title: t.title,
        outcomes: chronological,
        flakyRuns,
        flakyPct: playwrightFlakePct(chronological)
      }
    })
    .filter((t) => t.flakyRuns > 0)
    .sort((a, b) => b.flakyPct - a.flakyPct || b.flakyRuns - a.flakyRuns)
    .slice(0, 3)

  const regressions: DurationRegression[] = [...perTest.values()]
    .filter((t) => t.durations.length >= 8)
    .flatMap((t) => {
      // durations are newest-first: median of last 5 vs median of the prior 20
      const recent = median(t.durations.slice(0, 5))
      const prior = median(t.durations.slice(5, 25))
      if (recent === null || prior === null || prior <= 0) return []
      if (recent < prior * 1.25 || recent - prior < 300) return []
      return [
        { file: t.file, line: t.line, title: t.title, beforeMs: prior, afterMs: recent }
      ]
    })
    .sort((a, b) => b.afterMs / b.beforeMs - a.afterMs / a.beforeMs)
    .slice(0, 3)

  filterCounts.all = totals.n

  return {
    passRatePct,
    passRatePriorPct,
    avgDurationMs,
    avgDurationPriorMs,
    flakyCount: [...perTest.values()].filter((t) =>
      t.outcomes.some((outcome) => outcome === 'flaky')
    ).length,
    rangeRuns: finished.length,
    runsThisWeek,
    weekManual,
    weekWatch,
    series,
    flakiest,
    regressions,
    totalRuns: totals.n,
    oldestKeptAt: totals.oldest,
    filterCounts,
    retentionDays: 90
  }
}

interface ResultRow {
  run_id: number
  file: string
  line: number
  title: string
  status: string
  duration_ms: number
  error: string | null
}

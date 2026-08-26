import type { JSX } from 'react'
import { Spinner, StatusDot } from '@/components/StatusDot/StatusDot'
import type { TestStatus } from '@/state/run'
import type { ArtifactKind, TestRunSummary } from '@shared/ipc'
import styles from './RunsShared.module.css'

/**
 * Shared vocabulary of the Runs master-detail surface: the run-scoped tabs,
 * the row/detail status marks, and small formatters used by the list, the
 * detail pane, and the inspector chrome.
 */

/** run-detail tabs: Overview plus the always-present evidence surfaces */
export type RunTab = 'overview' | 'video' | 'screenshots' | 'trace'

/** evidence surfaces a run row can shortcut into */
export type EvidenceKind = Exclude<RunTab, 'overview'>

/** artifact kinds each evidence surface draws from */
export const EVIDENCE_KINDS: Record<EvidenceKind, ArtifactKind[]> = {
  video: ['video'],
  screenshots: ['screenshot', 'diff'],
  trace: ['trace']
}

/** does this recorded run hold anything for an evidence surface? */
export function runHasEvidence(run: TestRunSummary, evidence: EvidenceKind): boolean {
  return run.artifactKinds.some((kind) => EVIDENCE_KINDS[evidence].includes(kind))
}

export function statusLabel(status: TestStatus): string {
  if (status === 'pass') return 'Passed'
  if (status === 'fail') return 'Failed'
  if (status === 'flaky') return 'Flaky'
  if (status === 'skipped') return 'Skipped'
  if (status === 'running') return 'Running'
  if (status === 'queued') return 'Queued'
  return 'Not run'
}

export function StatusMark({ status }: { status: TestStatus }): JSX.Element {
  if (status === 'running') return <Spinner size={12} />
  if (status === 'pass' || status === 'fail' || status === 'flaky') {
    return <StatusDot status={status} />
  }
  if (status === 'queued') return <StatusDot status="queued" />
  return <span className={styles.hollowDot} aria-hidden />
}

export function attemptStatus(status: string): TestStatus {
  if (status === 'passed' || status === 'expected' || status === 'pass') return 'pass'
  if (status === 'failed' || status === 'unexpected' || status === 'timedOut' || status === 'fail') {
    return 'fail'
  }
  if (status === 'flaky') return 'flaky'
  if (status === 'skipped') return 'skipped'
  if (status === 'running') return 'running'
  return 'none'
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay
    ? `Today at ${time}`
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`
}

export function formatTrigger(trigger: string): string {
  if (trigger === 'ui-mode') return 'UI Mode'
  if (trigger === 'rerun-failed') return 'Re-run failed'
  return trigger.charAt(0).toUpperCase() + trigger.slice(1)
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** `Attempt 1` for retry 0, `Retry N` afterwards */
export function attemptLabel(retry: number): string {
  return retry === 0 ? 'Attempt 1' : `Retry ${retry}`
}

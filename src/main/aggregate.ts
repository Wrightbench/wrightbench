import type { AttachmentRef, RunEvent, TestRef } from '@shared/ipc'
import type { FinishedTestResult } from './db'

/**
 * Shared run-result aggregation: the CLI runner and the UI Mode session
 * recorder must persist identical rows for identical reporter events —
 * latest result per (test, Playwright project), worst outcome wins,
 * maximum duration, failing attempt's error/attachments preserved.
 */

/** mirrors the renderer's aggregation: latest result per (test, project) */
export interface RecordedDecl {
  ref: TestRef
  perProject: Map<
    string,
    { outcome: string; duration: number; error: string | null; attachments: AttachmentRef[] }
  >
}

export function outcomeToStatus(outcome: string): FinishedTestResult['status'] {
  if (outcome === 'unexpected') return 'fail'
  if (outcome === 'flaky') return 'flaky'
  if (outcome === 'skipped') return 'skipped'
  return 'pass'
}

const OUTCOME_RANK: Record<string, number> = { unexpected: 3, flaky: 2, expected: 1, skipped: 0 }

/** fold a begin/test-end reporter event into the per-run decl map */
export function recordDeclEvent(decls: Map<string, RecordedDecl>, event: RunEvent): void {
  if (event.type === 'begin') {
    for (const ref of event.scheduled) {
      const key = `${ref.file}:${ref.line}:${ref.title}`
      if (!decls.has(key)) decls.set(key, { ref, perProject: new Map() })
    }
  } else if (event.type === 'test-end') {
    if (event.status === 'interrupted') return
    const key = `${event.file}:${event.line}:${event.title}`
    let decl = decls.get(key)
    if (!decl) {
      decl = { ref: event, perProject: new Map() }
      decls.set(key, decl)
    }
    // a retry replaces outcome/duration, but a passing retry must not erase
    // A passing retry must retain the failed attempt's evidence so flaky-test
    // history and retained traces still explain the preceding failure.
    const previousResult = decl.perProject.get(event.project)
    decl.perProject.set(event.project, {
      outcome: event.outcome,
      duration: event.duration,
      error: event.error ?? previousResult?.error ?? null,
      attachments:
        event.attachments && event.attachments.length > 0
          ? event.attachments
          : (previousResult?.attachments ?? [])
    })
  }
}

export function aggregate(decls: Map<string, RecordedDecl>): FinishedTestResult[] {
  const results: FinishedTestResult[] = []
  for (const decl of decls.values()) {
    if (decl.perProject.size === 0) continue
    let worst: string | null = null
    let worstError: string | null = null
    let worstAttachments: AttachmentRef[] = []
    let duration = 0
    let fallbackError: string | null = null
    let fallbackAttachments: AttachmentRef[] = []
    for (const result of decl.perProject.values()) {
      if (worst === null || (OUTCOME_RANK[result.outcome] ?? 0) > (OUTCOME_RANK[worst] ?? 0)) {
        worst = result.outcome
        worstError = result.error
        worstAttachments = result.attachments
      }
      duration = Math.max(duration, result.duration)
      fallbackError ??= result.error
      if (fallbackAttachments.length === 0) fallbackAttachments = result.attachments
    }
    const error = worstError ?? fallbackError
    results.push({
      file: decl.ref.file,
      line: decl.ref.line,
      title: decl.ref.title,
      status: outcomeToStatus(worst ?? 'expected'),
      durationMs: duration,
      error,
      attachments: worstAttachments.length > 0 ? worstAttachments : fallbackAttachments
    })
  }
  return results
}

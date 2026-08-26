import type { ArtifactKind } from '@shared/ipc'
import type { RunTab } from './RunsShared'

/** Only advertise retained evidence; Overview remains the stable entry point. */
export function runEvidenceTabs(live: boolean, artifactKinds: readonly ArtifactKind[]): RunTab[] {
  if (live) return ['overview']

  const kinds = new Set(artifactKinds)
  const tabs: RunTab[] = ['overview']
  if (kinds.has('video')) tabs.push('video')
  if (kinds.has('screenshot') || kinds.has('diff')) tabs.push('screenshots')
  if (kinds.has('trace')) tabs.push('trace')
  return tabs
}

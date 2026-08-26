import type { UiModeLiveRun, UiModeStatus } from '@/state/uimode'

interface HeaderActionInput {
  status: UiModeStatus
  targetId: string | null
  recordingSupported: boolean
  run: UiModeLiveRun | null
  cliRunning: boolean
}

export interface HeaderActionState {
  visible: boolean
  restartVisible: boolean
  restartDisabled: boolean
  restartReason: string | null
}

/**
 * Derive the entries for the stable UI Mode status menu. Restart remains in
 * place but disables while replacement is unsafe; opaque/external sessions
 * remain Stop-only because Wrightbench cannot safely restart them.
 */
export function uiModeHeaderActionState({
  status,
  targetId,
  recordingSupported,
  run,
  cliRunning
}: HeaderActionInput): HeaderActionState {
  const visible =
    run !== null ||
    status === 'starting' ||
    status === 'ready' ||
    status === 'restarting' ||
    status === 'external'
  const opaque = status === 'external' || (status === 'ready' && !recordingSupported)
  const restartVisible = visible && !opaque

  let restartReason: string | null = null
  if (run !== null) restartReason = 'Available after the current run finishes'
  else if (status === 'starting') restartReason = 'UI Mode is starting'
  else if (status === 'restarting') restartReason = 'UI Mode is restarting'
  else if (cliRunning) restartReason = 'Unavailable while a CLI run is active'
  else if (!targetId) restartReason = 'No UI Mode target is selected'

  return {
    visible,
    restartVisible,
    restartDisabled: restartVisible && restartReason !== null,
    restartReason
  }
}

/**
 * Cross-surface execution ownership for one project. UI Mode is an opaque
 * Playwright client, so the only reliable way to prevent it from racing a
 * Wrightbench CLI run is to stop its server before the CLI child is spawned.
 */

type UiModeStopper = (projectPath: string) => Promise<void>

const cliProjects = new Set<string>()
let stopUiMode: UiModeStopper = async () => {}

/** Wired by index.ts after the UI Mode service is loaded. */
export function setUiModeStopper(stopper: UiModeStopper): void {
  stopUiMode = stopper
}

/**
 * Reserve CLI ownership synchronously, then settle/stop UI Mode before the
 * caller launches Playwright. Returns an idempotent release callback.
 */
export async function beginCliExecution(projectPath: string): Promise<() => void> {
  if (cliProjects.has(projectPath)) {
    throw new Error('a Tests run is already in progress for this project')
  }
  cliProjects.add(projectPath)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    cliProjects.delete(projectPath)
  }
  try {
    await stopUiMode(projectPath)
    return release
  } catch (err) {
    release()
    throw err
  }
}

/** UI Mode sessions cannot start while the Tests runner owns the project. */
export function assertUiModeAvailable(projectPath: string): void {
  if (cliProjects.has(projectPath)) {
    throw new Error('UI Mode is unavailable while a Tests run is in progress')
  }
}

export function isCliExecutionActive(projectPath: string): boolean {
  return cliProjects.has(projectPath)
}

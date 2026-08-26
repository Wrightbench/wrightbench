/** Remove Electron IPC transport noise before an error reaches product UI. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return detail === '' ? 'An unexpected error occurred' : detail
}

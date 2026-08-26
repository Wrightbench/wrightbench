/**
 * Lossless text representation for the Settings environment-profile editor.
 * Physical lines remain KEY=VALUE; backslash, CR and LF inside values are
 * escaped so opening and saving a profile never truncates a secret.
 */

export interface ParsedEnvProfileText {
  env: Record<string, string>
  error: string | null
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

function unescapeValue(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '\\' || index + 1 >= value.length) {
      result += character
      continue
    }
    const next = value[index + 1]
    if (next === '\\') result += '\\'
    else if (next === 'n') result += '\n'
    else if (next === 'r') result += '\r'
    else {
      // Unknown escapes are literal, so Windows paths and regex-like values
      // do not acquire surprising transformations.
      result += `\\${next}`
    }
    index += 1
  }
  return result
}

export function envProfileToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${escapeValue(value)}`)
    .join('\n')
}

export function envProfileFromText(text: string): ParsedEnvProfileText {
  const entries: Array<[string, string]> = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const equals = raw.indexOf('=')
    if (equals <= 0) {
      return { env: {}, error: `Line ${index + 1} must use KEY=VALUE.` }
    }
    const key = raw.slice(0, equals)
    if (seen.has(key)) {
      return { env: {}, error: `Line ${index + 1} repeats ${key}.` }
    }
    seen.add(key)
    entries.push([key, unescapeValue(raw.slice(equals + 1))])
  }
  return { env: Object.fromEntries(entries) as Record<string, string>, error: null }
}

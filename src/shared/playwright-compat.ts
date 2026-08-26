/**
 * Wrightbench's project-level Playwright compatibility contract.
 *
 * Record embeds Playwright's private Inspector protocol, so the product floor
 * is deliberately stricter than the oldest version that can host UI Mode.
 * Keep import, Record, onboarding copy, and compatibility tests on this one
 * policy instead of scattering version literals across processes.
 */
export const MINIMUM_PLAYWRIGHT_VERSION = '1.56.0'

/**
 * Exact releases offered by Create project. Keep this to the latest five
 * Playwright minor lines that have passed Wrightbench's compatibility suite.
 * The 1.56 floor remains a separate legacy architecture anchor for imports.
 */
export const VERIFIED_PLAYWRIGHT_VERSIONS = [
  '1.62.1',
  '1.61.1',
  '1.60.0',
  '1.59.1',
  '1.58.2'
] as const

export const LATEST_VERIFIED_PLAYWRIGHT_VERSION = VERIFIED_PLAYWRIGHT_VERSIONS[0]
export const EXPERIMENTAL_PLAYWRIGHT_TAGS = ['latest', 'next'] as const

export type VerifiedPlaywrightVersion = (typeof VERIFIED_PLAYWRIGHT_VERSIONS)[number]
export type ExperimentalPlaywrightTag = (typeof EXPERIMENTAL_PLAYWRIGHT_TAGS)[number]
export type PlaywrightScaffoldSelection = VerifiedPlaywrightVersion | ExperimentalPlaywrightTag

export interface PlaywrightScaffoldOption {
  value: PlaywrightScaffoldSelection
  channel: 'verified' | 'experimental'
  recommended: boolean
}

export const PLAYWRIGHT_SCAFFOLD_OPTIONS: readonly PlaywrightScaffoldOption[] = [
  ...VERIFIED_PLAYWRIGHT_VERSIONS.map((value, index) => ({
    value,
    channel: 'verified' as const,
    recommended: index === 0
  })),
  ...EXPERIMENTAL_PLAYWRIGHT_TAGS.map((value) => ({
    value,
    channel: 'experimental' as const,
    recommended: false
  }))
]

/** Main-process validation for the renderer-provided scaffold selection. */
export function playwrightScaffoldOption(value: unknown): PlaywrightScaffoldOption | null {
  if (typeof value !== 'string') return null
  return PLAYWRIGHT_SCAFFOLD_OPTIONS.find((option) => option.value === value) ?? null
}

const SUPPORTED_MAJOR = 1
const MINIMUM_MINOR = 56

export type PlaywrightCompatibilityReason =
  | 'missing'
  | 'invalid'
  | 'too-old'
  | 'unsupported-major'

export type PlaywrightCompatibility =
  | { supported: true; reason: null; message: null }
  | { supported: false; reason: PlaywrightCompatibilityReason; message: string }

function parsedVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

/** Whether a project may be imported into Wrightbench. */
export function playwrightCompatibility(version: string | null): PlaywrightCompatibility {
  if (version === null) {
    return {
      supported: false,
      reason: 'missing',
      message:
        'Wrightbench can’t resolve a local Playwright installation for this configuration. Install the project’s dependencies, then retry detection.'
    }
  }

  const parsed = parsedVersion(version)
  if (parsed === null) {
    return {
      supported: false,
      reason: 'invalid',
      message: `Wrightbench can’t verify Playwright v${version}. Install Playwright ${MINIMUM_PLAYWRIGHT_VERSION} or newer within the 1.x release line, then retry detection.`
    }
  }

  if (parsed.major < SUPPORTED_MAJOR || (parsed.major === SUPPORTED_MAJOR && parsed.minor < MINIMUM_MINOR)) {
    return {
      supported: false,
      reason: 'too-old',
      message: `Playwright v${version} is too old for Wrightbench. Upgrade to Playwright ${MINIMUM_PLAYWRIGHT_VERSION} or newer, then retry detection.`
    }
  }

  if (parsed.major !== SUPPORTED_MAJOR) {
    return {
      supported: false,
      reason: 'unsupported-major',
      message: `Playwright v${version} is not supported yet. Wrightbench currently supports Playwright ${MINIMUM_PLAYWRIGHT_VERSION} through the 1.x release line.`
    }
  }

  return { supported: true, reason: null, message: null }
}

export function assertSupportedPlaywright(version: string | null): void {
  const compatibility = playwrightCompatibility(version)
  if (!compatibility.supported) throw new Error(compatibility.message)
}

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type {
  CodeFontChoice,
  CaptureMode,
  Density,
  EnvProfile,
  NodeMode,
  ProjectViewContext,
  TestStatusFilter,
  ThemePreference,
  WrightbenchSettings,
  WorkspaceUiState
} from '@shared/ipc'
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '@shared/ipc'

/** All Wrightbench state lives in ~/.wrightbench — never inside user repos. */
export function wrightbenchDir(): string {
  return join(homedir(), '.wrightbench')
}

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Permissions are advisory on Windows and best-effort everywhere else. */
function chmodPrivateFd(fd: number, mode: number): void {
  if (process.platform === 'win32') return
  try {
    fchmodSync(fd, mode)
  } catch {
    // A read-only or policy-managed home must still be allowed to load.
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
  // Never follow a user-controlled ~/.wrightbench symlink and chmod its target.
  // O_NOFOLLOW closes the lstat/open race on POSIX; lstat also protects hosts
  // where that flag is unavailable or advisory.
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('Wrightbench state directory must be a real directory')
  }
  // Windows does not reliably allow opening a directory as a file descriptor;
  // lstat still rejects reparse-point/symlink state directories there.
  if (process.platform === 'win32') return
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error('Wrightbench state path is not a directory')
    // mkdir's mode is affected by umask and does not tighten an existing dir.
    chmodPrivateFd(fd, PRIVATE_DIR_MODE)
  } finally {
    closeSync(fd)
  }
}

/** Read and tighten a regular settings file without following a symlink. */
function readPrivateFile(path: string): string {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('Wrightbench settings path must be a regular file')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Wrightbench settings path is not a file')
    // Tighten before any profile values are read.
    chmodPrivateFd(fd, PRIVATE_FILE_MODE)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** tmp + rename so a crash mid-write never leaves a corrupt file behind. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const parent = dirname(path)
  ensurePrivateDir(parent)
  // An exclusive, unpredictable temp name prevents a stale permissive file
  // (or symlink) from receiving profile values before chmod can run.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  let fd: number | null = null
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE
    )
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
    chmodPrivateFd(fd, PRIVATE_FILE_MODE)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    renamed = true
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor may already have been closed by a failed write.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp)
      } catch {
        // Nothing to clean up if creation or rename did not leave a temp.
      }
    }
  }
}

export type { EnvProfile }

/** settings.json public shape; saveSettings adds a private migration marker. */
type PersistedSettings = WrightbenchSettings

/** One-time migration marker for the Full-evidence default change. */
const CAPTURE_POLICY_VERSION = 1

function defaultWorkspaceUi(): WorkspaceUiState {
  return { sidebarCollapsed: false, sidebarWidth: SIDEBAR_DEFAULT_WIDTH, projectViews: {} }
}

const DEFAULTS: PersistedSettings = {
  theme: 'system',
  envProfiles: [
    { name: 'staging', env: {} },
    { name: 'production', env: {}, description: 'read-only checks' }
  ],
  defaultProfile: 'staging',
  runRetentionDays: 90,
  traceRetentionDays: 14,
  captureMode: 'full',
  artifactBudgetGb: 5,
  density: 'relaxed',
  codeFont: 'jetbrains-mono',
  nodeMode: 'auto',
  nodePath: '',
  workspaceUi: defaultWorkspaceUi()
}

export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)))
}

const STATUS_FILTERS: readonly TestStatusFilter[] = [
  'all',
  'passed',
  'failed',
  'flaky',
  'skipped',
  'not-run'
]

/** bounded, type-checked per-project view context; null drops the entry */
function sanitizeViewContext(value: unknown): ProjectViewContext | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const expandedFiles = Array.isArray(v.expandedFiles)
    ? v.expandedFiles
        .filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 500)
        .slice(0, 200)
    : []
  return {
    expandedFiles,
    selectedKey:
      typeof v.selectedKey === 'string' && v.selectedKey.length <= 2000 ? v.selectedKey : null,
    query: typeof v.query === 'string' ? v.query.slice(0, 200) : '',
    statusFilter: STATUS_FILTERS.includes(v.statusFilter as TestStatusFilter)
      ? (v.statusFilter as TestStatusFilter)
      : 'all',
    scrollTop:
      typeof v.scrollTop === 'number' && Number.isFinite(v.scrollTop) && v.scrollTop >= 0
        ? Math.min(1_000_000, Math.round(v.scrollTop))
        : 0,
    envProfile:
      typeof v.envProfile === 'string' && v.envProfile.length <= 100 ? v.envProfile : null
  }
}

/** malformed nested values fall back safely — settings.json is user-editable */
export function sanitizeWorkspaceUi(value: unknown): WorkspaceUiState {
  if (typeof value !== 'object' || value === null) return defaultWorkspaceUi()
  const v = value as Record<string, unknown>
  const projectViews: Record<string, ProjectViewContext> = {}
  if (typeof v.projectViews === 'object' && v.projectViews !== null) {
    for (const [id, ctx] of Object.entries(v.projectViews).slice(0, 100)) {
      const clean = sanitizeViewContext(ctx)
      if (clean) projectViews[id] = clean
    }
  }
  return {
    sidebarCollapsed: v.sidebarCollapsed === true,
    sidebarWidth: clampSidebarWidth(v.sidebarWidth),
    projectViews
  }
}

const DENSITIES: readonly Density[] = ['relaxed', 'compact']
const CODE_FONTS: readonly CodeFontChoice[] = ['jetbrains-mono', 'sf-mono', 'menlo']
const NODE_MODES: readonly NodeMode[] = ['auto', 'fixed']
const CAPTURE_MODES: readonly CaptureMode[] = ['balanced', 'full', 'failures']

const MAX_ENV_PROFILES = 50
const MAX_PROFILE_NAME = 100
const MAX_PROFILE_DESCRIPTION = 500
const MAX_PROFILE_VARIABLES = 256
const MAX_ENV_KEY = 256
const MAX_ENV_VALUE = 65_536
// execve permits more than shell identifier syntax. Keep names representable
// by the KEY=VALUE editor while preserving common legacy keys with dots,
// colons, hyphens, or a leading digit.
const ENV_KEY = /^[^=\s#\p{Cc}]+$/u
const CONTROL_CHARACTER = /\p{Cc}/u

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function isEnvProfile(value: unknown): value is EnvProfile {
  if (!isPlainRecord(value)) return false
  const p = value
  if (Object.keys(p).some((key) => key !== 'name' && key !== 'description' && key !== 'env')) {
    return false
  }
  if (
    typeof p.name !== 'string' ||
    p.name.length < 1 ||
    p.name.length > MAX_PROFILE_NAME ||
    p.name !== p.name.trim() ||
    CONTROL_CHARACTER.test(p.name) ||
    !isPlainRecord(p.env)
  ) {
    return false
  }
  if (
    p.description !== undefined &&
    (typeof p.description !== 'string' || p.description.length > MAX_PROFILE_DESCRIPTION)
  ) {
    return false
  }
  const entries = Object.entries(p.env)
  if (entries.length > MAX_PROFILE_VARIABLES) return false
  return entries.every(
    ([key, value]) =>
      key.length >= 1 &&
      key.length <= MAX_ENV_KEY &&
      ENV_KEY.test(key) &&
      typeof value === 'string' &&
      value.length <= MAX_ENV_VALUE &&
      !value.includes('\u0000')
  )
}

/** Complete profile-set validation: bounds plus stable, unique names. */
export function isValidEnvProfiles(value: unknown): value is EnvProfile[] {
  if (!Array.isArray(value) || value.length > MAX_ENV_PROFILES) return false
  if (!value.every(isEnvProfile)) return false
  const names = value.map((profile) => profile.name)
  return new Set(names).size === names.length
}

interface MigratedEnvProfiles {
  profiles: EnvProfile[]
  /** first occurrence wins, matching the old profile lookup semantics */
  names: Map<string, string>
}

/**
 * Upgrade the previously accepted loose profile shape one profile at a time.
 * A malformed sibling must never replace every usable profile with defaults.
 * Undefined extension fields are dropped; usable variables and descriptions
 * are preserved within the current bounded contract.
 */
function migrateEnvProfiles(value: unknown): MigratedEnvProfiles | null {
  if (!Array.isArray(value)) return null
  const profiles: EnvProfile[] = []
  const names = new Map<string, string>()
  const usedNames = new Set<string>()

  const uniqueName = (raw: string, index: number): string => {
    const cleaned = raw.replace(/\p{Cc}/gu, ' ').trim()
    const base = (cleaned || `profile-${index + 1}`).slice(0, MAX_PROFILE_NAME)
    let candidate = base
    let suffix = 2
    while (usedNames.has(candidate)) {
      const tail = `-${suffix++}`
      candidate = `${base.slice(0, MAX_PROFILE_NAME - tail.length)}${tail}`
    }
    usedNames.add(candidate)
    return candidate
  }

  for (let index = 0; index < value.length && profiles.length < MAX_ENV_PROFILES; index += 1) {
    const item = value[index]
    if (!isPlainRecord(item) || typeof item.name !== 'string' || !isPlainRecord(item.env)) {
      continue
    }
    if (item.description !== undefined && typeof item.description !== 'string') continue

    const name = uniqueName(item.name, index)
    const envEntries: Array<[string, string]> = []
    for (const [key, envValue] of Object.entries(item.env)) {
      if (envEntries.length >= MAX_PROFILE_VARIABLES) break
      if (
        key.length < 1 ||
        key.length > MAX_ENV_KEY ||
        !ENV_KEY.test(key) ||
        typeof envValue !== 'string' ||
        envValue.length > MAX_ENV_VALUE ||
        envValue.includes('\u0000')
      ) {
        continue
      }
      envEntries.push([key, envValue])
    }
    const env = Object.fromEntries(envEntries) as Record<string, string>
    const profile: EnvProfile = { name, env }
    if (typeof item.description === 'string') {
      profile.description = item.description.slice(0, MAX_PROFILE_DESCRIPTION)
    }
    profiles.push(profile)
    if (!names.has(item.name)) names.set(item.name, name)
  }

  // [] is an intentional profile set. A non-empty file with no recoverable
  // profiles is corrupt and should use safe defaults instead.
  if (value.length > 0 && profiles.length === 0) return null
  return { profiles, names }
}

function validDefaultProfile(
  value: unknown,
  profiles: readonly EnvProfile[]
): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && profiles.some((profile) => profile.name === value))
  )
}

const THEME_VALUES: readonly string[] = ['light', 'dark', 'system']

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_VALUES.includes(value)
}

function settingsPath(): string {
  return join(wrightbenchDir(), 'settings.json')
}

export function loadSettings(): PersistedSettings {
  try {
    ensurePrivateDir(wrightbenchDir())
    const raw = readPrivateFile(settingsPath())
    const value: unknown = JSON.parse(raw)
    const stored =
      typeof value === 'object' && value !== null
        ? (value as Partial<PersistedSettings> & { capturePolicyVersion?: unknown })
        : {}
    const { capturePolicyVersion, ...storedSettings } = stored
    const parsed: PersistedSettings = { ...DEFAULTS, ...storedSettings }
    // Existing installations inherited Balanced as the old implicit default.
    // Move them once to the new product default; a subsequent user selection
    // is preserved because saveSettings stamps the current policy version.
    if (
      capturePolicyVersion !== CAPTURE_POLICY_VERSION &&
      (storedSettings.captureMode === undefined || storedSettings.captureMode === 'balanced')
    ) {
      parsed.captureMode = 'full'
    }
    // settings.json is user-editable — an unknown enum here must never
    // reach nativeTheme.themeSource (Electron throws on invalid values)
    if (!isThemePreference(parsed.theme)) parsed.theme = DEFAULTS.theme
    const migratedProfiles = migrateEnvProfiles(parsed.envProfiles)
    if (migratedProfiles === null) {
      parsed.envProfiles = DEFAULTS.envProfiles
      parsed.defaultProfile = DEFAULTS.defaultProfile
    } else {
      parsed.envProfiles = migratedProfiles.profiles
      if (typeof parsed.defaultProfile === 'string') {
        parsed.defaultProfile = migratedProfiles.names.get(parsed.defaultProfile) ?? null
      }
    }
    if (!validDefaultProfile(parsed.defaultProfile, parsed.envProfiles)) {
      parsed.defaultProfile = null
    }
    if (
      typeof parsed.runRetentionDays !== 'number' ||
      !Number.isFinite(parsed.runRetentionDays) ||
      parsed.runRetentionDays < 1
    ) {
      parsed.runRetentionDays = DEFAULTS.runRetentionDays
    }
    if (
      typeof parsed.traceRetentionDays !== 'number' ||
      !Number.isFinite(parsed.traceRetentionDays) ||
      parsed.traceRetentionDays < 1
    ) {
      parsed.traceRetentionDays = DEFAULTS.traceRetentionDays
    }
    if (!CAPTURE_MODES.includes(parsed.captureMode)) parsed.captureMode = DEFAULTS.captureMode
    if (
      typeof parsed.artifactBudgetGb !== 'number' ||
      !Number.isFinite(parsed.artifactBudgetGb) ||
      parsed.artifactBudgetGb < 0.5
    ) {
      parsed.artifactBudgetGb = DEFAULTS.artifactBudgetGb
    }
    if (!DENSITIES.includes(parsed.density)) parsed.density = DEFAULTS.density
    if (!CODE_FONTS.includes(parsed.codeFont)) parsed.codeFont = DEFAULTS.codeFont
    if (!NODE_MODES.includes(parsed.nodeMode)) parsed.nodeMode = DEFAULTS.nodeMode
    if (typeof parsed.nodePath !== 'string') parsed.nodePath = DEFAULTS.nodePath
    parsed.workspaceUi = sanitizeWorkspaceUi(parsed.workspaceUi)
    if (migratedProfiles !== null) {
      for (const context of Object.values(parsed.workspaceUi.projectViews)) {
        if (context.envProfile !== null) {
          context.envProfile = migratedProfiles.names.get(context.envProfile) ?? null
        }
      }
    }
    return parsed
  } catch {
    return { ...DEFAULTS, workspaceUi: defaultWorkspaceUi() }
  }
}

/**
 * Apply a settings patch (theme excluded — nativeTheme flows through
 * theme:set). Unknown keys are dropped; values are re-validated by the
 * loadSettings round-trip on next read.
 */
export function updateSettings(patch: Partial<PersistedSettings>): PersistedSettings {
  const current = loadSettings()
  const next: PersistedSettings = { ...current }
  if (patch.envProfiles !== undefined) {
    if (!isValidEnvProfiles(patch.envProfiles)) {
      throw new Error('invalid environment profiles')
    }
    next.envProfiles = patch.envProfiles
  }
  if (patch.defaultProfile !== undefined) {
    if (patch.defaultProfile !== null && typeof patch.defaultProfile !== 'string') {
      throw new Error('invalid default environment profile')
    }
    next.defaultProfile = patch.defaultProfile
  }
  // Validate the pair after both fields have been applied: removing or
  // renaming the default must update defaultProfile in the same atomic patch.
  if (!validDefaultProfile(next.defaultProfile, next.envProfiles)) {
    throw new Error('default environment profile does not exist')
  }
  if (
    typeof patch.runRetentionDays === 'number' &&
    Number.isFinite(patch.runRetentionDays) &&
    patch.runRetentionDays >= 1
  ) {
    next.runRetentionDays = Math.round(patch.runRetentionDays)
  }
  if (
    typeof patch.traceRetentionDays === 'number' &&
    Number.isFinite(patch.traceRetentionDays) &&
    patch.traceRetentionDays >= 1
  ) {
    next.traceRetentionDays = Math.round(patch.traceRetentionDays)
  }
  if (patch.captureMode !== undefined && CAPTURE_MODES.includes(patch.captureMode)) {
    next.captureMode = patch.captureMode
  }
  if (
    typeof patch.artifactBudgetGb === 'number' &&
    Number.isFinite(patch.artifactBudgetGb) &&
    patch.artifactBudgetGb >= 0.5
  ) {
    next.artifactBudgetGb = Math.round(patch.artifactBudgetGb * 10) / 10
  }
  if (patch.density !== undefined && DENSITIES.includes(patch.density)) {
    next.density = patch.density
  }
  if (patch.codeFont !== undefined && CODE_FONTS.includes(patch.codeFont)) {
    next.codeFont = patch.codeFont
  }
  if (patch.nodeMode !== undefined && NODE_MODES.includes(patch.nodeMode)) {
    next.nodeMode = patch.nodeMode
  }
  if (typeof patch.nodePath === 'string') next.nodePath = patch.nodePath
  if (patch.workspaceUi !== undefined) {
    next.workspaceUi = sanitizeWorkspaceUi(patch.workspaceUi)
  }
  saveSettings(next)
  return next
}

/** drop one project's persisted view context (called when it is removed) */
export function pruneProjectViewContext(projectId: string): void {
  const current = loadSettings()
  if (!(projectId in current.workspaceUi.projectViews)) return
  const projectViews = { ...current.workspaceUi.projectViews }
  delete projectViews[projectId]
  saveSettings({ ...current, workspaceUi: { ...current.workspaceUi, projectViews } })
}

/**
 * Process environment for anything that executes the project's tests (CLI
 * runs and the UI Mode test server): the html reporter's auto-open is
 * suppressed and the fixed-node PATH prefix is applied the same way
 * everywhere. Project variables come only from the project/shell/recipe.
 * trackedSpawn prepends the PATH entry to the repaired base PATH.
 */
export function projectRunEnv(): Record<string, string> {
  const settings = loadSettings()
  const env: Record<string, string> = {
    // the html reporter must never pop a browser after runs
    PLAYWRIGHT_HTML_OPEN: 'never',
    PW_TEST_HTML_REPORT_OPEN: 'never'
  }
  if (settings.nodeMode === 'fixed' && settings.nodePath.trim() !== '') {
    env.PATH = [dirname(settings.nodePath.trim()), env.PATH].filter(Boolean).join(delimiter)
  }
  return env
}

export function saveSettings(settings: PersistedSettings): void {
  if (!isValidEnvProfiles(settings.envProfiles)) {
    throw new Error('invalid environment profiles')
  }
  if (!validDefaultProfile(settings.defaultProfile, settings.envProfiles)) {
    throw new Error('default environment profile does not exist')
  }
  writeJsonAtomic(settingsPath(), { ...settings, capturePolicyVersion: CAPTURE_POLICY_VERSION })
}

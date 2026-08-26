import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CaptureMode } from '@shared/ipc'
import { wrightbenchDir } from './settings'

/** the conventional root config names, in Playwright's resolution priority —
 *  the single source shared by capture, scanning, and migration */
export const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.mts',
  'playwright.config.cts'
] as const

const RUNTIME_CONFIG_PREFIX = 'full-evidence-'
const RUNTIME_CONFIG_MAX_AGE_MS = 24 * 60 * 60 * 1_000

export type TraceCaptureMode = 'on' | 'retain-on-failure'

export interface RuntimeCaptureConfig {
  path: string
  cleanup: () => void
}

export interface RuntimeCaptureTarget {
  /** absolute Playwright working directory */
  cwd: string
  /** absolute selected config, null for Playwright default resolution */
  configPath: string | null
  /** absolute package directory used for module-format resolution */
  packageDir: string
}

/** Conventional Playwright config used by project detection and CLI runs. */
export function findPlaywrightConfig(projectPath: string): string | null {
  for (const name of CONFIG_NAMES) {
    const candidate = join(projectPath, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Trace remains a public CLI override for every capture policy. */
export function traceModeForCapture(
  captureMode: CaptureMode,
  focusedRun: boolean
): TraceCaptureMode {
  return captureMode === 'full' || (captureMode === 'balanced' && focusedRun)
    ? 'on'
    : 'retain-on-failure'
}

type WrapperFormat = 'esm' | 'cjs'

/**
 * A CJS wrapper require()s the project config through Playwright's ancient,
 * universal TS transform hook. An ESM wrapper import chain only transpiles a
 * transitive .ts config on newer Playwright versions (1.60 dies with "Cannot
 * use import statement outside a module"), so ESM is reserved for projects
 * that are actually ESM — where the CJS require would be the broken path.
 */
function wrapperFormatFor(configFile: string, projectPath: string): WrapperFormat {
  if (configFile.endsWith('.mjs') || configFile.endsWith('.mts')) return 'esm'
  if (configFile.endsWith('.cjs') || configFile.endsWith('.cts')) return 'cjs'
  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8')) as {
      type?: unknown
    }
    return pkg.type === 'module' ? 'esm' : 'cjs'
  } catch {
    return 'cjs'
  }
}

function runtimeConfigSource(configFile: string, format: WrapperFormat): string {
  const configUrl = pathToFileURL(configFile).href
  const configDir = dirname(configFile)

  // This is intentionally plain JS rather than TypeScript: it is loaded by
  // the project's Playwright installation and must work without importing any
  // Wrightbench package. All path-sensitive config values are rebased to the
  // original config directory before the Wrightbench-owned file becomes the
  // effective --config entry point.
  const header =
    format === 'esm'
      ? `import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import baseConfigModule from ${JSON.stringify(configUrl)}

const projectRequire = createRequire(${JSON.stringify(configUrl)})`
      : `'use strict'
const { existsSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const baseConfigModule = require(${JSON.stringify(configFile)})

const projectRequire = createRequire(${JSON.stringify(configFile)})`
  const footer = format === 'esm' ? 'export default config' : 'module.exports = config'

  return `${header}

const originalConfigDir = ${JSON.stringify(configDir)}
const importedConfig =
  baseConfigModule &&
  typeof baseConfigModule === 'object' &&
  baseConfigModule.default &&
  typeof baseConfigModule.default === 'object'
    ? baseConfigModule.default
    : baseConfigModule
const baseConfig = importedConfig && typeof importedConfig === 'object' ? importedConfig : {}
const evidence = { trace: 'on', screenshot: 'on', video: 'on' }

const absoluteFromConfig = value =>
  typeof value === 'string' && value !== '' && !path.isAbsolute(value)
    ? path.resolve(originalConfigDir, value)
    : value

const resolveScript = value => {
  if (typeof value !== 'string' || value === '') return value
  const local = absoluteFromConfig(value)
  if (typeof local === 'string' && existsSync(local)) return local
  try {
    return projectRequire.resolve(value)
  } catch {
    return value
  }
}

const rebaseScriptList = value =>
  Array.isArray(value) ? value.map(resolveScript) : resolveScript(value)

// custom reporter modules resolve against the effective config file — that is
// now this wrapper's directory, so project-relative and package specifiers
// must be pinned back to the project. Builtin names stay untouched.
const BUILTIN_REPORTERS = new Set([
  'blob', 'dot', 'github', 'html', 'json', 'junit', 'line', 'list', 'markdown', 'null'
])
const rebaseReporterName = name =>
  typeof name === 'string' && name !== '' && !BUILTIN_REPORTERS.has(name)
    ? resolveScript(name)
    : name
const rebaseReporter = value => {
  if (typeof value === 'string') return rebaseReporterName(value)
  if (!Array.isArray(value)) return value
  return value.map(entry =>
    Array.isArray(entry) ? [rebaseReporterName(entry[0]), ...entry.slice(1)] : rebaseReporterName(entry)
  )
}

const rebaseTemplate = value => {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value)) return value
  if (/^\\{(?:testDir|snapshotDir)\\}/.test(value)) return value
  return path.resolve(originalConfigDir, value)
}

const rebaseExpectation = value => {
  if (!value || typeof value !== 'object') return value
  const next = { ...value }
  if ('pathTemplate' in next) next.pathTemplate = rebaseTemplate(next.pathTemplate)
  if ('stylePath' in next) {
    next.stylePath = Array.isArray(next.stylePath)
      ? next.stylePath.map(absoluteFromConfig)
      : absoluteFromConfig(next.stylePath)
  }
  return next
}

const rebaseExpect = value => {
  if (!value || typeof value !== 'object') return value
  const next = { ...value }
  for (const key of ['toHaveScreenshot', 'toMatchSnapshot', 'toMatchAriaSnapshot']) {
    if (key in next) next[key] = rebaseExpectation(next[key])
  }
  return next
}

const rebaseUse = value => {
  if (!value || typeof value !== 'object') return {}
  const next = { ...value }
  if (typeof next.storageState === 'string') next.storageState = absoluteFromConfig(next.storageState)
  if (Array.isArray(next.clientCertificates)) {
    next.clientCertificates = next.clientCertificates.map(certificate => ({
      ...certificate,
      certPath: absoluteFromConfig(certificate.certPath),
      keyPath: absoluteFromConfig(certificate.keyPath),
      pfxPath: absoluteFromConfig(certificate.pfxPath)
    }))
  }
  return next
}

const rebaseProject = project => ({
  ...project,
  testDir: absoluteFromConfig(project.testDir),
  outputDir: absoluteFromConfig(project.outputDir),
  snapshotDir: absoluteFromConfig(project.snapshotDir),
  snapshotPathTemplate: rebaseTemplate(project.snapshotPathTemplate),
  expect: rebaseExpect(project.expect),
  use: { ...rebaseUse(project.use), ...evidence }
})

const rebaseWebServer = server => {
  if (!server || typeof server !== 'object') return server
  return { ...server, cwd: absoluteFromConfig(server.cwd) || originalConfigDir }
}

const config = {
  ...baseConfig,
  // a config without testDir means "the config file's directory" — that
  // default must not drift to this wrapper's location
  testDir: absoluteFromConfig(baseConfig.testDir) ?? originalConfigDir,
  outputDir: absoluteFromConfig(baseConfig.outputDir),
  snapshotDir: absoluteFromConfig(baseConfig.snapshotDir),
  snapshotPathTemplate: rebaseTemplate(baseConfig.snapshotPathTemplate),
  tsconfig: absoluteFromConfig(baseConfig.tsconfig),
  globalSetup: rebaseScriptList(baseConfig.globalSetup),
  globalTeardown: rebaseScriptList(baseConfig.globalTeardown),
  reporter: rebaseReporter(baseConfig.reporter),
  expect: rebaseExpect(baseConfig.expect),
  use: { ...rebaseUse(baseConfig.use), ...evidence },
  webServer: Array.isArray(baseConfig.webServer)
    ? baseConfig.webServer.map(rebaseWebServer)
    : rebaseWebServer(baseConfig.webServer)
}

if (Array.isArray(baseConfig.projects)) config.projects = baseConfig.projects.map(rebaseProject)

${footer}
`
}

/** Full-evidence overlay for Playwright's valid config-less default mode. */
function configlessRuntimeConfigSource(cwd: string): string {
  return `'use strict'
module.exports = {
  testDir: ${JSON.stringify(cwd)},
  use: { trace: 'on', screenshot: 'on', video: 'on' }
}
`
}

function cleanupStaleRuntimeConfigs(directory: string): void {
  const cutoff = Date.now() - RUNTIME_CONFIG_MAX_AGE_MS
  try {
    for (const entry of readdirSync(directory)) {
      if (
        !entry.startsWith(RUNTIME_CONFIG_PREFIX) ||
        !(entry.endsWith('.mjs') || entry.endsWith('.cjs'))
      )
        continue
      const path = join(directory, entry)
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      } catch {
        // another launch may have removed it already
      }
    }
  } catch {
    // cleanup is best-effort; creating this run's adapter is authoritative
  }
}

/**
 * Build a Wrightbench-owned config overlay for Full evidence. The user's
 * playwright.config.* is imported but never edited; only trace, screenshot,
 * and video are overridden, at both top-level and per-project `use` scopes.
 * Config-less projects receive an equivalent minimal default-mode wrapper.
 */
export function createRuntimeCaptureConfig(
  projectPath: string,
  captureMode: CaptureMode,
  target?: RuntimeCaptureTarget
): RuntimeCaptureConfig | null {
  if (captureMode !== 'full') return null

  const configFile = target?.configPath ?? findPlaywrightConfig(target?.cwd ?? projectPath)

  const directory = join(wrightbenchDir(), 'runtime-configs')
  mkdirSync(directory, { recursive: true })
  cleanupStaleRuntimeConfigs(directory)

  const format =
    configFile === null ? 'cjs' : wrapperFormatFor(configFile, target?.packageDir ?? projectPath)
  const path = resolve(
    directory,
    `${RUNTIME_CONFIG_PREFIX}${randomUUID()}.${format === 'esm' ? 'mjs' : 'cjs'}`
  )
  const source =
    configFile === null
      ? configlessRuntimeConfigSource(resolve(target?.cwd ?? projectPath))
      : runtimeConfigSource(resolve(configFile), format)
  writeFileSync(path, source, {
    encoding: 'utf8',
    mode: 0o600
  })

  let cleaned = false
  return {
    path,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try {
        rmSync(path, { force: true })
      } catch {
        // best effort — stale adapters are swept on a later run
      }
    }
  }
}

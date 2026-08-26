import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CommandResult, ProjectProgress } from '@shared/ipc'
import {
  playwrightScaffoldOption,
  type PlaywrightScaffoldSelection
} from '@shared/playwright-compat'
import { killTree, NPM, trackedSpawn } from './proc'

type ProgressSink = (progress: ProjectProgress) => void

export function scaffoldInstallPlan(selection: unknown): {
  value: PlaywrightScaffoldSelection
  experimental: boolean
  args: string[]
} | null {
  const option = playwrightScaffoldOption(selection)
  if (option === null) return null
  return {
    value: option.value,
    experimental: option.channel === 'experimental',
    args: ['install', '--save-dev', '--save-exact', `@playwright/test@${option.value}`]
  }
}

function streamCommand(
  cmd: string,
  args: string[],
  cwd: string,
  kind: ProjectProgress['kind'],
  onProgress: ProgressSink,
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = trackedSpawn(cmd, args, cwd)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let buffer = ''
    const emit = (chunk: string): void => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) onProgress({ kind, path: cwd, line })
        idx = buffer.indexOf('\n')
      }
    }
    const flush = (): void => {
      const rest = buffer.trim()
      buffer = ''
      if (rest) onProgress({ kind, path: cwd, line: rest })
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    child.on('error', (err) => {
      clearTimeout(timer)
      flush()
      resolve({ ok: false, code: null, error: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      flush()
      if (timedOut) {
        resolve({
          ok: false,
          code,
          error: `timed out after ${Math.round(timeoutMs / 60_000)} minutes`
        })
        return
      }
      resolve({ ok: code === 0, code })
    })
  })
}

/** One long-running command per (kind, path); a second call joins the first. */
const inFlight = new Map<string, Promise<CommandResult>>()

function single(key: string, factory: () => Promise<CommandResult>): Promise<CommandResult> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = factory().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.mts',
  'playwright.config.cts'
]

const CONFIG_TEMPLATE = `import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'html',
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
})
`

const EXAMPLE_SPEC = `import { test, expect } from '@playwright/test'

test('has title', async ({ page }) => {
  await page.goto('https://playwright.dev/')
  await expect(page).toHaveTitle(/Playwright/)
})

test('get started link', async ({ page }) => {
  await page.goto('https://playwright.dev/')
  await page.getByRole('link', { name: 'Get started' }).click()
  await expect(page.getByRole('heading', { name: 'Installation' })).toBeVisible()
})
`

function scaffoldConflict(projectPath: string): string | null {
  if (existsSync(join(projectPath, 'package.json'))) {
    return 'folder already contains a package.json'
  }
  if (CONFIG_NAMES.some((name) => existsSync(join(projectPath, name)))) {
    return 'folder already contains a Playwright config'
  }
  if (existsSync(join(projectPath, 'tests', 'example.spec.ts'))) {
    return 'folder already contains tests/example.spec.ts'
  }
  return null
}

/**
 * Create a minimal Playwright project in an empty folder, then install
 * @playwright/test (streamed). The caller re-inspects afterwards.
 */
export function scaffoldProject(
  projectPath: string,
  version: PlaywrightScaffoldSelection,
  onProgress: ProgressSink
): Promise<CommandResult> {
  return single(`scaffold:${projectPath}`, async () => {
    const installPlan = scaffoldInstallPlan(version)
    if (installPlan === null) {
      return { ok: false, code: null, error: 'unsupported Playwright scaffold version' }
    }
    const conflict = scaffoldConflict(projectPath)
    if (conflict) return { ok: false, code: null, error: conflict }
    try {
      mkdirSync(join(projectPath, 'tests'), { recursive: true })
      const name =
        basename(projectPath)
          .toLowerCase()
          .replace(/[^a-z0-9-_.]+/g, '-')
          .replace(/^[-_.]+|[-_.]+$/g, '') || 'playwright-project'
      writeFileSync(
        join(projectPath, 'package.json'),
        JSON.stringify(
          { name, version: '0.0.0', private: true, scripts: { test: 'playwright test' } },
          null,
          2
        )
      )
      writeFileSync(join(projectPath, 'playwright.config.ts'), CONFIG_TEMPLATE)
      writeFileSync(join(projectPath, 'tests', 'example.spec.ts'), EXAMPLE_SPEC)
      // never clobber an existing .gitignore
      if (!existsSync(join(projectPath, '.gitignore'))) {
        writeFileSync(
          join(projectPath, '.gitignore'),
          'node_modules/\ntest-results/\nplaywright-report/\n'
        )
      }
    } catch (err) {
      return { ok: false, code: null, error: err instanceof Error ? err.message : String(err) }
    }
    onProgress({
      kind: 'scaffold',
      path: projectPath,
      line: 'created playwright.config.ts, tests/example.spec.ts'
    })
    onProgress({
      kind: 'scaffold',
      path: projectPath,
      line:
        installPlan.experimental
          ? `installing @playwright/test from npm ${installPlan.value} (experimental)…`
          : `installing @playwright/test ${installPlan.value}…`
    })
    return streamCommand(
      NPM,
      installPlan.args,
      projectPath,
      'scaffold',
      onProgress,
      10 * 60_000
    )
  })
}

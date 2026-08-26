// Full Electron Record integration check, including the sandboxed Inspector
// guest preload and both directions of Playwright's native protocol.
//
//   WRIGHTBENCH_RECORD_PROJECT=/path/to/project npm run test:uimode:live
//
// The project must provide Playwright >=1.56 and an installed Chromium. The
// live suite builds Wrightbench before invoking this file.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const project = process.env.WRIGHTBENCH_RECORD_PROJECT
if (!project) {
  console.log('SKIP Electron codegen live test — set WRIGHTBENCH_RECORD_PROJECT')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const projectRequire = createRequire(join(project, 'package.json'))
const { _electron: electron } = projectRequire('playwright')
const electronExecutable =
  process.platform === 'darwin'
    ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : process.platform === 'win32'
      ? join(root, 'node_modules/electron/dist/electron.exe')
      : join(root, 'node_modules/electron/dist/electron')

const isolatedHome = mkdtempSync(join(tmpdir(), 'wb-record-electron-home-'))
const stateDir = join(isolatedHome, '.wrightbench')
mkdirSync(stateDir, { recursive: true })
const targetId = 'record-electron'
writeFileSync(
  join(stateDir, 'projects.json'),
  JSON.stringify([
    {
      id: 'record-electron-project',
      name: 'record-electron-fixture',
      path: project,
      addedAt: new Date().toISOString(),
      playwrightVersion: '1.58.2',
      nodeVersion: null,
      testCount: null,
      targets: [
        {
          id: targetId,
          label: 'playwright.config.ts',
          cwd: '.',
          configPath: 'playwright.config.ts',
          packageDir: '.',
          launcher: 'npm',
          source: 'config',
          scriptName: null,
          scriptEnv: {},
          extraArgs: [],
          playwrightVersion: '1.58.2',
          testCount: null
        }
      ],
      activeTargetId: targetId
    }
  ])
)

let app
try {
  const appEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      join(process.env.HOME ?? isolatedHome, 'Library', 'Caches', 'ms-playwright')
  }
  delete appEnv.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    executablePath: electronExecutable,
    args: [root],
    cwd: root,
    env: appEnv
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1200, height: 760 })
  const projectSelector = await page
    .getByRole('button', { name: /Switch project — current:/ })
    .boundingBox()
  const destinationNav = await page
    .getByRole('navigation', { name: 'Workspace destinations' })
    .boundingBox()
  assert.ok(projectSelector && destinationNav)
  assert.ok(projectSelector.x < destinationNav.x, 'project selector should be left of navigation')
  assert.ok(
    Math.abs(destinationNav.x + destinationNav.width / 2 - 600) <= 1,
    'destination navigation should remain centered at the minimum window width'
  )
  assert.deepEqual(
    await page
      .getByRole('navigation', { name: 'Workspace destinations' })
      .getByRole('button')
      .allTextContents(),
    ['Record', 'Run', 'Report']
  )
  await page.getByRole('button', { name: /Switch project — current:/ }).click()
  const projectMenu = await page.getByRole('menu', { name: 'Projects' }).boundingBox()
  assert.ok(projectMenu)
  assert.ok(projectMenu.height > projectSelector.height, 'project menu should not be clipped')
  assert.ok(
    projectMenu.y >= projectSelector.y + projectSelector.height + 10,
    'project menu should open below the title bar'
  )
  assert.ok(
    Math.abs(projectMenu.x - projectSelector.x) <= 1,
    'project menu should align with the selector left edge'
  )
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await page.getByRole('heading', { name: 'Record with Codegen' }).waitFor()
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.locator('webview[aria-label="Playwright Inspector"]').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: /End session; close the Playwright browser/ }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Stop Record' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Restart' }).count(), 0)
  assert.equal(await page.getByLabel('Initial Record URL').count(), 0)
  assert.equal(await page.getByLabel('Record browser').count(), 0)

  let guestState = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !guestState) {
    const candidate = await app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getTitle().startsWith('Playwright Inspector'))
      if (!guest) return null
      return await guest.executeJavaScript(`({
        title: document.title,
        protocol: new URL(location.href).searchParams.get('wrightbenchProtocol'),
        hasBridge:
          typeof globalThis.sendCommand === 'function' ||
          typeof globalThis.dispatch === 'function',
        hasRecorder: Boolean(document.querySelector('.recorder')),
        hasGeneratedCode: document.body.innerText.includes('import { test, expect }'),
        stopButton: [...document.querySelectorAll('button')].some(button => button.title === 'Stop Recording')
      })`)
    })
    guestState =
      candidate?.hasBridge &&
      candidate.hasRecorder &&
      candidate.hasGeneratedCode &&
      candidate.stopButton
        ? candidate
        : null
    if (!guestState) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(guestState, 'Playwright Inspector guest did not become ready')
  assert.equal(guestState.hasBridge, true)
  assert.equal(guestState.hasRecorder, true)
  assert.equal(guestState.hasGeneratedCode, true)
  assert.equal(guestState.stopButton, true)

  // Click Playwright's own control inside the exact frontend. The resulting
  // status change proves guest → Wrightbench → Recorder → Wrightbench relay.
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getTitle().startsWith('Playwright Inspector'))
    if (!guest) throw new Error('Inspector guest disappeared')
    await guest.executeJavaScript(
      `[...document.querySelectorAll('button')].find(button => button.title === 'Stop Recording').click()`
    )
  })
  await page.getByText('Playwright Inspector · browser open', { exact: true }).waitFor()
  if (process.env.WRIGHTBENCH_RECORD_SCREENSHOT) {
    await page.screenshot({ path: process.env.WRIGHTBENCH_RECORD_SCREENSHOT })
  }

  await page.getByRole('button', { name: /End session; close the Playwright browser/ }).click()
  await page.getByRole('heading', { name: 'Record with Codegen' }).waitFor()
  await page.getByRole('button', { name: 'Start recording' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Record could not start' }).count(), 0)
  console.log('  ok  exact Inspector guest loaded and its native protocol round-tripped')
} finally {
  await app?.close().catch(() => {})
  rmSync(isolatedHome, { recursive: true, force: true })
}

console.log('\nElectron codegen live test passed')

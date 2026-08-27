import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { CODEGEN_HOST_SOURCE, parseCodegenActions } = require('./.build/main.cjs')

function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

test('embedded Record host is valid standalone CommonJS', () => {
  assert.doesNotThrow(() => new vm.Script(CODEGEN_HOST_SOURCE, { filename: 'record-host.cjs' }))
  assert.match(CODEGEN_HOST_SOURCE, /Recorder\.forContext/)
  assert.match(CODEGEN_HOST_SOURCE, /lib', 'vite', 'recorder'/)
  assert.match(CODEGEN_HOST_SOURCE, /lib', 'coreBundle\.js'/)
  assert.match(CODEGEN_HOST_SOURCE, /__wrightbenchRecord/)
  assert.match(CODEGEN_HOST_SOURCE, /frameEvaluationNeedsProgress/)
  assert.match(CODEGEN_HOST_SOURCE, /browserCloseNeedsProgress/)
  assert.match(CODEGEN_HOST_SOURCE, /browser\.close\(progress, options\)/)
  assert.match(CODEGEN_HOST_SOURCE, /browser\.close\(options\)/)
  assert.match(CODEGEN_HOST_SOURCE, /playwrightSetSources/)
  assert.match(CODEGEN_HOST_SOURCE, /wrightbenchProtocol=/)
  assert.match(CODEGEN_HOST_SOURCE, /headless: false/)
  assert.match(CODEGEN_HOST_SOURCE, /--start-maximized/)
  assert.match(CODEGEN_HOST_SOURCE, /noDefaultViewport: true/)
  assert.match(CODEGEN_HOST_SOURCE, /window\.innerWidth/)
  assert.match(CODEGEN_HOST_SOURCE, /generatorOptions\.contextOptions = \{ viewport \}/)
  assert.match(CODEGEN_HOST_SOURCE, /page\.delegate\.bringToFront\(\)/)
  assert.equal(CODEGEN_HOST_SOURCE.match(/await focusInspectedPage\(page\)/g)?.length, 1)
  const pageCreated = CODEGEN_HOST_SOURCE.indexOf(
    'page = await runWithProgress(progress => context.newPage(progress))'
  )
  const focused = CODEGEN_HOST_SOURCE.indexOf('await focusInspectedPage(page)', pageCreated)
  const navigated = CODEGEN_HOST_SOURCE.indexOf('page.mainFrame().goto(progress, initialUrl)', focused)
  assert.ok(pageCreated >= 0 && focused > pageCreated && navigated > focused)
  assert.doesNotMatch(CODEGEN_HOST_SOURCE, /screenshot\(/)
})

test('generated Playwright source becomes stable action cards', () => {
  const actions = parseCodegenActions(`import { test, expect } from '@playwright/test';

test('recorded test', async ({ page }) => {
  await page.goto('https://example.com');
  await page.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
});
`)
  assert.deepEqual(actions, [
    { kind: 'goto', locator: 'https://example.com', value: null },
    {
      kind: 'fill',
      locator: "getByRole('textbox', { name: 'Email' })",
      value: 'ada@example.com'
    },
    {
      kind: 'click',
      locator: "getByRole('button', { name: 'Submit' })",
      value: null
    },
    { kind: 'assert', locator: "getByText('Saved')/toBeVisible", value: null }
  ])
})

if (!process.exitCode) console.log('\nall codegen tests passed')

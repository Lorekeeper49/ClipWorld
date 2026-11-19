// Settings window test: opening it (Edit menu, Ctrl+,, and the pages the old menu items lead to), clip
// colours on the timeline (change, reset, kept after a restart), and editing a shortcut inside it.
// Run with: npm run build && node tests/e2e/settings.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-settings-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const source = join(dir, 'clip.mp4')
{
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [] }))
const userData = join(tmpdir(), 'clipworld-settings-userdata')
rmSync(userData, { recursive: true, force: true })

const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const errors = []
async function launch() {
  const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env: { ...process.env, CW_E2E_DIALOGS: dialogs } })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForSelector('.menubar')
  return { app, page }
}
const clipBackground = (page, type) => page.evaluate((type) => {
  const el = document.querySelector(`[data-testid=clip][data-clip-type=${type}]`)
  return el ? getComputedStyle(el).backgroundColor : null
}, type)
const setColor = async (page, kind, hex) => {
  const input = page.locator(`[data-testid=clip-color][data-kind=${kind}] input[type=text]`)
  await input.fill(hex)
  await input.press('Enter')
}

let { app, page } = await launch()

step('a project with a video (and its sound) and a text clip')
await page.evaluate(async (f) => {
  const { actions } = window.__cw
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  window.__cw.player.seek(0)
  actions.addTextAction()
}, source)
await page.waitForSelector('[data-testid=clip][data-clip-type=text]')

step('Edit ▸ Settings… opens the Settings window')
await page.getByTestId('menu-edit').click()
check(await page.getByTestId('menu-settings').innerText().then((s) => s.includes('Ctrl+,')), 'the menu item shows its shortcut, Ctrl+,')
await page.getByTestId('menu-settings').click()
await page.waitForSelector('.modal[aria-label=Settings]')
check(await page.locator('[data-testid=language-option]').count() >= 3, 'the General page shows the language choice')
check(await page.getByTestId('settings-preview-volume').count() === 1 && await page.getByTestId('settings-auto-import').count() === 1,
  'and the other preferences: preview volume, preset auto-import')
await page.getByTestId('settings-preview-volume').fill('40')
await page.getByTestId('settings-preview-volume').press('Enter')
check(await page.evaluate(() => window.__cw.get().settings.previewVolume) === 0.4, 'preview volume changes straight away')
await page.getByTestId('settings-done').click()
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal[aria-label=Settings]')
check(true, 'Ctrl+, opens it too')
await page.keyboard.press('Escape')

step('clip colors')
await page.keyboard.press('Control+,')
await page.getByTestId('settings-page-timeline').click()
check(await page.locator('[data-testid=clip-color]').count() === 5, 'one color for each kind of clip: video, audio, picture, text, subtitles')
const before = await clipBackground(page, 'video')
await setColor(page, 'video', '#ff8800')
check(await clipBackground(page, 'video') === 'rgb(255, 136, 0)', `video clips turn orange on the timeline (was ${before})`)
await setColor(page, 'audio', '#f0f0f0')
check(await clipBackground(page, 'audio') === 'rgb(240, 240, 240)', 'audio clips turn light grey')
check(await page.evaluate(() => getComputedStyle(document.querySelector('[data-kind=video] .clip-swatch')).backgroundColor) === 'rgb(255, 136, 0)',
  'the sample in Settings shows the new color')
check(await page.evaluate(() => getComputedStyle(document.querySelector('[data-kind=audio] .clip-swatch')).backgroundColor) === 'rgb(240, 240, 240)' &&
  await page.evaluate(() => getComputedStyle(document.querySelector('[data-kind=text] .clip-swatch')).backgroundColor) === 'rgb(154, 85, 214)',
  'each sample shows the color of its own kind of clip')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'settings-colors.png') })
await page.locator('[data-testid=clip-color][data-kind=audio] button[title]').click()
check(await clipBackground(page, 'audio') === 'rgb(29, 143, 122)', 'one color can be put back to its default')
await page.keyboard.press('Escape')

step('colors are kept after a restart')
await page.waitForTimeout(600)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
;({ app, page } = await launch())
await page.evaluate(async (f) => {
  const [m] = await window.__cw.actions.importPaths([f])
  window.__cw.actions.addToTimeline(m.id, 0)
}, source)
await page.waitForSelector('[data-testid=clip][data-clip-type=video]')
check(await clipBackground(page, 'video') === 'rgb(255, 136, 0)', 'video clips are still orange')
await page.keyboard.press('Control+,')
await page.getByTestId('settings-page-timeline').click()
await page.getByTestId('clip-colors-reset').click()
check(await clipBackground(page, 'video') === 'rgb(63, 95, 214)', 'Reset all colors brings back the defaults')

step('keyboard shortcuts, inside Settings')
await page.getByTestId('settings-page-shortcuts').click()
const row = page.locator('[data-testid=shortcut-row][data-shortcut-id="timeline.split"]')
await row.locator('button.kbd').click()
await page.keyboard.press('Escape')
check(await page.locator('.modal').count() === 1, 'Escape while waiting for keys cancels that, and leaves Settings open')
await row.locator('button.kbd').click()
await page.keyboard.press('Control+Shift+K')
check(await row.locator('button.kbd').innerText() === 'Ctrl+Shift+K', 'a new key combination is assigned')
await page.getByTestId('shortcuts-reset').click()
check(await row.locator('button.kbd').innerText() === 'Ctrl+K', 'and Reset all to defaults puts it back')
await page.keyboard.press('Escape')

step('the older menu items open their page of Settings')
await page.getByTestId('menu-edit').click()
await page.getByTestId('menu-shortcuts').click()
check(await page.locator('[data-testid=shortcut-row]').count() > 20, 'Edit ▸ Keyboard shortcuts… opens the shortcuts page')
await page.keyboard.press('Escape')
await page.getByTestId('menu-edit').click()
await page.getByTestId('menu-language').click()
check(await page.locator('[data-testid=language-option]').count() >= 3, 'Edit ▸ Language… opens the language choice')
await page.keyboard.press('Escape')

await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll settings UI checks passed.')

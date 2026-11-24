/*
 * Copyright (C) 2026 Lorekeeper49
 *
 * This file is part of ClipWorld.
 *
 * ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
 * General Public License as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with ClipWorld. If not,
 * see <https://www.gnu.org/licenses/>.
 */

// Plugins UI test, with the example plugins: turning one on (the warning), a command that asks a
// question and adds a title (and its shortcut), a plugin window, a plugin effect in the preview and the
// export, an exporter and an importer (Python), a plugin that would break two others (the offer to turn
// them off), a missing interpreter (Lua), and plugins staying on after a restart.
// Run with: npm run build && node tests/e2e/plugins.mjs
import { _electron as electron } from 'playwright'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-plugins-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const red = join(dir, 'red.mp4')
{
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-pix_fmt', 'yuv444p', red])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}
// A plugin that wants the same shortcut as the JavaScript example and the same file type as the Python one.
const clash = join(dir, 'extra', 'clash')
mkdirSync(clash, { recursive: true })
writeFileSync(join(clash, 'plugin.json'), JSON.stringify({
  id: 'test.clash', name: 'Clash', version: '1.0.0', main: 'main.mjs',
  commands: [{ id: 'x', title: 'X', shortcut: 'Ctrl+Alt+T' }],
  importers: [{ id: 'csv', title: 'CSV too', extensions: ['csv'] }]
}))
copyFileSync(join(root, 'plugins', 'sdk', 'clipworld.mjs'), join(clash, 'clipworld.mjs'))
writeFileSync(join(clash, 'main.mjs'), "import { plugin } from './clipworld.mjs'\nplugin.command('x', () => 'clash ran')\nplugin.start()\n")

const dialogs = join(dir, 'dialogs.json')
const answer = (a) => writeFileSync(dialogs, JSON.stringify({ open: [], save: [], ...a }))
answer({})
const userData = join(tmpdir(), 'clipworld-plugins-userdata')
rmSync(userData, { recursive: true, force: true })
const hasLua = ['lua', 'lua5.4', 'lua54', 'lua5.3', 'lua53'].some((c) => spawnSync(c, ['-v']).status === 0)

const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const errors = []

async function launch() {
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, CW_E2E_DIALOGS: dialogs, CW_PLUGIN_DIRS: [join(root, 'plugins', 'examples'), join(dir, 'extra')].join(delimiter) }
  })
  // Nothing may land in the real Documents folder.
  await app.evaluate(({ app }, d) => app.setPath('documents', d), join(dir, 'docs'))
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForSelector('.menubar')
  return { app, page }
}
let { app, page } = await launch()
const row = (id) => page.locator(`[data-testid=plugin-row][data-plugin-id="${id}"]`)
const state = (id) => row(id).getByTestId('plugin-state').innerText()
const openManager = async () => {
  await page.getByTestId('menu-plugins').click()
  await page.getByTestId('menu-manage-plugins').click()
  await page.waitForSelector('[data-testid=plugin-row]')
}
const turnOn = async (id) => {
  await row(id).locator('label.toggle').click()
  await row(id).getByTestId('plugin-confirm-on').click()
}
const waitState = (id, want) => page.waitForFunction(([id, want]) => {
  const p = window.__cw.get().plugins?.plugins.find((x) => x.manifest.id === id)
  return p && (p.enabled ? p.state : 'off') === want
}, [id, want], { timeout: 20000 })
const menuItem = async (testId) => {
  await page.getByTestId('menu-plugins').click()
  await page.getByTestId(testId).click()
}

step('the plugins are found, all off')
await openManager()
check(await page.getByTestId('plugin-row').count() === 5, 'four examples and the test plugin are listed')
check((await state('example.hello-js')) === 'Off', 'they start off')
check((await row('example.csv-python').innerText()).includes('Python'), 'each says its language')

step('turning one on warns first')
await row('example.hello-js').locator('label.toggle').click()
check((await row('example.hello-js').getByTestId('plugin-confirm').innerText()).includes('Only turn it on if you trust where it came from'), 'the trust warning is shown')
check(await row('example.hello-js').getByTestId('plugin-conflicts').count() === 0, 'nothing on could break')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'plugins-manager.png') })
await row('example.hello-js').getByTestId('plugin-confirm-on').click()
await waitState('example.hello-js', 'running')
check((await state('example.hello-js')) === 'On', 'it is running')
await page.keyboard.press('Escape')

step('a command asks a question and adds a title (JavaScript)')
const playhead = await page.evaluate(() => window.__cw.player.time)
await menuItem('menu-plugin-example.hello-js-addTitle')
await page.waitForSelector('[data-testid=plugin-form-ok]')
check((await page.locator('.modal').innerText()).includes('Add a title'), "the plugin's question is shown")
await page.getByTestId('plugin-field-text').fill('From a plugin')
await page.getByTestId('plugin-field-seconds').fill('2')
await page.getByTestId('plugin-form-ok').click()
await page.waitForFunction(() => window.__cw.get().project.clips.some((c) => c.text?.content === 'From a plugin'), null, { timeout: 10000 })
let title = await page.evaluate(() => window.__cw.get().project.clips.find((c) => c.text?.content === 'From a plugin'))
check(Math.abs(title.start - playhead) < 1e-6 && title.duration === 2, `at the playhead, 2 seconds long (${title.start}, ${title.duration})`)
check(await page.evaluate((id) => window.__cw.get().selection.join() === id, title.id), 'and selected')
await page.evaluate(() => window.__cw.actions.undo())
check(await page.evaluate(() => window.__cw.get().project.clips.length === 0), 'one Undo takes it all back')
await page.locator('.dv-tab', { hasText: 'Preview' }).first().click()
await page.keyboard.press('Control+Alt+T')
await page.waitForSelector('[data-testid=plugin-form-cancel]')
check(true, 'its shortcut, Ctrl+Alt+T, asks too')
await page.getByTestId('plugin-form-cancel').click()
check(await page.evaluate(() => window.__cw.get().project.clips.length === 0), 'Cancel adds nothing')

step("a plugin's window")
await page.evaluate(async (f) => {
  const { actions } = window.__cw
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  window.__cw.set({ selection: [] })
  window.__cw.player.seek(0)
}, red)
await menuItem('menu-panel-example.hello-js-clips')
const frame = page.frameLocator('iframe[data-plugin-panel=clips]')
await frame.locator('li[data-clip-id]').first().waitFor({ timeout: 15000 })
check((await frame.locator('li[data-clip-id]').first().innerText()).includes('red.mp4'), 'it lists the clips the plugin sent')
await frame.locator('li[data-clip-id]').first().click()
await page.waitForFunction(() => window.__cw.get().selection.length === 1)
check(true, 'clicking a clip there selects it in ClipWorld')

step('a plugin effect in the preview and the export (TypeScript)')
await openManager()
await turnOn('example.film-effects-ts')
await waitState('example.film-effects-ts', 'running')
await page.keyboard.press('Escape')
const fxType = 'plugin:example.film-effects-ts/oldFilm'
await page.locator('.dv-tab', { hasText: 'Tools' }).first().click()
const offered = await page.evaluate((t) => [...document.querySelectorAll('[data-testid=add-effect] option')].some((o) => o.value === t && o.textContent === 'Old film'), fxType)
check(offered, '"Old film" is in the effects list')
await page.getByTestId('add-effect').selectOption(fxType)
await page.evaluate(() => {
  const { edit } = window.__cw
  edit((p) => { const e = p.clips.find((c) => c.type === 'video').effects[0]; e.params.amount = 1; e.params.grain = false })
  window.__cw.set({ selection: [] })
  window.__cw.player.seek(1)
})
const previewRed = () => page.evaluate(() => {
  const c = document.querySelector('.preview-canvas, canvas[data-testid=preview-canvas], .preview canvas')
  const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
  return [d[0], d[1], d[2]]
})
await page.waitForFunction(() => {
  const c = document.querySelector('.preview-canvas, canvas[data-testid=preview-canvas], .preview canvas')
  if (!c) return false
  const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data
  return d[0] > 60 && d[0] < 160 && d[0] > d[1] && d[1] > d[2]
}, null, { timeout: 20000 }).catch(async () => { throw new Error(`FAILED: the preview shows the effect (${await previewRed()})`) })
check(true, `the paused preview shows it (${await previewRed()}: red turned brownish)`)
const outVideo = join(dir, 'film.mp4')
answer({ save: [outVideo] })
await page.evaluate(() => window.__cw.set({ modal: 'export' }))
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', `exported (${await page.getByTestId('export-result').innerText()})`)
await page.getByTestId('export-close').click()
const px = spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', '1', '-i', outVideo, '-vf', 'crop=1:1:160:90,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']).stdout
check(px[0] < 150 && px[0] > px[1] && px[1] > px[2], `the export has it too (${[...px]})`)

step('an exporter and an importer (Python)')
await openManager()
await turnOn('example.csv-python')
await waitState('example.csv-python', 'running')
await page.keyboard.press('Escape')
const csvOut = join(dir, 'clips.csv')
answer({ save: [csvOut] })
await page.getByTestId('menu-file').click()
await page.getByTestId('menu-export-example.csv-python-clipList').click()
await page.waitForFunction((f) => window.__cw.get().toasts.some((t) => t.text.includes('clips.csv')), csvOut, { timeout: 20000 })
check(readFileSync(csvOut, 'utf8').includes('red.mp4'), 'File ▸ Export clip list as CSV wrote the clips')
const csvIn = join(dir, 'titles.csv')
writeFileSync(csvIn, 'start,length,text\n0.5,1,One\n2,1,Two\n')
await page.evaluate((f) => window.__cw.actions.importPaths([f]), csvIn)
await page.waitForFunction(() => window.__cw.get().project.clips.filter((c) => c.type === 'text').length === 2, null, { timeout: 20000 })
check(true, 'importing a .csv file hands it to the plugin, which added two titles')

step('a plugin that would break two that are on')
await openManager()
await row('test.clash').locator('label.toggle').click()
const confirm = row('test.clash').getByTestId('plugin-confirm')
const said = await confirm.innerText()
check(said.includes('could break 2 plugins that are on'), 'it says two plugins could break')
check(said.includes('Ctrl+Alt+T') && said.includes('.csv'), 'and why: the same shortcut, the same file type')
check(await confirm.getByTestId('plugin-conflict-off').evaluateAll((els) => els.every((e) => e.checked)), 'turning them off is offered (ticked)')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'plugins-conflict.png') })
await confirm.getByTestId('plugin-confirm-on').click()
await waitState('test.clash', 'running')
check((await state('example.hello-js')) === 'Off' && (await state('example.csv-python')) === 'Off', 'they were turned off')
check((await state('example.film-effects-ts')) === 'On', 'the one that does not clash stays on')

step('a language that is not installed (Lua)')
await turnOn('example.clip-length-lua')
if (hasLua) {
  await waitState('example.clip-length-lua', 'running')
  check(true, 'Lua is installed here: it runs')
} else {
  await waitState('example.clip-length-lua', 'error')
  check((await row('example.clip-length-lua').getByTestId('plugin-error').innerText()).includes('Lua was not found'), 'it says Lua was not found, and how to get it')
}

step('plugins stay on after a restart')
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
;({ app, page } = await launch())
await page.waitForFunction(() => window.__cw.get().plugins?.plugins.some((p) => p.manifest.id === 'test.clash' && p.state === 'running'), null, { timeout: 20000 })
check(await page.evaluate(() => window.__cw.get().plugins.plugins.filter((p) => p.enabled).map((p) => p.manifest.id).sort().join()) ===
  'example.clip-length-lua,example.film-effects-ts,test.clash', 'the same plugins are on, and running')

await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
const real = errors.filter((e) => !/Autofill|DevTools|ERR_FILE_NOT_FOUND|Failed to load resource/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll plugin UI checks passed.')

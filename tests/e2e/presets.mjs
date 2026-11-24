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

// Presets UI test: save selected clips as a preset from the Tools window, use it in a new project (the
// "files need to be imported" question, No and Yes, the auto-import checkbox), check presets and the
// checkbox survive a restart, handle a file that has been moved, and export a preset as a zip and import
// it back (from the zip, and from preset.json once unzipped). Run with: npm run build && node tests/e2e/presets.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import yauzl from 'yauzl'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-preset-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const gen = (name, args) => {
  const out = join(dir, name)
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', ...args, out])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}
const files = {
  video: gen('take.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  mask: gen('mask.png', ['-f', 'lavfi', '-i', 'color=c=white:s=320x180', '-frames:v', '1'])
}
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [] }))
const userData = join(tmpdir(), 'clipworld-preset-userdata')
rmSync(userData, { recursive: true, force: true })

const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const allErrors = []

async function launch() {
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, CW_E2E_DIALOGS: dialogs }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => allErrors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && allErrors.push(m.text()))
  await page.waitForSelector('.menubar')
  await page.locator('.dv-tab', { hasText: 'Tools' }).click()
  return { app, page }
}
const freshProject = (page) => page.evaluate(() => {
  window.__cw.set({ dirty: false })
  window.__cw.actions.newProjectAction()
  window.__cw.player.seek(2)
})
const project = (page) => page.evaluate(() => {
  const s = window.__cw.get()
  return {
    media: s.project.media.map((m) => ({ id: m.id, name: m.name, missing: !!s.mediaCache[m.id]?.missing })),
    clips: s.project.clips.map((c) => ({ type: c.type, start: c.start, mediaId: c.mediaId, linkId: c.linkId, effects: c.effects }))
  }
})

let { app, page } = await launch()

step('save the selected clips as a preset')
check(await page.getByTestId('preset-save').count() === 0, 'with nothing selected, the section asks you to select clips')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  const items = await actions.importPaths([f.video, f.mask])
  const take = items.find((m) => m.name === 'take.mp4')
  const mask = items.find((m) => m.name === 'mask.png')
  actions.addToTimeline(take.id, 1)
  window.__cw.player.seek(1.5)
  actions.addTextAction({ content: 'Title' })
  const text = get().project.clips.find((c) => c.type === 'text')
  edit((p) => {
    const c = p.clips.find((x) => x.id === text.id)
    c.effects.push({ id: 'e1', type: 'imageMask', enabled: true, params: { image: mask.id } }, { id: 'e2', type: 'blur', enabled: true, params: { radius: 4 } })
  })
  const video = get().project.clips.find((c) => c.type === 'video')
  set({ selection: [video.id, text.id] })
}, files)
check((await page.getByTestId('preset-save').innerText()).includes('3'), 'offers to save 3 clips (the video brings its linked audio)')
await page.getByTestId('preset-new-name').fill('Lower third')
await page.getByTestId('preset-save').click()
await page.waitForSelector('[data-testid=preset-row]')
check(await page.getByTestId('preset-name').inputValue() === 'Lower third', 'the preset is listed by its name')
check(readdirSync(join(userData, 'presets')).length === 1, 'and saved to disk')

step('use it in a new project: answer No')
await freshProject(page)
await page.getByTestId('preset-apply').click()
await page.waitForSelector('[data-testid=preset-files]')
const asked = await page.locator('.modal').innerText()
check(asked.includes('The following files need to be imported to use this preset, would you like to import them now?'), 'asks the question')
check(asked.includes('take.mp4') && asked.includes('mask.png'), 'lists both files')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'presets-question.png') })
await page.getByTestId('preset-import-no').click()
let now = await project(page)
check(now.media.length === 0 && now.clips.length === 0, 'No adds nothing')

step('answer Yes, ticking "auto import media when using presets"')
await page.getByTestId('preset-apply').click()
await page.getByTestId('preset-always').check()
await page.getByTestId('preset-import-yes').click()
await page.waitForFunction(() => window.__cw.get().project.clips.length === 3, null, { timeout: 20000 })
now = await project(page)
check(now.media.map((m) => m.name).sort().join() === 'mask.png,take.mp4', 'both files were imported')
const video = now.clips.find((c) => c.type === 'video')
const text = now.clips.find((c) => c.type === 'text')
const playhead = await page.evaluate(() => window.__cw.player.time)
check(Math.abs(video.start - playhead) < 1e-6 && Math.abs(text.start - video.start - 0.5) < 1e-6, 'clips are placed at the playhead, keeping their spacing')
check(now.clips.filter((c) => c.linkId === video.linkId).length === 2, 'the video and its audio are still linked')
check(text.effects.map((e) => e.type).join() === 'imageMask,blur', 'effects came along')
check(text.effects[0].params.image === now.media.find((m) => m.name === 'mask.png').id, 'the mask uses the newly imported image')
check(await page.getByTestId('preset-auto-import').isChecked(), 'the auto import setting is now on')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'presets-tools.png') })

step('presets and the setting survive a restart')
await page.waitForTimeout(600)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
;({ app, page } = await launch())
check(await page.getByTestId('preset-row').count() === 1, 'the preset is still there')
check(await page.getByTestId('preset-auto-import').isChecked(), 'auto import is still on')
await freshProject(page)
await page.getByTestId('preset-apply').click()
await page.waitForFunction(() => window.__cw.get().project.clips.length === 3, null, { timeout: 20000 })
check(await page.locator('.modal').count() === 0, 'media is imported without asking')

step('a file that has moved since the preset was saved')
// Clicks the switch the way a user does: on its visible track.
await page.locator('label.toggle', { has: page.getByTestId('preset-auto-import') }).click()
check(!(await page.getByTestId('preset-auto-import').isChecked()), 'auto import is off again')
renameSync(files.mask, files.mask + '.moved')
await freshProject(page)
await page.getByTestId('preset-apply').click()
await page.waitForSelector('[data-testid=preset-files]')
const listed = await page.getByTestId('preset-files').innerText()
check(/mask\.png[\s\S]*(not found)/i.test(listed), 'the moved file is listed as not found')
await page.getByTestId('preset-import-yes').click()
await page.waitForFunction(() => window.__cw.get().project.clips.length === 3, null, { timeout: 20000 })
await page.waitForFunction(() => Object.values(window.__cw.get().mediaCache).some((c) => c.missing), null, { timeout: 10000 })
now = await project(page)
check(now.media.find((m) => m.name === 'mask.png')?.missing, 'it is added as missing media, ready to be located')
check(!(await page.getByTestId('preset-auto-import').isChecked()), 'answering without the checkbox leaves auto import off')
renameSync(files.mask + '.moved', files.mask)

step('export the preset as a zip, leaving one file out')
// Imported zips unpack into Documents/ClipWorld/Presets: point Documents at the test folder.
const docs = join(dir, 'docs')
await app.evaluate(({ app }, d) => app.setPath('documents', d), docs)
const zipPath = join(dir, 'shared', 'Lower third.zip')
mkdirSync(join(dir, 'shared'), { recursive: true })
writeFileSync(dialogs, JSON.stringify({ open: [], save: [zipPath] }))
await page.getByTestId('preset-export').click()
await page.waitForSelector('[data-testid=preset-export-files]')
const boxes = page.getByTestId('preset-export-file')
await page.waitForFunction(() => document.querySelectorAll('[data-testid=preset-export-file]:checked').length === 2)
check(await boxes.count() === 2, 'the export window lists both files, ticked')
await boxes.nth(1).uncheck()
check((await page.locator('.modal').innerText()).includes('1 file is left out'), 'and says what leaving one out means')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'presets-export.png') })
await page.getByTestId('preset-export-save').click()
await page.waitForFunction(() => !document.querySelector('[data-testid=preset-export-files]'), null, { timeout: 20000 })
check(existsSync(zipPath), 'the zip was saved')
const zip = await yauzl.openPromise(zipPath, { lazyEntries: true })
const entries = {}
for await (const entry of zip.eachEntry()) {
  const chunks = []
  for await (const c of await zip.openReadStreamPromise(entry)) chunks.push(c)
  entries[entry.fileName] = Buffer.concat(chunks)
}
zip.close()
check(Object.keys(entries).sort().join() === 'preset.json,take.mp4', `it holds preset.json and take.mp4 (${Object.keys(entries).join(', ')})`)
const json = JSON.parse(entries['preset.json'].toString('utf8'))
check(json.preset.media.map((m) => m.path).sort().join() === 'mask.png,take.mp4', 'preset.json names the files without folders')
check(!entries['preset.json'].toString('utf8').includes(dir.replace(/\\/g, '\\\\')), 'and holds no folder paths at all')

step('import the zip')
writeFileSync(dialogs, JSON.stringify({ open: [zipPath], save: [] }))
await page.getByTestId('preset-import').click()
await page.waitForFunction(() => window.__cw.get().presets.length === 2, null, { timeout: 20000 })
const imported = await page.evaluate(() => window.__cw.get().presets[1])
const unpacked = join(docs, 'ClipWorld', 'Presets', 'Lower third')
const takePath = imported.media.find((m) => m.name === 'take.mp4').path
check(takePath === join(unpacked, 'take.mp4') && existsSync(takePath), `take.mp4 is unpacked into Documents/ClipWorld/Presets/<preset name> (${takePath})`)
check(!existsSync(join(unpacked, 'mask.png')), 'the file that was left out is not there')
await freshProject(page)
await page.getByTestId('preset-apply').nth(1).click()
await page.waitForSelector('[data-testid=preset-files]')
check(/mask\.png[\s\S]*(not found)/i.test(await page.getByTestId('preset-files').innerText()), 'using it lists mask.png as not found')
await page.getByTestId('preset-import-yes').click()
await page.waitForFunction(() => window.__cw.get().project.clips.length === 3, null, { timeout: 20000 })
check(await page.evaluate((p) => window.__cw.get().project.media.some((m) => m.path === p), takePath), 'the project uses the unpacked take.mp4')

step('import preset.json from the unzipped folder')
const unzipped = join(dir, 'unzipped')
mkdirSync(unzipped, { recursive: true })
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar'
check(spawnSync(tar, ['-xf', zipPath, '-C', unzipped]).status === 0, 'unzipped it')
writeFileSync(dialogs, JSON.stringify({ open: [join(unzipped, 'preset.json')], save: [] }))
await page.getByTestId('preset-import').click()
await page.waitForFunction(() => window.__cw.get().presets.length === 3, null, { timeout: 20000 })
const fromJson = await page.evaluate(() => window.__cw.get().presets[2])
check(fromJson.media.find((m) => m.name === 'take.mp4').path === join(unzipped, 'take.mp4'), 'its files are used where they are, next to preset.json')

step('a file that is not a preset')
writeFileSync(join(dir, 'notes.json'), '{"hello": 1}')
writeFileSync(dialogs, JSON.stringify({ open: [join(dir, 'notes.json')], save: [] }))
await page.getByTestId('preset-import').click()
await page.waitForSelector('.toast.error')
check((await page.locator('.toast.error').last().innerText()).includes("notes.json isn't a ClipWorld preset"), 'says it is not a preset')
check(await page.evaluate(() => window.__cw.get().presets.length) === 3, 'and adds nothing')
// Back to the one preset for the steps below.
await page.evaluate(async () => {
  const [first, ...rest] = window.__cw.get().presets
  for (const p of rest) await window.cw.deletePreset(p.id)
  window.__cw.set({ presets: [first] })
})

step('rename and delete')
await page.getByTestId('preset-name').fill('Lower third (blue)')
await page.getByTestId('preset-name').press('Enter')
await page.waitForFunction(() => window.__cw.get().presets[0]?.name === 'Lower third (blue)')
check(true, 'renamed')
await page.getByTestId('preset-delete').click()
check(await page.getByTestId('preset-row').count() === 1, 'the first click only asks')
await page.getByTestId('preset-delete-confirm').click()
await page.waitForFunction(() => window.__cw.get().presets.length === 0)
check(readdirSync(join(userData, 'presets')).length === 0, 'deleted from disk too')

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = allErrors.filter((e) => !/Autofill|DevTools|ERR_FILE_NOT_FOUND|Failed to load resource/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll preset UI checks passed.')

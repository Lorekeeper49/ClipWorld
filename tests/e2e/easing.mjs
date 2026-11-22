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

// Easing graph and crop UI test: pick built-in easings, reshape a curve (drag a handle, add and remove
// points), save it as a preset (kept after a restart), crop from the Transform section, and check the
// preview against the export. Run with: npm run build && node tests/e2e/easing.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-easing-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const gen = (name, args) => {
  const out = join(dir, name)
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', ...args, out])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}
const files = {
  blue: gen('blue.png', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180', '-frames:v', '1']),
  red: gen('red.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p'])
}
const videoPath = join(dir, 'out.mp4')
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [videoPath] }))
const userData = join(tmpdir(), 'clipworld-easing-userdata')
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
const redClip = (page) => page.evaluate(() => window.__cw.get().project.clips.find((c) => c.type === 'video'))
const previewAt = (page, t, [x, y, w, h]) => page.evaluate(async ({ t, x, y, w, h }) => {
  const { player } = window.__cw
  player.pause()
  player.seek(t)
  for (let i = 0; i < 300 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
  const img = new Image()
  img.src = player.snapshot()
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, 320, 180)
  const d = ctx.getImageData(x, y, w, h).data
  const sum = [0, 0, 0]
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k]
  return sum.map((v) => Math.round(v / (d.length / 4)))
}, { t, x, y, w, h })
const exportAt = (t, [x, y, w, h]) => {
  const raw = spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-']).stdout
  return [raw[0], raw[1], raw[2]]
}
const near = (a, b, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
/** Where the red clip's left edge is along row y (first red pixel), in the preview and in the export. */
const firstRed = (rgb) => { for (let x = 0; x < 320; x++) if (rgb[x * 3] > 150 && rgb[x * 3 + 2] < 100) return x; return -1 }
const previewEdge = (page, t) => page.evaluate(async (t) => {
  const { player } = window.__cw
  player.pause()
  player.seek(t)
  for (let i = 0; i < 300 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
  for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
  const img = new Image()
  img.src = player.snapshot()
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 180
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, 320, 180)
  const d = ctx.getImageData(0, 90, 320, 1).data
  return Array.from({ length: 320 * 3 }, (_, i) => d[Math.floor(i / 3) * 4 + (i % 3)])
}, t).then(firstRed)
const exportEdge = (t) => firstRed(spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'crop=320:1:0:90,format=rgb24', '-f', 'rawvideo', '-']).stdout)

let { app, page } = await launch()

step('a red video over a blue picture, moving in from the left')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 30 } })
  const items = await actions.importPaths([f.blue, f.red])
  actions.addToTimeline(items[0].id, 0)
  edit((p) => { p.clips[0].duration = 4 })
  actions.addToTimeline(items[1].id, 0)
  const red = get().project.clips.find((c) => c.type === 'video')
  edit((p) => {
    const c = p.clips.find((x) => x.id === red.id)
    c.transform.animate = true
    c.transform.start.x = -1
    c.transform.end.x = 0
  })
  set({ selection: [red.id] })
}, files)
await page.locator('.dv-tab', { hasText: 'Tools' }).click()

step('the easing graph')
check((await page.getByTestId('ease-transform').innerText()).includes('Quad · In-out'), 'the Ease field shows the current easing by name')
await page.getByTestId('ease-transform').click()
await page.waitForSelector('[data-testid=ease-graph]')
check(await page.locator('[data-testid^=ease-preset-]').count() === 31, 'Linear and all 30 easings.net curves are listed')
await page.getByTestId('ease-preset-easeOutBounce').click()
check((await redClip(page)).transform.ease === 'easeOutBounce', 'picking one sets it on the clip')
check((await page.getByTestId('ease-current-name').innerText()) === 'Bounce · Out', 'and names it')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'easing-bounce.png') })

step('the motion strip keeps the dot in view')
/** Follows the dot for a full cycle: how far left and right it goes, relative to the strip and the window. */
const motionRange = () => page.evaluate(async () => {
  const strip = document.querySelector('[data-testid=ease-motion]').getBoundingClientRect()
  const modal = document.querySelector('.modal').getBoundingClientRect()
  const ticks = [...document.querySelectorAll('.ease-motion-tick')].map((t) => t.getBoundingClientRect().left + 1)
  let lo = Infinity
  let hi = -Infinity
  const t0 = performance.now()
  while (performance.now() - t0 < 2400) {
    const d = document.querySelector('[data-testid=ease-motion-dot]').getBoundingClientRect()
    lo = Math.min(lo, d.left)
    hi = Math.max(hi, d.right)
    await new Promise((r) => requestAnimationFrame(r))
  }
  return { lo, hi, strip: [strip.left, strip.right], modal: [modal.left, modal.right], ticks, center: (strip.left + strip.right) / 2 }
})
const plain = await motionRange()
check(Math.abs((plain.ticks[0] + plain.ticks[1]) / 2 - plain.center) < 2, 'the start-to-end line sits in the middle of the strip')
for (const name of ['easeOutElastic', 'easeInElastic', 'easeInOutBack']) {
  await page.getByTestId(`ease-preset-${name}`).click()
  const r = await motionRange()
  check(r.lo >= r.strip[0] - 1 && r.hi <= r.strip[1] + 1 && r.lo >= r.modal[0] && r.hi <= r.modal[1],
    `${name}: the dot stays in view (${Math.round(r.lo)}..${Math.round(r.hi)} within ${r.strip.map(Math.round).join('..')})`)
  check(r.hi > r.ticks[1] + 4 || r.lo < r.ticks[0] - 4, `${name}: and its swing past the start or end is visible`)
}

step('reshaping a curve')
await page.getByTestId('ease-preset-easeInOutSine').click()
const handle = page.locator('[data-testid=ease-handle-out]').first()
const hb = await handle.boundingBox()
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
await page.mouse.down()
await page.mouse.move(hb.x + 20, hb.y - 120, { steps: 6 })
await page.mouse.up()
let ease = (await redClip(page)).transform.ease
check(typeof ease === 'object' && ease.points.length === 2, 'dragging a handle turns it into a custom curve')
check((await page.getByTestId('ease-current-name').innerText()) === 'Custom curve', 'called "Custom curve"')
const graph = await page.getByTestId('ease-graph').boundingBox()
await page.mouse.dblclick(graph.x + graph.width * 0.5, graph.y + graph.height * 0.5)
check((await redClip(page)).transform.ease.points.length === 3, 'double-clicking adds a point')
await page.keyboard.press('Delete')
check((await redClip(page)).transform.ease.points.length === 2, 'Delete removes the selected point')
await page.mouse.dblclick(graph.x + graph.width * 0.6, graph.y + graph.height * 0.3)
check((await redClip(page)).transform.ease.points.length === 3, 'another point')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'easing-custom.png') })

step('saving it as a preset')
await page.getByTestId('ease-save-preset').click()
await page.getByTestId('ease-preset-name').fill('Snappy')
await page.getByTestId('ease-preset-save').click()
check(await page.getByTestId('ease-my-preset').innerText().then((s) => s.includes('Snappy')), 'it appears under My presets')
check((await page.getByTestId('ease-current-name').innerText()) === 'Snappy', 'and the clip\'s curve is now called by its name')
ease = (await redClip(page)).transform.ease
await page.getByTestId('ease-done').click()
check((await page.getByTestId('ease-transform').innerText()).includes('Snappy'), 'the Tools window shows it too')

step('crop, from the Transform section')
await page.getByTestId('tr-start-cropLeft').fill('25')
await page.getByTestId('tr-start-cropLeft').press('Enter')
await page.getByTestId('tr-end-cropLeft').fill('25')
await page.getByTestId('tr-end-cropLeft').press('Enter')
const c = await redClip(page)
check(c.transform.start.cropLeft === 0.25 && c.transform.end.cropLeft === 0.25, 'crop left 25% at the start and the end')
// At the end the clip sits in the middle: its left quarter (x 0..80) shows the blue underneath.
const LEFT = [10, 60, 50, 60]
const MID = [150, 60, 50, 60]
const pl = await previewAt(page, 3.9, LEFT)
const pm = await previewAt(page, 3.9, MID)
check(near(pl, [0, 0, 255]) && near(pm, [255, 0, 0]), `the preview crops it (${pl} | ${pm})`)

step('export matches the preview, curve and crop')
// Moments where the clip's (cropped) left edge is inside the frame.
const edges = []
for (const t of [1.6, 2.0, 2.4, 2.8, 3.2, 3.6]) {
  const x = await previewEdge(page, t)
  if (x > 2 && x < 318) edges.push([t, x])
}
check(edges.length >= 2, `the clip's edge is on screen at several moments mid-move (${edges.map(([t, x]) => `${t}s: x=${x}`).join(', ')})`)
await page.keyboard.press('Control+Shift+E')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'exported')
await page.getByTestId('export-close').click()
check(near(exportAt(3.9, LEFT), pl) && near(exportAt(3.9, MID), pm), 'crop matches')
for (const [t, x] of edges) {
  const e = exportEdge(t)
  check(Math.abs(e - x) <= 3, `at ${t} s the custom curve puts the clip's edge at the same place: export x=${e}, preview x=${x}`)
}

step('a crash inside a dialog stays inside it')
await page.evaluate(() => {
  const { get, set } = window.__cw
  // A target the editor can't read: its window fails, the rest of the app must not.
  set({ modal: 'ease', easeTarget: { clipId: get().project.clips[0].id, field: 'nope' } })
})
await page.waitForSelector('[data-testid=crashed]')
check(await page.locator('.menubar').isVisible() && await page.locator('[data-panel=timeline]').isVisible(), 'the app stays on screen with a message')
await page.locator('[data-testid=crashed] button').click()
check(await page.locator('[data-testid=crashed]').count() === 0, 'and Try again closes the failed dialog')
const real0 = errors.length
errors.splice(0, real0, ...errors.filter((e) => !/nope|A window crashed|Cannot read properties of undefined/.test(e)))

step('typed values can go past the sliders')
const typeInto = async (testId, value) => {
  const box = page.getByTestId(testId)
  await box.fill(String(value))
  await box.press('Enter')
}
const before = await redClip(page)
await typeInto('speed', 1500)
let after = await redClip(page)
check(Math.abs(after.speed - 15) < 1e-6, `Speed takes 1500% (the slider stops at 800%)`)
check(Math.abs(after.duration - before.duration * before.speed / 15) < 1e-3, 'and the clip gets shorter to match, as dragging its edge would')
await typeInto('speed', 5000)
check(Math.abs((await redClip(page)).speed - 20) < 1e-6, 'it stops at 2000%, the same limit as dragging')
await typeInto('speed', 2)
check(Math.abs((await redClip(page)).speed - 0.05) < 1e-6, 'and at 5% the other way')
await typeInto('speed', 100)
await typeInto('tr-start-rotation', 1080)
check((await redClip(page)).transform.start.rotation === 1080, 'Rotation takes three full turns (the old box stopped at 720°)')
await typeInto('tr-start-opacity', 250)
check((await redClip(page)).transform.start.opacity === 1, 'Opacity still stops at 100%')
await typeInto('tr-start-rotation', 0)
await page.locator('.dv-tab', { hasText: 'Properties' }).click()
await typeInto('prop-speed', 1200)
check(Math.abs((await redClip(page)).speed - 12) < 1e-6, 'the Speed box in Properties takes 1200% too')
await typeInto('prop-speed', 100)
await page.locator('.dv-tab', { hasText: 'Tools' }).click()

step('presets are kept after a restart')
await page.waitForTimeout(600)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
;({ app, page } = await launch())
const kept = await page.evaluate(() => window.__cw.get().settings.easePresets)
check(kept?.length === 1 && kept[0].name === 'Snappy' && JSON.stringify(kept[0].curve) === JSON.stringify(ease), 'Snappy is still there, with the same curve')

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll easing UI checks passed.')

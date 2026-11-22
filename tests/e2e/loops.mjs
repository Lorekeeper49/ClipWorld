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

// Loop UI test: Ctrl+drag a clip edge to loop it, then use the Properties window (count, loop points,
// intro, outro, crossfade warning, pitch), and check the preview against the exported video.
// Run with: npm run build && node tests/e2e/loops.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-loop-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
// Four seconds: red, green, blue, white, each with its own tone.
const COLORS = ['0xff0000', '0x00ff00', '0x0000ff', '0xffffff']
const source = join(dir, 'beat.mp4')
{
  const graph = COLORS.map((c, i) => `color=c=${c}:s=320x180:r=30:d=1[v${i}];sine=f=${300 + 200 * i}:d=1:sample_rate=48000[a${i}]`).join(';') +
    `;${COLORS.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=4:v=1:a=1[v][a]`
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', source])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}
const videoPath = join(dir, 'out.mp4')
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [videoPath] }))
const userData = join(tmpdir(), 'clipworld-loop-userdata')
rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env: { ...process.env, CW_E2E_DIALOGS: dialogs } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.menubar')
const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(2).slice(i - 1, i + 1), 16))
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
/** Clicks a switch the way a user does: on its visible track. */
const toggle = (testId) => page.locator('label.toggle', { has: page.getByTestId(testId) }).click()
const clips = () => page.evaluate(() => window.__cw.get().project.clips.map((c) => ({ id: c.id, type: c.type, start: c.start, duration: c.duration, srcIn: c.srcIn, loop: c.loop, effects: c.effects })))

const previewAt = (t) => page.evaluate(async (t) => {
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
  const d = ctx.getImageData(110, 50, 100, 80).data
  const sum = [0, 0, 0]
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k]
  return sum.map((v) => Math.round(v / (d.length / 4)))
}, t)
const exportAt = (t) => {
  const raw = spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'crop=100:80:110:50,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-']).stdout
  return [raw[0], raw[1], raw[2]]
}

step('a clip showing the green second of the file')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 30 } })
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  edit((p) => { for (const c of p.clips) Object.assign(c, { srcIn: 1, duration: 1 }) })
  set({ selection: get().project.clips.map((c) => c.id), pps: 60 })
}, source)
await page.waitForFunction(() => window.__cw.get().project.media.every((m) => window.__cw.get().mediaCache[m.id]?.audioUrls?.[0]), null, { timeout: 30000 })

step('Ctrl+drag the end edge two seconds to the right')
const edge = page.locator('[data-clip-type=video] [data-testid=clip-edge-end]')
const box = await edge.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.keyboard.down('Control')
await page.mouse.down()
for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + box.height / 2)
await page.mouse.up()
await page.keyboard.up('Control')
let now = await clips()
const v = now.find((c) => c.type === 'video')
const a = now.find((c) => c.type === 'audio')
check(v.loop && Math.abs(v.loop.count - 3) < 0.1 && Math.abs(v.duration - 3) < 0.1, `the clip now loops about 3 times (${v.loop?.count})`)
check(a.loop && Math.abs(a.loop.count - v.loop.count) < 1e-9, 'its audio loops with it')
check(Math.abs(v.loop.start - 1) < 1e-6 && Math.abs(v.loop.end - 2) < 1e-6, 'looping what the clip showed (1 s to 2 s of the file)')
check(await page.locator('[data-clip-type=video] [data-testid=clip-loop]').innerText().then((s) => s.includes('3')), 'the clip shows a loop badge')
check(near(await previewAt(2.5), rgb(COLORS[1])), 'the preview still shows the green second near the end')

step('Properties: count, intro and outro')
await page.locator('.dv-tab', { hasText: 'Properties' }).click()
check(await page.getByTestId('prop-loop').isChecked(), 'the Loop switch is on')
await page.getByTestId('prop-loop-count').fill('2')
await page.getByTestId('prop-loop-count').press('Enter')
await toggle('prop-intro')
await toggle('prop-outro')
now = await clips()
check(Math.abs(now.find((c) => c.type === 'video').duration - 5) < 1e-6, 'intro + 2 loops + outro = 1 + 2 + 2 seconds')
check(await page.getByTestId('prop-partial-warning').count() === 0, 'no warning for a whole number of loops')

step('a partial loop into the outro warns and crossfades')
await page.getByTestId('prop-loop-count').fill('1.5')
await page.getByTestId('prop-loop-count').press('Enter')
check(await page.getByTestId('prop-partial-warning').isVisible(), 'the partial-loop warning is shown')
check((await page.getByTestId('prop-partial-warning').innerText()).includes('may not sound right'), 'and says it may not sound right')
await page.getByTestId('prop-crossfade').fill('0.4')
await page.getByTestId('prop-crossfade').press('Enter')
await page.screenshot({ path: join(root, 'tests', '.tmp', 'loops-properties.png') })
// Timeline: 0-1 red intro, 1-2 green, 2-2.5 green (half pass), 2.5-2.9 fade to blue, then blue to 4.0, white to 4.5.
const points = [0.5, 1.5, 2.2, 2.7, 3.3, 4.2]
const preview = []
for (const t of points) preview.push(await previewAt(t))
check(near(preview[0], rgb(COLORS[0])) && near(preview[1], rgb(COLORS[1])) && near(preview[2], rgb(COLORS[1])), 'preview: intro, then the loop')
check(near(preview[3], [0, 128, 128], 50), `preview: half way through the crossfade (${preview[3]})`)
check(near(preview[4], rgb(COLORS[2])) && near(preview[5], rgb(COLORS[3])), 'preview: the outro')

step('pitch')
await page.getByTestId('prop-pitch').fill('-3')
await page.getByTestId('prop-pitch').press('Enter')
now = await clips()
check(now.find((c) => c.type === 'audio').effects.some((e) => e.type === 'pitch' && e.params.semitones === -3), 'pitch adds a pitch shift to the sound')
await page.getByTestId('prop-pitch').fill('0')
await page.getByTestId('prop-pitch').press('Enter')
check(!(await clips()).find((c) => c.type === 'audio').effects.some((e) => e.type === 'pitch'), 'and 0 removes it')

step('export matches the preview')
await page.keyboard.press('Control+Shift+E')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'exported')
await page.getByTestId('export-close').click()
for (const [i, t] of points.entries()) {
  const e = exportAt(t)
  check(near(e, preview[i], 30), `at ${t} s export ${e} matches preview ${preview[i]}`)
}

step('no room: the next clip blocks a longer loop')
await page.evaluate(() => {
  const { edit, get, set } = window.__cw
  const v = get().project.clips.find((c) => c.type === 'video')
  edit((p) => { p.clips.push({ ...structuredClone(v), id: 'blocker', linkId: undefined, loop: undefined, start: 5, duration: 1 }) })
  set({ selection: [v.id] })
})
await page.getByTestId('prop-loop-count').fill('4')
await page.getByTestId('prop-loop-count').press('Enter')
await page.waitForSelector('[data-testid=toast].error')
check(Math.abs((await clips()).find((c) => c.type === 'video').loop.count - 1.5) < 1e-9, 'the loop is unchanged and a message explains why')

step('turning the loop off')
await toggle('prop-loop')
check(!(await clips()).find((c) => c.type === 'video' && c.id !== 'blocker').loop, 'the clip plays straight through again')
check(await page.locator('[data-testid=clip-loop]').count() === 0, 'and the badge is gone')

step('playing across loop passes')
await page.evaluate(() => {
  const { edit, get } = window.__cw
  const v = get().project.clips.find((c) => c.type === 'video' && c.id !== 'blocker')
  edit((p) => { p.clips = p.clips.filter((c) => c.id !== 'blocker') })
  window.__cw.set({ selection: [v.id] })
})
await toggle('prop-loop')
await page.getByTestId('prop-loop-count').fill('3')
await page.getByTestId('prop-loop-count').press('Enter')
const played = await page.evaluate(async () => {
  const { player } = window.__cw
  player.seek(0.5)
  player.play()
  const t0 = performance.now()
  await new Promise((r) => setTimeout(r, 2500))
  const moved = player.time - 0.5
  player.pause()
  return { moved, wall: (performance.now() - t0) / 1000 }
})
check(played.moved > played.wall * 0.8, `playback keeps up across loop passes (${played.moved.toFixed(2)} s in ${played.wall.toFixed(2)} s)`)

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll loop UI checks passed.')

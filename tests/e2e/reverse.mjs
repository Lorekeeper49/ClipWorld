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

// Reverse and go-to-time UI test: type a negative speed, check the timeline, the paused preview, playback
// from the reversed copies and the export; then jump the playhead with the timeline's time box.
// Run with: npm run build && node tests/e2e/reverse.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-reverse-test')
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
const userData = join(tmpdir(), 'clipworld-reverse-userdata')
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
const clips = () => page.evaluate(() => window.__cw.get().project.clips.map((c) => ({ id: c.id, type: c.type, start: c.start, duration: c.duration, srcIn: c.srcIn, speed: c.speed, reverse: !!c.reverse })))
const color = () => page.evaluate(async () => {
  const img = new Image()
  img.src = window.__cw.player.snapshot()
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
})
const previewAt = async (t) => {
  await page.evaluate(async (t) => {
    const { player } = window.__cw
    player.pause()
    player.seek(t)
    for (let i = 0; i < 300 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r))
  }, t)
  return color()
}
const exportAt = (t) => {
  const raw = spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'crop=100:80:110:50,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', '-']).stdout
  return [raw[0], raw[1], raw[2]]
}

step('the whole file on the timeline, selected')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 30 } })
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  set({ selection: get().project.clips.map((c) => c.id), pps: 60 })
}, source)
await page.waitForFunction(() => window.__cw.get().project.media.every((m) => window.__cw.get().mediaCache[m.id]?.audioUrls?.[0]), null, { timeout: 30000 })

step('type -100% into the speed box')
await page.evaluate(() => window.__cw.showPanel('properties'))
const speedBox = page.getByTestId('prop-speed')
await speedBox.click()
await speedBox.fill('-100')
await speedBox.press('Enter')
let cs = await clips()
check(cs.every((c) => c.reverse && Math.abs(c.speed - 1) < 1e-6), 'the video and its sound both play backwards at 100%')
check(cs.every((c) => Math.abs(c.duration - 4) < 0.01 && Math.abs(c.srcIn) < 1e-6), 'the clip keeps its length and part of the file')
check((await speedBox.inputValue()) === '-100', 'the box shows -100')
const badge = await page.locator('[data-clip-type=video] [data-testid=clip-speed]').innerText()
check(badge.includes('◀') && badge.includes('-100%'), `the timeline shows a backwards badge (${badge})`)
check(await page.getByTestId('reverse-note').isVisible(), 'the Properties window says it plays backwards')

step('paused preview shows the file backwards')
for (const [t, sec] of [[0.5, 3], [1.5, 2], [2.5, 1], [3.5, 0]]) {
  const c = await previewAt(t)
  check(near(c, rgb(COLORS[sec])), `at ${t}s the preview shows second ${sec} (${c})`)
}

step('the reversed copies get built in the background')
await page.waitForFunction(() => {
  const s = window.__cw.get()
  const m = s.project.media[0]
  const cache = s.mediaCache[m.id]
  return cache?.reverse && cache.reverse.done.length >= cache.reverse.count && cache.reverseAudio?.[0]
}, null, { timeout: 60000 })
check(true, 'reversed picture chunks and reversed sound are ready')

step('playing: picture and sound come from the reversed copies')
const samples = await page.evaluate(async () => {
  const { player, get } = window.__cw
  player.seek(0)
  player.play()
  const out = []
  const audioId = get().project.clips.find((c) => c.type === 'audio').id
  const start = performance.now()
  while (performance.now() - start < 3600 && player.playing) {
    await new Promise((r) => setTimeout(r, 120))
    out.push({ t: player.time, src: Object.values(player.sources())[0], level: player.level(audioId) })
  }
  player.pause()
  return out
})
check(samples.length > 10 && samples.filter((s) => s.src === 'reverse').length >= samples.length - 2, `the picture plays from reversed chunks (${samples.map((s) => s.src).join(',')})`)
check(samples.filter((s) => s.level > 0.01).length >= samples.length / 2, 'the sound plays')

step('the picture while playing matches the time')
const playing = await page.evaluate(async () => {
  const { player } = window.__cw
  player.seek(0.2)
  player.play()
  const out = []
  for (const at of [0.6, 1.6, 2.6, 3.4]) {
    while (player.time < at && player.playing) await new Promise((r) => requestAnimationFrame(r))
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
    out.push({ t: player.time, c: sum.map((v) => Math.round(v / (d.length / 4))) })
  }
  player.pause()
  return out
})
for (const { t, c } of playing) {
  const sec = 3 - Math.floor(t)
  check(near(c, rgb(COLORS[sec]), 60), `at ${t.toFixed(2)}s while playing: second ${sec} (${c})`)
}

step('export matches the preview')
await page.evaluate(() => window.__cw.set({ modal: 'export' }))
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'exported')
await page.getByTestId('export-close').click()
for (const t of [0.5, 1.5, 2.5, 3.5]) {
  const p = await previewAt(t)
  const e = exportAt(t)
  check(near(p, e, 30), `at ${t}s preview ${p} = export ${e}`)
}

step('split a reversed clip: both halves keep their pictures')
await page.evaluate(() => {
  const { player, actions } = window.__cw
  player.seek(1.5)
  actions.splitAction()
})
cs = await clips()
check(cs.length === 4 && cs.every((c) => c.reverse), 'four reversed pieces')
for (const [t, sec] of [[0.5, 3], [1.2, 2], [1.8, 2], [3.5, 0]]) {
  const c = await previewAt(t)
  check(near(c, rgb(COLORS[sec])), `after the split, ${t}s still shows second ${sec}`)
}

step('back to a positive speed')
await page.evaluate(() => {
  const { actions, get, set } = window.__cw
  actions.undo()
  set({ selection: get().project.clips.map((c) => c.id) })
})
await speedBox.click()
await speedBox.fill('100')
await speedBox.press('Enter')
cs = await clips()
check(cs.every((c) => !c.reverse), 'plays forwards again')
check(near(await previewAt(0.5), rgb(COLORS[0])), 'second 0 is first again')

step('go to a time: preview format, seconds, minutes:seconds, nonsense, Ctrl+G')
const box = page.getByTestId('goto-time')
const time = () => page.evaluate(() => window.__cw.player.time)
await box.click()
await box.fill('00:02:15')
await box.press('Enter')
check(Math.abs((await time()) - 2.5) < 1e-6, '00:02:15 → 2.5 s')
check((await box.inputValue()) === '00:02:15', 'the box shows the time it went to')
await box.fill('1.25')
await page.getByTestId('goto-button').click()
check(Math.abs((await time()) - 1.25) < 1e-6, '1.25 → 1.25 s (with the button)')
await box.fill('0:03')
await box.press('Enter')
check(Math.abs((await time()) - 3) < 1e-6, '0:03 → 3 s')
await box.fill('soon')
await box.press('Enter')
check(Math.abs((await time()) - 3) < 1e-6 && (await box.getAttribute('class')).includes('invalid'), 'nonsense is turned down and the playhead stays')
await box.fill('99')
await box.press('Enter')
check(Math.abs((await time()) - 4) < 1e-6, 'past the end stops at the end')
await box.press('Escape')
await page.locator('.preview-stage').click({ position: { x: 5, y: 5 } }).catch(() => {})
await page.evaluate(() => window.__cw.player.pause())
await page.locator('body').click({ position: { x: 2, y: 2 } })
await page.keyboard.press('Control+g')
check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'goto-time'), 'Ctrl+G puts the cursor in the box')

check(errors.length === 0, `no errors in the page${errors.length ? ': ' + errors.join(' | ') : ''}`)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
console.log('\nreverse test passed')

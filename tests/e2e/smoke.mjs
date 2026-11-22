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

// UI smoke test: launches the built app, drives the main editing flow and saves screenshots.
// Run with: npm run build && node tests/e2e/smoke.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, ffprobe } from './tools.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const tmp = join(root, 'tests', '.tmp', 'e2e')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

// A 6 s clip with two named audio tracks.
const src = join(tmp, 'two-tracks.mkv')
spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6',
  '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-f', 'lavfi', '-i', 'sine=f=660:d=6',
  // Keyframes 5 s apart, like a screen/game recording, so the fast-seek preview copy gets built.
  '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '150', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-metadata:s:a:0', 'title=Game', '-metadata:s:a:1', 'title=Voice', src])

const projectPath = join(tmp, 'demo.vcws')
const exportPath = join(tmp, 'demo-export.mp4')
const dialogs = join(tmp, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [[src]], save: [projectPath, exportPath] }))

const userData = join(tmpdir(), 'clipworld-e2e-userdata')
rmSync(userData, { recursive: true, force: true })
const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
  env: { ...process.env, CW_E2E_DIALOGS: dialogs }
})
const errors = []
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.setViewportSize({ width: 1600, height: 950 }).catch(() => {})
await page.waitForSelector('.menubar', { timeout: 20000 })
const shot = (name) => page.screenshot({ path: join(tmp, `${name}.png`) })
const step = (msg) => console.log('•', msg)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }

step('boot')
check(await page.locator('.menubar-status:not(.bad)').count() === 1, 'ffmpeg detected')
for (const t of ['Media', 'Preview', 'Tools', 'Audio', 'Timeline']) {
  check(await page.locator('.dv-tab', { hasText: t }).count() >= 1, `panel tab "${t}" present`)
}
await shot('01-empty')

step('import a video with two audio tracks')
await page.getByTestId('import-media').click()
await page.waitForSelector('[data-testid=media-item]')
await page.waitForFunction(() => document.querySelectorAll('[data-testid=media-audio-track]:not(.pending)').length === 2, null, { timeout: 30000 })
check(await page.getByTestId('media-audio-track').count() === 2, 'both audio tracks extracted and listed')

step('add to timeline')
await page.getByTestId('media-add').click()
check(await page.locator('[data-clip-type=video]').count() === 1, 'one video clip')
check(await page.locator('[data-clip-type=audio]').count() === 2, 'two linked audio clips')
check(await page.getByTestId('audio-row').count() === 2, 'Audio panel shows both tracks of the selected video')

step('optional fast-seek preview copy')
const sourceShown = async () => {
  await page.waitForFunction(() => window.__cw.player.ready(), null, { timeout: 15000 })
  return page.evaluate(() => Object.values(window.__cw.player.sources())[0])
}
const chunkState = () => page.evaluate(() => {
  const s = window.__cw.get()
  return s.mediaCache[s.project.media[0].id]?.chunks
})
await page.waitForTimeout(2000)
const ki = await page.evaluate(() => window.__cw.get().project.media[0].keyframeInterval)
check(!(await chunkState()) && Math.abs(ki - 5) < 0.1, `nothing built automatically, even with keyframes ${ki} s apart`)
await page.evaluate(() => window.__cw.player.seek(3.2))
check(await sourceShown() === 'original', 'preview uses the original file')
await page.getByTestId('fast-seek-on').click()
await page.waitForFunction(() => {
  const s = window.__cw.get()
  const ch = s.mediaCache[s.project.media[0].id]?.chunks
  return ch && ch.done.length === ch.count
}, null, { timeout: 60000 })
check(await page.locator('[data-testid=media-status]', { hasText: 'Optimized for fast seeking' }).count() === 1, 'clicking the button builds the copy')
await page.evaluate(() => window.__cw.player.seek(3.3))
check(await sourceShown() === 'chunk', 'preview switches to the fast-seek copy')
await page.keyboard.press('Control+Z')
await page.waitForFunction(() => !window.__cw.get().mediaCache[window.__cw.get().project.media[0].id]?.chunks, null, { timeout: 10000 })
await page.evaluate(() => window.__cw.player.seek(3.2))
check(await sourceShown() === 'original' && await page.getByTestId('fast-seek-on').count() === 1, 'undo turns it off again')
await page.keyboard.press('Control+Y')
await page.waitForFunction(() => window.__cw.get().mediaCache[window.__cw.get().project.media[0].id]?.chunks?.done.length > 0, null, { timeout: 10000 })
await page.evaluate(() => window.__cw.player.seek(3.3))
check(await sourceShown() === 'chunk', 'redo turns it back on, reusing the finished copy')
await page.waitForTimeout(1500)
await shot('02-imported')

step('split with Ctrl+K at 2 s')
await page.evaluate(() => window.__cw.player.seek(2))
await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
await page.evaluate(() => window.__cw.set({ selection: [] }))
await page.keyboard.press('Control+K')
check(await page.locator('[data-clip-type=video]').count() === 2, 'video split into two')
check(await page.locator('[data-clip-type=audio]').count() === 4, 'audio split with it')

step('rate-stretch: drag the right clip’s end edge')
const right = page.locator('[data-clip-type=video]').nth(1)
const pps = await page.evaluate(() => window.__cw.get().pps)
const edge = right.getByTestId('clip-edge-end')
const box = await edge.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2 + 2 * pps, box.y + box.height / 2, { steps: 8 })
await page.mouse.up()
const speeds = await page.evaluate(() => window.__cw.get().project.clips.filter((c) => c.start >= 1.99).map((c) => c.speed))
check(speeds.length === 3 && speeds.every((s) => Math.abs(s - 4 / 6) < 0.03), `right half and its audio slowed to ~67% (got ${speeds.map((s) => s.toFixed(3))})`)

step('copy / paste at playhead')
await page.evaluate(() => { const c = window.__cw.get().project.clips.find((x) => x.type === 'video' && x.start < 1); window.__cw.set({ selection: [c.id] }); window.__cw.player.seek(10) })
await page.keyboard.press('Control+C')
await page.keyboard.press('Control+V')
check(await page.locator('[data-clip-type=video]').count() === 3, 'pasted a third video clip')
await page.keyboard.press('Control+Z')
check(await page.locator('[data-clip-type=video]').count() === 2, 'undo removed it')

step('set Voice track to 250%')
await page.evaluate(() => { const c = window.__cw.get().project.clips.find((x) => x.type === 'video'); window.__cw.set({ selection: [c.id] }) })
const vol = page.getByTestId('volume-input').nth(1)
await vol.fill('250')
await vol.press('Enter')
const vols = await page.evaluate(() => window.__cw.get().project.clips.filter((c) => c.type === 'audio' && c.start < 1).map((c) => c.volume))
check(vols.includes(2.5) && vols.includes(1), `per-track volume ${vols}`)

step('add text and a filter')
await page.evaluate(() => window.__cw.player.seek(0.5))
await page.getByTestId('add-text').click()
await page.getByTestId('text-content').fill('Hello ClipWorld')
await page.getByTestId('add-effect').selectOption('dropShadow')
await page.evaluate(() => { const c = window.__cw.get().project.clips.find((x) => x.type === 'video'); window.__cw.set({ selection: [c.id] }) })
await page.getByTestId('add-effect').selectOption('sepia')
await page.getByTestId('add-effect').selectOption('vignette')
check(await page.getByTestId('effect').count() === 2, 'two stacked effects on the video')
await page.evaluate(() => window.__cw.player.seek(1))
await page.waitForFunction(() => window.__cw.player.ready(), null, { timeout: 15000 })
await page.waitForTimeout(400)
await shot('03-edited')

step('metadata: 1280x720 @ 24 fps')
await page.locator('.dv-tab', { hasText: 'Metadata' }).click()
await page.getByTestId('resolution-preset').selectOption('1280x720')
await page.getByTestId('fps-preset').selectOption('24')
await shot('04-metadata')

step('save .vcws')
await page.keyboard.press('Control+S')
await page.waitForFunction(() => !window.__cw.get().dirty, null, { timeout: 10000 })
check(existsSync(projectPath), 'project file written')

step('play briefly')
await page.evaluate(() => { window.__cw.player.seek(0); window.__cw.player.play() })
await page.waitForTimeout(1500)
const t = await page.evaluate(() => { const t = window.__cw.player.time; window.__cw.player.pause(); return t })
check(t > 0.8, `playhead advanced during playback (${t.toFixed(2)} s)`)

step('export with Ctrl+Shift+E')
await page.keyboard.press('Control+Shift+E')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'export finished')
await shot('05-exported')
await page.getByTestId('export-close').click()

const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', exportPath])
const info = JSON.parse(probe.stdout.toString())
const v = info.streams.find((s) => s.codec_type === 'video')
check(v.width === 1280 && v.height === 720 && v.r_frame_rate === '24/1', `export is 1280x720 @ 24 fps`)
const dur = Number(info.format.duration)
check(Math.abs(dur - 8) < 0.15, `export duration ${dur.toFixed(2)} s (2 s + 6 s stretched half)`)

step('reopen project')
await page.evaluate((p) => window.__cw.actions.openProjectAction(p), projectPath)
await page.waitForFunction(() => window.__cw.get().project.clips.length === 7, null, { timeout: 10000 })
check(true, 'reopened with all 7 clips')
await page.waitForFunction(() => {
  const s = window.__cw.get()
  const ch = s.mediaCache[s.project.media[0].id]?.chunks
  return s.project.media[0].fastSeek && ch && ch.done.length === ch.count
}, null, { timeout: 15000 })
check(true, 'fast seeking stays on after reopening, using the saved copy')

step('delete media removes its clips')
await page.locator('[data-testid=media-item]').hover()
await page.getByTestId('media-delete').click()
const left = await page.evaluate(() => window.__cw.get().project.clips.map((c) => c.type))
check(left.length === 1 && left[0] === 'text', 'only the text clip remains')

await app.evaluate(({ app }) => app.exit(0))
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) {
  console.log('Renderer errors:\n' + real.join('\n'))
  process.exit(1)
}
console.log('\nAll UI checks passed. Screenshots in', tmp)

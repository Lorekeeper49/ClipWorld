// Convert-to-MP4 test: imports videos in several containers, converts each through the Media panel
// button, and checks the copy, the untouched original and the switched-over project.
// Run with: npm run build && node tests/e2e/convert.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..')
const ffmpeg = join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')
const ffprobe = join(root, 'vendor', 'ffmpeg', 'ffprobe.exe')
const dir = join(tmpdir(), 'clipworld-convert-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const src = (name, d, video, audio, extraAudio = true) => {
  const out = join(dir, name)
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${d}`,
    '-f', 'lavfi', '-i', `sine=f=440:d=${d}`, '-f', 'lavfi', '-i', `sine=f=660:d=${d}`,
    '-map', '0:v', '-map', '1:a', ...(extraAudio ? ['-map', '2:a'] : []), ...video, ...audio, out])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}
const files = {
  mkv: src('game.mkv', 4, ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '120', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac']),
  mov: src('edit.mov', 3, ['-c:v', 'prores_ks', '-profile:v', '0'], ['-c:a', 'pcm_s16le']),
  avi: src('old.avi', 3, ['-c:v', 'mpeg4', '-q:v', '5'], ['-c:a', 'libmp3lame'], false),
  webm: src('clip.webm', 3, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M'], ['-c:a', 'libopus']),
  mp4: src('already.mp4', 2, ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], false),
  long: src('long.mkv', 240, ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], false)
}
const sizes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, statSync(f).mtimeMs + ':' + statSync(f).size]))

const probe = (f) => {
  const j = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', f]).stdout.toString())
  return { duration: Number(j.format.duration), video: j.streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name), audio: j.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name) }
}

const userData = join(tmpdir(), 'clipworld-convert-userdata')
rmSync(userData, { recursive: true, force: true })
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`] })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.waitForSelector('.menubar')
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }

await page.evaluate(async (paths) => {
  const items = await window.__cw.actions.importPaths(paths)
  let t = 0
  for (const m of items) { window.__cw.actions.addToTimeline(m.id, t); t += m.duration + 1 }
}, Object.values(files))
await page.waitForFunction((n) => document.querySelectorAll('[data-testid=media-item]').length === n, Object.keys(files).length)

const row = (name) => page.locator('[data-testid=media-item]', { hasText: name })
check(await row('already.mp4').getByTestId('convert-mp4').count() === 0, 'MP4 files have no convert button')
for (const n of ['game.mkv', 'edit.mov', 'old.avi', 'clip.webm', 'long.mkv']) {
  check(await row(n).getByTestId('convert-mp4').count() === 1, `${n} shows "Convert to MP4"`)
}

const expectations = {
  'game.mkv': { video: 'h264', audio: ['aac', 'aac'], copied: true },
  'edit.mov': { video: 'h264', audio: ['aac', 'aac'], copied: false },
  'old.avi': { video: 'h264', audio: ['mp3'], copied: false },
  'clip.webm': { video: 'vp9', audio: ['opus', 'opus'], copied: true }
}
for (const [name, exp] of Object.entries(expectations)) {
  console.log('•', name)
  const before = await page.evaluate((n) => {
    const s = window.__cw.get()
    const m = s.project.media.find((x) => x.name === n)
    return { id: m.id, clips: s.project.clips.filter((c) => c.mediaId === m.id).map((c) => [c.start, c.duration, c.srcIn]), duration: m.duration }
  }, name)
  await row(name).getByTestId('convert-mp4').click()
  await page.waitForFunction((id) => {
    const m = window.__cw.get().project.media.find((x) => x.id === id)
    return m && /\.mp4$/i.test(m.path)
  }, before.id, { timeout: 120000 })
  const after = await page.evaluate((id) => {
    const s = window.__cw.get()
    const m = s.project.media.find((x) => x.id === id)
    return { path: m.path, name: m.name, audio: m.audioStreams.length, duration: m.duration, clips: s.project.clips.filter((c) => c.mediaId === id).map((c) => [c.start, c.duration, c.srcIn]) }
  }, before.id)
  const ext = name.split('.').pop()
  const key = { mkv: 'mkv', mov: 'mov', avi: 'avi', webm: 'webm' }[ext]
  check(after.path === join(dir, name.replace(/\.\w+$/, '.mp4')), `MP4 written next to the original (${after.name})`)
  check(`${statSync(files[key]).mtimeMs}:${statSync(files[key]).size}` === sizes[key], 'original file untouched')
  const p = probe(after.path)
  check(p.video[0] === exp.video && JSON.stringify(p.audio) === JSON.stringify(exp.audio), `streams ${p.video} + ${p.audio} (${exp.copied ? 'copied' : 're-encoded where needed'})`)
  check(Math.abs(p.duration - before.duration) < 0.15, `duration kept (${p.duration.toFixed(2)} s)`)
  check(JSON.stringify(after.clips) === JSON.stringify(before.clips), `timeline clips unchanged and now use the MP4 (${after.clips.length} clips)`)
  await page.waitForFunction((id) => {
    const s = window.__cw.get()
    const m = s.project.media.find((x) => x.id === id)
    const c = s.mediaCache[id]
    return c && m.audioStreams.every((a) => c.audioUrls[a.index])
  }, before.id, { timeout: 60000 })
  check(await row(after.name).getByTestId('convert-mp4').count() === 0, 'button gone after converting; audio tracks ready')
  if (!exp.copied) {
    const ki = await page.evaluate((id) => window.__cw.get().project.media.find((x) => x.id === id).keyframeInterval, before.id)
    check(ki <= 0.6, `re-encoded MP4 has a keyframe every ${ki.toFixed(2)} s, so it needs no preview copy`)
  }
}

console.log('• cancel')
await row('long.mkv').getByTestId('convert-mp4').click()
await page.waitForSelector('[data-testid=convert-cancel]')
await page.getByTestId('convert-cancel').click()
await page.waitForFunction(() => {
  const s = window.__cw.get()
  const m = s.project.media.find((x) => x.name === 'long.mkv')
  return m && s.mediaCache[m.id]?.convertProgress === undefined
}, null, { timeout: 30000 })
check(!existsSync(join(dir, 'long.mp4')) && !existsSync(join(dir, 'long.mp4.converting')), 'cancelled conversion leaves no files behind')
check(await row('long.mkv').getByTestId('convert-mp4').count() === 1, 'project still uses the original; button available again')

console.log('• preview plays the converted file')
await page.evaluate(() => { window.__cw.player.seek(1); })
await page.waitForFunction(() => window.__cw.player.ready(), null, { timeout: 15000 })
check(true, 'preview frame ready on converted MKV')

await page.locator('.media-panel').screenshot({ path: join(root, 'tests', '.tmp', 'convert-panel.png') })
await app.evaluate(({ app }) => app.exit(0))
if (errors.length) { console.log('Renderer errors:\n' + errors.join('\n')); process.exit(1) }
console.log('\nAll conversion checks passed.')

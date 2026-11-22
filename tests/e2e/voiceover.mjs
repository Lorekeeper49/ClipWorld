// Voiceover UI test, with Chromium's fake microphone (a beep every second): Record plays the timeline from
// the playhead, Stop (and Space) adds the take as a new audio clip lined up with the playhead, the file is
// written next to the project, and "Hear the timeline" off silences the preview while recording.
// Run with: npm run build && node tests/e2e/voiceover.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-voiceover-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const source = join(dir, 'video.mp4')
{
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [] }))
const userData = join(tmpdir(), 'clipworld-voiceover-userdata')
rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({
  args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  env: { ...process.env, CW_E2E_DIALOGS: dialogs }
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.menubar')
const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const toggle = (testId) => page.locator('label.toggle', { has: page.getByTestId(testId) }).click()
const state = () => page.evaluate(() => {
  const s = window.__cw.get()
  return {
    phase: s.voiceover?.phase ?? null,
    playing: window.__cw.player.playing,
    time: window.__cw.player.time,
    muted: window.__cw.player.monitorMuted,
    clips: s.project.clips.map((c) => ({ id: c.id, type: c.type, name: c.name, start: c.start, duration: c.duration, srcIn: c.srcIn, trackId: c.trackId, mediaId: c.mediaId })),
    media: s.project.media.map((m) => ({ id: m.id, path: m.path, duration: m.duration })),
    selection: s.selection
  }
})
const volume = (file) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  return Number(/max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr.toString())?.[1] ?? -99)
}

step('a video on the timeline; the project lives in the test folder')
await page.evaluate(async ({ f, project }) => {
  const { actions, edit, set } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 30 } })
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  set({ projectPath: project, selection: [] })
}, { f: source, project: join(dir, 'test.vcws') })
await page.waitForFunction(() => window.__cw.get().project.media.every((m) => window.__cw.get().mediaCache[m.id]?.audioUrls?.[0]), null, { timeout: 30000 })
check(await page.getByTestId('voiceover-record').isVisible(), 'the Tools window has a Voiceover section')

step('record two seconds from 1.5 s')
await page.evaluate(() => window.__cw.player.seek(1.5))
await page.getByTestId('voiceover-record').click()
await page.waitForFunction(() => window.__cw.get().voiceover?.phase === 'recording', null, { timeout: 10000 })
let s = await state()
check(s.playing, 'the timeline plays while recording')
check(await page.getByTestId('voiceover-time').isVisible(), 'the elapsed time shows')
const level = await page.evaluate(async () => {
  let most = 0
  const start = performance.now()
  while (performance.now() - start < 2000) {
    most = Math.max(most, window.__cw.get().voiceover?.level ?? 0)
    await new Promise((r) => setTimeout(r, 50))
  }
  return most
})
check(level > 0.01, `the level meter moves (${level.toFixed(3)})`)
await page.getByTestId('voiceover-record').click()
await page.waitForFunction(() => !window.__cw.get().voiceover, null, { timeout: 15000 })
s = await state()
check(!s.playing, 'stopping also stops the timeline')
const take = s.clips.find((c) => c.name === 'Voiceover')
check(!!take && take.type === 'audio', 'a new audio clip called Voiceover')
check(Math.abs(take.start - 1.5) < 1e-6, `it starts where the playhead was (${take.start})`)
check(take.srcIn >= 0 && take.srcIn < 0.6, `the lead-in before playback is skipped (${take.srcIn.toFixed(3)} s)`)
check(take.duration > 1.6 && take.duration < 2.8, `about two seconds long (${take.duration.toFixed(2)} s)`)
check(s.selection.includes(take.id), 'the new clip is selected')
const media = s.media.find((m) => m.id === take.mediaId)
check(media.path.startsWith(join(dir, 'Voiceovers')) && existsSync(media.path), `saved next to the project (${media.path})`)
check(volume(media.path) > -40, 'the file has the microphone in it')
const videoAudio = s.clips.find((c) => c.type === 'audio' && c.name !== 'Voiceover')
check(take.trackId !== videoAudio.trackId, 'it went on its own audio track')

step('undo takes the clip away in one step')
await page.evaluate(() => window.__cw.actions.undo())
s = await state()
check(!s.clips.some((c) => c.name === 'Voiceover') && !s.media.some((m) => m.id === take.mediaId), 'clip and media are gone')
await page.evaluate(() => window.__cw.actions.redo())

step('Space stops a take too; with "Hear the timeline" off the preview is silent meanwhile')
await toggle('voiceover-monitor')
check(await page.evaluate(() => window.__cw.get().settings.voiceoverMonitor === false), 'the setting is off')
await page.evaluate(() => window.__cw.player.seek(4))
await page.getByTestId('voiceover-record').click()
await page.waitForFunction(() => window.__cw.get().voiceover?.phase === 'recording', null, { timeout: 10000 })
check((await state()).muted, 'the preview is muted while recording')
await page.waitForTimeout(1200)
await page.locator('body').click({ position: { x: 2, y: 2 } })
await page.keyboard.press('Space')
await page.waitForFunction(() => !window.__cw.get().voiceover, null, { timeout: 15000 })
s = await state()
check(!s.muted && !s.playing, 'sound comes back and the timeline stops')
const takes = s.clips.filter((c) => c.name === 'Voiceover')
check(takes.length === 2 && Math.abs(takes[1].start - 4) < 1e-6, 'a second take at 4 s')
check(readdirSync(join(dir, 'Voiceovers')).filter((f) => f.endsWith('.wav')).length === 2, 'two files in the Voiceovers folder')

step('the Settings window has the voiceover preferences')
await page.evaluate(() => window.__cw.set({ modal: 'settings' }))
check(await page.getByTestId('settings-voiceover-mic').isVisible(), 'microphone picker')
check(!(await page.getByTestId('settings-voiceover-monitor').isChecked()), '"Hear the timeline" shows off')
await page.getByTestId('settings-done').click()

check(errors.length === 0, `no errors in the page${errors.length ? ': ' + errors.join(' | ') : ''}`)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
console.log('\nvoiceover test passed')

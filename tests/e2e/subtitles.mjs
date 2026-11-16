// Subtitle editor UI test: creates and edits subtitles in the Subtitles window, checks the preview,
// puts them on the timeline with an effect, exports subtitle files and the video, imports an SRT, and
// saves/reopens. Run with: npm run build && node tests/e2e/subtitles.mjs
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..')
const ffmpeg = join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe')
const dir = join(tmpdir(), 'clipworld-subtitle-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const src = join(dir, 'talk.mp4')
spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])
const importSrt = join(dir, 'spanish.es.srt')
writeFileSync(importSrt, '1\n00:00:00,500 --> 00:00:02,000\nHola\n\n2\n00:00:02,500 --> 00:00:04,000\n¿Qué tal?\n')

const vttPath = join(dir, 'out.vtt')
const srtPath = join(dir, 'out.srt')
const videoPath = join(dir, 'out.mp4')
const projectPath = join(dir, 'subs.vcws')
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [vttPath, srtPath, videoPath, projectPath] }))

const userData = join(tmpdir(), 'clipworld-subtitle-userdata')
rmSync(userData, { recursive: true, force: true })
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env: { ...process.env, CW_E2E_DIALOGS: dialogs } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.menubar')
const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const state = () => page.evaluate(() => {
  const s = window.__cw.get()
  return { subtitles: s.project.subtitles, clips: s.project.clips.map((c) => ({ id: c.id, type: c.type, start: c.start, duration: c.duration, effects: c.effects.map((e) => e.type) })) }
})
const shot = (n) => page.screenshot({ path: join(root, 'tests', '.tmp', `subs-${n}.png`) })

/** Average brightness of the lower-centre band of the preview canvas (where bottom subtitles sit). */
const previewBand = () => page.evaluate(async () => {
  const { player } = window.__cw
  for (let i = 0; i < 200 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
  await new Promise((r) => requestAnimationFrame(r))
  const url = player.snapshot()
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = 96
  c.height = 54
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, 96, 54)
  return { url, data: Array.from(ctx.getImageData(0, 0, 96, 54).data) }
})
const band = (data) => {
  // Rows 44..50 of 54, columns 24..72 of 96: the bottom-centre area.
  let sum = 0
  let n = 0
  for (let y = 44; y < 51; y++) for (let x = 24; x < 72; x++) { const i = (y * 96 + x) * 4; sum += data[i] + data[i + 1] + data[i + 2]; n += 3 }
  return sum / n
}
/** How many pixels of the bottom-centre area clearly differ between two frames. */
const changed = (a, b) => {
  let count = 0
  for (let y = 40; y < 52; y++) for (let x = 16; x < 80; x++) {
    const i = (y * 96 + x) * 4
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) count++
  }
  return count
}

step('setup')
await page.evaluate(async (p) => {
  const [m] = await window.__cw.actions.importPaths([p])
  window.__cw.actions.addToTimeline(m.id, 0)
}, src)
await page.locator('.dv-tab', { hasText: 'Subtitles' }).click()
await page.getByTestId('subtitle-create').click()
check((await state()).subtitles.length === 1, 'new subtitle track created')
await shot('01-empty-track')

step('add and type subtitles with the keyboard')
await page.evaluate(() => window.__cw.player.seek(1))
await page.locator('body').click({ position: { x: 700, y: 300 } }).catch(() => {})
await page.evaluate(() => { window.__cw.player.pause(); window.__cw.player.seek(1); document.activeElement?.blur() })
await page.keyboard.press('Shift+T')
await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'cue-text')
await page.keyboard.type('Hello world, this is a subtitle')
await page.keyboard.press('Enter')
await page.evaluate(() => { window.__cw.player.seek(3); document.activeElement?.blur() })
await page.keyboard.press('Shift+T')
await page.waitForFunction(() => document.activeElement?.dataset?.testid === 'cue-text')
await page.keyboard.type('Second subtitle')
await page.keyboard.press('Enter')
let cues = (await state()).subtitles[0].cues
check(cues.length === 2 && cues[0].text === 'Hello world, this is a subtitle' && cues[1].text === 'Second subtitle', 'two subtitles typed')
check(cues[0].start === 1 && cues[0].end === 3 && cues[1].start === 3 && cues[1].end === 5, 'first one ends where the second starts; default length 2 s')

step('edit a time in the list')
const end2 = page.getByTestId('cue-end').nth(1)
await end2.fill('00:00:04.500')
await end2.press('Enter')
cues = (await state()).subtitles[0].cues
check(cues[1].end === 4.5, 'end time edited to 4.5 s')

step('set end to playhead with ]')
await page.getByTestId('cue-row').first().click({ position: { x: 10, y: 30 } })
await page.evaluate(() => { window.__cw.player.seek(2.5); document.activeElement?.blur() })
await page.keyboard.press(']')
check((await state()).subtitles[0].cues[0].end === 2.5, 'selected subtitle now ends at the playhead (2.5 s)')

step('preview guide (not yet on the timeline)')
await page.evaluate(() => window.__cw.player.seek(1.5))
const withGuide = (await previewBand()).data
await page.evaluate(() => window.__cw.set({ subtitleGuide: false }))
const noGuide = (await previewBand()).data
await page.evaluate(() => window.__cw.set({ subtitleGuide: true }))
check(changed(withGuide, noGuide) > 40, `guide drawn in the preview (${changed(withGuide, noGuide)} pixels changed)`)
await shot('02-guide')

step('add to timeline, then an effect on the subtitle clip')
await page.getByTestId('subtitle-to-timeline').click()
let st = await state()
const sc = st.clips.find((c) => c.type === 'subtitles')
check(sc && sc.start === 1 && Math.abs(sc.duration - 3.5) < 1e-9, 'subtitle clip on the timeline spanning 1 s → 4.5 s')
check(await page.locator('[data-clip-type=subtitles]').count() === 1, 'clip drawn on the timeline')
await page.locator('.dv-tab', { hasText: 'Tools' }).click()
await page.getByTestId('add-effect').selectOption('dropShadow')
st = await state()
check(st.clips.find((c) => c.type === 'subtitles').effects.includes('dropShadow'), 'drop shadow added to the subtitle clip')
await page.locator('.dv-tab', { hasText: 'Subtitles' }).click()
await page.evaluate(() => window.__cw.player.seek(1.5))
const preview = await previewBand()
await page.evaluate(() => window.__cw.player.seek(0.5))
const previewNone = await previewBand()
check(changed(preview.data, previewNone.data) > 40, `preview shows the subtitle clip (${changed(preview.data, previewNone.data)} pixels changed)`)
await shot('03-on-timeline')

step('export subtitle files')
await page.getByTestId('subtitle-export').click()
await page.getByTestId('subtitle-format').selectOption('vtt')
await page.getByTestId('subtitle-export-save').click()
await page.waitForFunction(() => document.querySelector('[data-testid=subtitle-export-box]') === null)
await page.getByTestId('subtitle-export').click()
await page.getByTestId('subtitle-format').selectOption('srt')
await page.getByTestId('subtitle-export-save').click()
await page.waitForFunction(() => document.querySelector('[data-testid=subtitle-export-box]') === null)
for (let i = 0; i < 50 && !(existsSync(vttPath) && existsSync(srtPath)); i++) await new Promise((r) => setTimeout(r, 100))
const vtt = readFileSync(vttPath, 'utf8')
const srt = readFileSync(srtPath, 'utf8')
check(vtt.startsWith('WEBVTT') && vtt.includes('00:00:01.000 --> 00:00:02.500\nHello world, this is a subtitle'), 'VTT written with the edited times')
check(srt.includes('2\n00:00:03,000 --> 00:00:04,500\nSecond subtitle'), 'SRT written')

step('export the video and compare with the preview')
await page.keyboard.press('Control+Shift+E')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'video exported')
await page.getByTestId('export-close').click()
const frameBand = (t) => {
  const raw = spawnSync(ffmpeg, ['-loglevel', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=96:54:flags=area,format=rgba', '-f', 'rawvideo', '-'])
  return Array.from(raw.stdout)
}
const exported = frameBand(1.5)
writeFileSync(join(root, 'tests', '.tmp', 'subs-preview-1.5.png'), Buffer.from(preview.url.split(',')[1], 'base64'))
spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-ss', '1.5', '-i', videoPath, '-frames:v', '1', join(root, 'tests', '.tmp', 'subs-export-1.5.png')])
const exportedNone = frameBand(0.5)
check(changed(exported, exportedNone) > 40, `subtitle burned into the exported video (${changed(exported, exportedNone)} pixels changed)`)
// Video encoding shifts saturated colours (most on thin coloured lines), so the subtitle rows are judged
// against the preview/export difference in the same rows on a frame without a subtitle. Sharp white
// text edges on coloured bars lose a little more to the encoder's halved colour resolution (checked by
// eye on enlarged crops: font, size, position, outline and shadow are identical), hence the margin.
const meanDiff = (a, b, y0, y1) => {
  let diff = 0
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = 0; x < 96; x++) for (let c = 0; c < 3; c++) { const i = (y * 96 + x) * 4 + c; diff += Math.abs(a[i] - b[i]); n++ }
  return diff / n
}
const withSub = meanDiff(exported, preview.data, 40, 54)
const baseline = meanDiff(exportedNone, previewNone.data, 40, 54)
check(baseline < 20 && withSub - baseline < 8,
  `exported subtitle matches the preview (difference ${withSub.toFixed(1)} with the subtitle vs ${baseline.toFixed(1)} without)`)

step('import an SRT as a second track')
await page.evaluate((p) => window.__cw.actions.importSubtitleFilesAction([p]), importSrt)
st = await state()
check(st.subtitles.length === 2 && st.subtitles[1].name === 'spanish' && st.subtitles[1].language === 'spa' && st.subtitles[1].cues.length === 2,
  'spanish.es.srt imported as “spanish” (Spanish) with 2 subtitles')
check(await page.getByTestId('cue-row').count() === 2 && (await page.getByTestId('cue-text').first().inputValue()) === 'Hola', 'new track shown in the window')
await shot('04-imported')

step('undo, save and reopen')
await page.keyboard.press('Control+Z')
check((await state()).subtitles.length === 1, 'undo removes the imported track')
await page.keyboard.press('Control+Y')
await page.evaluate(() => document.activeElement?.blur())
await page.keyboard.press('Control+S')
await page.waitForFunction(() => !window.__cw.get().dirty, null, { timeout: 10000 })
await page.evaluate((p) => window.__cw.actions.openProjectAction(p), projectPath)
await page.waitForFunction(() => window.__cw.get().project.subtitles.length === 2, null, { timeout: 10000 })
st = await state()
check(st.clips.some((c) => c.type === 'subtitles') && st.subtitles[0].cues[0].text === 'Hello world, this is a subtitle', 'reopened with both tracks and the subtitle clip')

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll subtitle UI checks passed.')

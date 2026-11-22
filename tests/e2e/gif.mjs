// Transparent GIF UI test: in the Export window choose GIF, turn on the transparent background and a
// see-through color, check the preview, pick the color by clicking it, export, and check the file.
// Run with: npm run build && node tests/e2e/gif.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-gif-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
// A red square sliding across a green screen.
const source = join(dir, 'greenscreen.mp4')
{
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=red:s=60x60:r=25:d=2',
    '-filter_complex', "[0][1]overlay=x='t*120':y=60", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '4', '-pix_fmt', 'yuv444p', source])
  if (r.status !== 0) throw new Error(r.stderr.toString())
}
const gifPath = join(dir, 'out.gif')
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [gifPath] }))
const userData = join(tmpdir(), 'clipworld-gif-userdata')
rmSync(userData, { recursive: true, force: true })

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env: { ...process.env, CW_E2E_DIALOGS: dialogs } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.menubar')
const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }
const toggle = (testId) => page.locator('label.toggle', { has: page.getByTestId(testId) }).click()
/** RGBA of the preview canvas at a point given as fractions of its size. */
const previewPixel = (fx, fy) => page.evaluate(([fx, fy]) => {
  const c = document.querySelector('[data-testid=gif-preview]')
  const d = c.getContext('2d').getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data
  return [...d]
}, [fx, fy])
const waitPreview = () => page.waitForTimeout(400)
const gifPixel = (n, x, y) => {
  const raw = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', gifPath, '-vf', `select='eq(n\\,${n})',crop=1:1:${x}:${y},format=rgba`, '-frames:v', '1', '-f', 'rawvideo', '-']).stdout
  return [...raw]
}

step('the green-screen clip, at half size in the middle of the frame')
await page.evaluate(async (f) => {
  const { actions, edit, get, set, player } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 25 } })
  const [m] = await actions.importPaths([f])
  actions.addToTimeline(m.id, 0)
  edit((p) => { for (const c of p.clips) { c.transform.start.scale = 0.5; c.transform.end.scale = 0.5 } })
  set({ selection: [] })
  player.seek(0)
}, source)
await page.waitForFunction(() => window.__cw.player.ready(), null, { timeout: 20000 })

step('Export ▸ GIF shows the transparency options')
await page.evaluate(() => window.__cw.set({ modal: 'export' }))
await page.getByTestId('export-container').selectOption('gif')
check(await page.getByTestId('gif-transparent').count() === 1, 'a "Transparent background" switch')
check(await page.getByTestId('gif-preview').count() === 0, 'no preview while it is off')
await toggle('gif-transparent')
await waitPreview()
check((await previewPixel(0.05, 0.05))[3] === 0, 'the preview shows the empty corner see-through')
check((await previewPixel(0.7, 0.5))[1] > 200 && (await previewPixel(0.7, 0.5))[3] === 255, 'and the green screen still there')

step('make a color see-through, picking it by clicking the preview')
await toggle('gif-key')
// Start from a color nothing has, then click the green screen to pick it.
await page.locator('.gif-transparency .color input[type=text]').fill('#0000ff')
await page.locator('.gif-transparency .color input[type=text]').press('Enter')
await waitPreview()
check((await previewPixel(0.7, 0.5))[3] === 255, 'blue hides nothing')
const box = await page.getByTestId('gif-preview').boundingBox()
await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5)
await waitPreview()
const picked = await page.locator('.gif-transparency .color input[type=text]').inputValue()
check(/^#0[0-9a-f]f[0-9a-f]0[0-9a-f]$/i.test(picked), `clicking the green picked it (${picked})`)
check((await previewPixel(0.7, 0.5))[3] === 0, 'the green screen is see-through in the preview')
const red = await previewPixel(0.25 + 0.5 * (30 / 320), 0.25 + 0.5 * (90 / 180))
check(red[0] > 200 && red[3] === 255, `the red square stays (${red})`)

step('export')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'exported')
check(gifPixel(0, 5, 5)[3] === 0, 'the empty corner is see-through')
check(gifPixel(0, 220, 90)[3] === 0, 'the green screen is see-through')
const sq = gifPixel(0, 95, 90)
check(sq[0] > 200 && sq[3] === 255, `the red square is solid (${sq})`)
check(gifPixel(40, 95, 90)[3] === 0, 'where the square was is see-through again later (no trail)')
await page.getByTestId('export-close').click()

step('the settings are remembered')
await page.evaluate(() => window.__cw.set({ modal: 'export' }))
check(await page.getByTestId('gif-transparent').isChecked() && await page.getByTestId('gif-key').isChecked(), 'both switches still on')
check(await page.locator('.gif-transparency .color input[type=text]').inputValue() === picked, 'and the picked color')

check(errors.length === 0, `no errors in the page${errors.length ? ': ' + errors.join(' | ') : ''}`)
await page.evaluate(() => window.__cw.set({ dirty: false }))
await app.evaluate(({ app }) => app.exit(0))
console.log('\ngif test passed')

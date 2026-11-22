// Mask UI test: adds color, image and difference (clone) masks from the Tools window and checks the
// preview and the exported video agree. Run with: npm run build && node tests/e2e/masks.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-mask-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const gen = (name, args) => {
  const out = join(dir, name)
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', ...args, out])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}
const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-g', '15']
const files = {
  split: gen('split.mp4', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x180:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=160x180:r=30:d=3', '-filter_complex', 'hstack', ...h264]),
  blue: gen('blue.png', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180', '-frames:v', '1']),
  lr: gen('halves.png', ['-f', 'lavfi', '-i', 'color=c=white:s=160x180', '-f', 'lavfi', '-i', 'color=c=black:s=160x180', '-filter_complex', 'hstack', '-frames:v', '1']),
  clone: gen('takes.mp4', ['-f', 'lavfi', '-i', 'color=c=0x405060:s=320x180:r=30:d=8', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=30:d=8',
    '-filter_complex', "[0][1]overlay=x='10+40*t':y=70", ...h264]),
  plate: gen('empty_room.png', ['-f', 'lavfi', '-i', 'color=c=0x405060:s=320x180', '-frames:v', '1'])
}
const videoPath = join(dir, 'out.mp4')
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [videoPath] }))

const userData = join(tmpdir(), 'clipworld-mask-userdata')
rmSync(userData, { recursive: true, force: true })
const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`], env: { ...process.env, CW_E2E_DIALOGS: dialogs } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.menubar')
const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }

/** Average color of a region (x, y, w, h in 320x180 frame pixels) of the preview at time t. */
const previewAt = (t, [x, y, w, h]) => page.evaluate(async ({ t, x, y, w, h }) => {
  const { player } = window.__cw
  player.pause()
  player.seek(t)
  for (let i = 0; i < 300 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
  // Clean backgrounds and mask images load asynchronously: give them a few frames.
  for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r))
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
const LEFT = [30, 40, 100, 100]
const RIGHT = [190, 40, 100, 100]
const FIRST = [55, 75, 30, 30]
const SECOND = [175, 75, 30, 30]
const white = (c) => c.every((v) => v > 200)

step('setup: a 320x180 project with clips for each test')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  edit((p) => { p.settings = { width: 320, height: 180, fps: 30 } })
  const items = await actions.importPaths([f.blue, f.split, f.lr, f.clone, f.plate])
  const by = Object.fromEntries(items.map((m) => [m.name, m]))
  // 0-3 s: the green/red video over a blue image. 10-13 s: two takes, the second 3 s later, on top.
  actions.addToTimeline(by['blue.png'].id, 0)
  edit((p) => { p.clips[0].duration = 3 })
  actions.addToTimeline(by['split.mp4'].id, 0)
  actions.addToTimeline(by['takes.mp4'].id, 10, get().project.clips[0].trackId)
  actions.addToTimeline(by['takes.mp4'].id, 10)
  edit((p) => {
    const takes = p.clips.filter((c) => c.mediaId === by['takes.mp4'].id)
    for (const c of takes) c.duration = 3
    const top = takes.find((c) => c.trackId !== p.clips[0].trackId)
    top.srcIn = 3
  })
  set({ selection: [get().project.clips.find((c) => c.mediaId === by['split.mp4'].id).id] })
}, files)
await page.locator('.dv-tab', { hasText: 'Tools' }).click()
check(await page.getByTestId('add-color-mask').count() === 1, 'Mask section shown for the selected video')

step('color mask')
await page.getByTestId('add-color-mask').click()
const cLeft = await previewAt(1, LEFT)
const cRight = await previewAt(1, RIGHT)
check(near(cLeft, [0, 0, 255]) && near(cRight, [255, 0, 0]), `green hidden, red kept in the preview (${cLeft} | ${cRight})`)
await page.screenshot({ path: join(root, 'tests', '.tmp', 'masks-color.png') })

step('image mask instead')
await page.locator('[data-testid=effect][data-effect-type=colorMask] button[title=Remove]').click()
await page.getByTestId('add-image-mask').click()
await page.getByTestId('param-image').selectOption({ label: 'halves.png' })
const iLeft = await previewAt(1, LEFT)
const iRight = await previewAt(1, RIGHT)
check(near(iLeft, [0, 255, 0]) && near(iRight, [0, 0, 255]), `white half shows the clip, black half hides it (${iLeft} | ${iRight})`)

step('difference mask: clone with a clean background')
await page.evaluate(() => {
  const s = window.__cw.get()
  const takes = s.project.clips.filter((c) => s.project.media.find((m) => m.id === c.mediaId)?.name === 'takes.mp4')
  window.__cw.set({ selection: [takes.find((c) => c.srcIn === 3).id] })
})
const before = [await previewAt(11, FIRST), await previewAt(11, SECOND)]
check(!white(before[0]) && white(before[1]), 'without a mask the top take hides the first one')
await page.getByTestId('add-difference-mask').click()
await page.locator('[data-testid=effect][data-effect-type=differenceMask] select').first().selectOption('plate')
await page.getByTestId('param-plate').selectOption({ label: 'empty_room.png' })
const after = [await previewAt(11, FIRST), await previewAt(11, SECOND)]
check(white(after[0]) && white(after[1]), `both takes show in the preview (${after[0]} | ${after[1]})`)
await page.screenshot({ path: join(root, 'tests', '.tmp', 'masks-clone.png') })

step('export matches the preview')
await page.keyboard.press('Control+Shift+E')
await page.getByTestId('export-start').click()
await page.waitForSelector('[data-testid=export-result]', { timeout: 120000 })
check(await page.getByTestId('export-result').getAttribute('data-ok') === 'true', 'video exported')
await page.getByTestId('export-close').click()
const eLeft = exportAt(1, LEFT)
const eRight = exportAt(1, RIGHT)
check(near(eLeft, iLeft) && near(eRight, iRight), `image mask: export ${eLeft} | ${eRight} vs preview ${iLeft} | ${iRight}`)
const eFirst = exportAt(11, FIRST)
const eSecond = exportAt(11, SECOND)
check(white(eFirst) && white(eSecond), `clone: both takes in the export (${eFirst} | ${eSecond})`)
check(near(exportAt(11, [260, 20, 40, 40]), [0x40, 0x50, 0x60]), 'background unchanged around them')

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll mask UI checks passed.')

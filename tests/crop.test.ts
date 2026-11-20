// Crop and custom easing curves in real exports: cropped edges show what's underneath, a crop animates
// with the transform's easing, and a custom curve moves a clip where the curve says.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import { evalCurve, fixCurve } from '../src/shared/easing'
import type { Caps } from '../src/shared/filtergraph'
import { defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { type EaseCurve, type MediaItem, type Project, newProject } from '../src/shared/model'
import { addTrack, placeMedia } from '../src/shared/timeline-ops'
import { TMP, frameColor, setupFfmpeg } from './helpers'

let caps: Caps
const m: Record<string, MediaItem> = {}

beforeAll(async () => {
  setupFfmpeg()
  caps = await usableCapabilities()
  const make = async (name: string, args: string[]) => {
    const file = join(TMP, name)
    if (!existsSync(file)) await ffmpeg(['-loglevel', 'error', '-y', ...args, file])
    return file
  }
  m.red = await probeMedia(await make('crop_red.mkv', ['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=3', '-c:v', 'ffv1', '-pix_fmt', 'bgr0']))
  m.blue = await probeMedia(await make('crop_blue.png', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180', '-frames:v', '1']))
  m.dot = await probeMedia(await make('crop_dot.png', ['-f', 'lavfi', '-i', 'color=c=white:s=32x32', '-frames:v', '1']))
})

/** A red video over a blue picture; returns the red clip. */
function redOverBlue(): { p: Project; red: ReturnType<typeof clipOf> } {
  const p = newProject()
  p.settings = { width: 320, height: 180, fps: 30 }
  p.media.push(m.red, m.blue, m.dot)
  placeMedia(p, m.blue, 0)
  p.clips[0].duration = 3
  const t = addTrack(p, 'video')
  const [id] = placeMedia(p, m.red, 0, t.id)
  return { p, red: clipOf(p, id) }
}
const clipOf = (p: Project, id: string) => p.clips.find((c) => c.id === id)!

let seq = 0
async function exportTo(p: Project): Promise<string> {
  const out = join(TMP, `crop_${++seq}.mkv`)
  const settings = normalizeExportSettings({ ...defaultExportSettings(), container: 'mkv', videoCodec: 'h264', quality: 100 }, caps.encoders)
  await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `cropjob_${seq}`), caps })
  return out
}
const isBlue = (c: number[]) => c[2] > 180 && c[0] < 60
const isRed = (c: number[]) => c[0] > 180 && c[2] < 60

describe('crop in the export', () => {
  it('hides the cropped edges so what is underneath shows', async () => {
    const { p, red } = redOverBlue()
    Object.assign(red.transform.start, { cropLeft: 0.25, cropBottom: 0.5 })
    const out = await exportTo(p)
    expect(isBlue(await frameColor(out, 1, '60:60:10:10')), 'left quarter').toBe(true)
    expect(isRed(await frameColor(out, 1, '60:60:120:10')), 'top middle').toBe(true)
    expect(isBlue(await frameColor(out, 1, '60:60:200:110')), 'bottom half').toBe(true)
  })

  it('animates with the transform', async () => {
    const { p, red } = redOverBlue()
    red.transform.animate = true
    red.transform.ease = 'linear'
    red.transform.end.cropRight = 0.6
    const out = await exportTo(p)
    // Half way (1.5 s) 30% of the right side is gone: x 240..320 blue, 140..200 still red.
    expect(isBlue(await frameColor(out, 1.5, '40:40:260:70'))).toBe(true)
    expect(isRed(await frameColor(out, 1.5, '40:40:150:70'))).toBe(true)
    expect(isRed(await frameColor(out, 0.05, '40:40:260:70')), 'not cropped at the start').toBe(true)
  })
})

describe('custom easing in the export', () => {
  it('moves a clip where the curve says', async () => {
    const p = newProject()
    p.settings = { width: 320, height: 180, fps: 30 }
    p.media.push(m.dot)
    const [id] = placeMedia(p, m.dot, 0)
    const dot = clipOf(p, id)
    dot.duration = 2
    // A curve that overshoots to 1.3 at the middle, then settles.
    const curve: EaseCurve = { points: fixCurve([
      { x: 0, y: 0, in: [0, 0], out: [0.15, 0.6] },
      { x: 0.5, y: 1.3, in: [-0.1, 0], out: [0.1, 0] },
      { x: 1, y: 1, in: [-0.15, 0], out: [0, 0] }
    ]) }
    dot.transform = { ...dot.transform, animate: true, ease: curve, start: { ...dot.transform.start, x: -0.4, scale: 0.1 }, end: { ...dot.transform.end, x: 0, scale: 0.1 } }
    const out = await exportTo(p)
    // At 1 s (curve 1.3): x = -0.4 + 0.4*1.3 = +0.12 of the width → centre at 160 + 38.4 ≈ 198.
    const v = evalCurve(curve, 0.5)
    const cx = 160 + 320 * (-0.4 + 0.4 * v)
    const at = await frameColor(out, 1, `8:8:${Math.round(cx - 4)}:86`)
    expect(at.every((c) => c > 200), `the dot is at x≈${cx.toFixed(0)} (${at})`).toBe(true)
  })
})

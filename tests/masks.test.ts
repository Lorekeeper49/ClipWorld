// Mask effects in the export: colour, image and difference (clone) masks, with real ffmpeg.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import { makeEffect } from '../src/shared/effects'
import type { Caps } from '../src/shared/filtergraph'
import { defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { type EffectInstance, type MediaItem, type Project, newProject } from '../src/shared/model'
import { addTrack, placeMedia } from '../src/shared/timeline-ops'
import { TMP, frameColor, setupFfmpeg } from './helpers'

let caps: Caps
const m: Record<string, MediaItem> = {}
const q = ['-loglevel', 'error', '-y']

async function make(name: string, args: string[]): Promise<string> {
  const file = join(TMP, name)
  if (!existsSync(file)) await ffmpeg([...q, ...args, file])
  return file
}

beforeAll(async () => {
  setupFfmpeg()
  caps = await usableCapabilities()
  // Lossless RGB sources so colours arrive exactly.
  const ffv1 = ['-c:v', 'ffv1', '-pix_fmt', 'bgr0']
  const files = {
    split: await make('mask_split.mkv', ['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x180:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=160x180:r=30:d=3',
      '-filter_complex', 'hstack', ...ffv1]),
    blue: await make('mask_blue.png', ['-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180', '-frames:v', '1']),
    lr: await make('mask_lr.png', ['-f', 'lavfi', '-i', 'color=c=white:s=160x180', '-f', 'lavfi', '-i', 'color=c=black:s=160x180', '-filter_complex', 'hstack', '-frames:v', '1']),
    gray: await make('mask_gray.png', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=320x180', '-frames:v', '1']),
    alpha: await make('mask_alpha.png', ['-f', 'lavfi', '-i', 'color=c=red:s=160x180,format=rgba', '-f', 'lavfi', '-i', 'color=c=red@0:s=160x180,format=rgba',
      '-filter_complex', 'hstack,format=rgba', '-frames:v', '1']),
    // A static background with a white box sliding right at 40 px/s: two moments of it share the background.
    clone: await make('mask_clone.mkv', ['-f', 'lavfi', '-i', 'color=c=0x405060:s=320x180:r=30:d=8', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=30:d=8',
      '-filter_complex', "[0][1]overlay=x='10+40*t':y=70", ...ffv1]),
    // The same background with nobody in it.
    plate: await make('mask_plate.png', ['-f', 'lavfi', '-i', 'color=c=0x405060:s=320x180', '-frames:v', '1'])
  }
  for (const [k, f] of Object.entries(files)) m[k] = await probeMedia(f)
})

function project(): Project {
  const p = newProject()
  p.settings = { width: 320, height: 180, fps: 30 }
  p.media.push(...Object.values(m))
  return p
}

/** Puts `top` above a full-frame blue image, with the given effects on `top`. */
function overBlue(top: MediaItem, effects: EffectInstance[]): Project {
  const p = project()
  placeMedia(p, m.blue, 0)
  p.clips[0].duration = 3
  const t = addTrack(p, 'video')
  const [id] = placeMedia(p, top, 0, t.id)
  p.clips.find((c) => c.id === id)!.effects = effects
  return p
}

const fx = (type: string, params: Record<string, number | string | boolean> = {}): EffectInstance => {
  const e = makeEffect(type)
  Object.assign(e.params, params)
  return e
}

let seq = 0
async function exportTo(p: Project): Promise<string> {
  const out = join(TMP, `masks_${++seq}.mkv`)
  // Lossless output so measured colours are not disturbed by the encoder.
  const settings = normalizeExportSettings({ ...defaultExportSettings(), container: 'mkv', videoCodec: 'h264', quality: 100 }, caps.encoders)
  await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `masksjob_${seq}`), caps })
  return out
}
const LEFT = '100:100:30:40'
const RIGHT = '100:100:190:40'
const near = (got: number[], want: number[], tol = 14) => got.every((v, i) => Math.abs(v - want[i]) <= tol)

describe('colour mask', () => {
  it('makes the chosen colour transparent', async () => {
    const out = await exportTo(overBlue(m.split, [fx('colorMask', { color: '#00ff00' })]))
    expect(near(await frameColor(out, 1, LEFT), [0, 0, 255])).toBe(true) // green gone: blue shows
    expect(near(await frameColor(out, 1, RIGHT), [255, 0, 0])).toBe(true) // red kept
  })
  it('inverted, keeps only that colour', async () => {
    const out = await exportTo(overBlue(m.split, [fx('colorMask', { color: '#00ff00', invert: true })]))
    expect(near(await frameColor(out, 1, LEFT), [0, 255, 0])).toBe(true)
    expect(near(await frameColor(out, 1, RIGHT), [0, 0, 255])).toBe(true)
  })
  it('works for black, which chroma keying cannot separate from grey', async () => {
    const out = await exportTo(overBlue(m.split, [fx('colorMask', { color: '#ff0000', tolerance: 0.1 })]))
    expect(near(await frameColor(out, 1, RIGHT), [0, 0, 255])).toBe(true)
    expect(near(await frameColor(out, 1, LEFT), [0, 255, 0])).toBe(true)
  })
})

describe('image mask', () => {
  it('white shows the clip and black hides it', async () => {
    const out = await exportTo(overBlue(m.split, [fx('imageMask', { image: m.lr.id })]))
    expect(near(await frameColor(out, 1, LEFT), [0, 255, 0])).toBe(true)
    expect(near(await frameColor(out, 1, RIGHT), [0, 0, 255])).toBe(true)
  })
  it('mid-grey shows the clip at half strength', async () => {
    const out = await exportTo(overBlue(m.split, [fx('imageMask', { image: m.gray.id })]))
    expect(near(await frameColor(out, 1, RIGHT), [128, 0, 127], 8)).toBe(true)
  })
  it('can use the image transparency, and invert', async () => {
    const out = await exportTo(overBlue(m.split, [fx('imageMask', { image: m.alpha.id, mode: 'alpha', invert: true })]))
    expect(near(await frameColor(out, 1, LEFT), [0, 0, 255])).toBe(true)
    expect(near(await frameColor(out, 1, RIGHT), [255, 0, 0])).toBe(true)
  })
  it('a missing image leaves the clip unmasked', async () => {
    const out = await exportTo(overBlue(m.split, [fx('imageMask', { image: 'gone' })]))
    expect(near(await frameColor(out, 1, LEFT), [0, 255, 0])).toBe(true)
  })
})

describe('difference mask (clone)', () => {
  /**
   * The same recording twice: the top copy is 3 s later, so its box is 120 px further right.
   * `mask` is the difference mask's parameters, or null for no mask.
   */
  function cloneProject(start: number, mask: Record<string, number | string | boolean> | null): Project {
    const p = project()
    if (start > 0) {
      placeMedia(p, m.blue, 0)
      p.clips[0].duration = start
    }
    placeMedia(p, m.clone, start, p.tracks[0].id)
    const base = p.clips[p.clips.length - 1]
    base.duration = 3
    const t = addTrack(p, 'video')
    const [id] = placeMedia(p, m.clone, start, t.id)
    const top = p.clips.find((c) => c.id === id)!
    top.srcIn = 3
    top.duration = 3
    if (mask) top.effects = [fx('differenceMask', mask)]
    return p
  }
  // At 1 s into the clips: the first take's box is at x=50..90, the second take's at x=170..210.
  const FIRST = '30:30:55:75'
  const SECOND = '30:30:175:75'
  const BACKGROUND = '40:40:260:20'
  const isWhite = (c: number[]) => c.every((v) => v > 220)
  const bg = [0x40, 0x50, 0x60]

  it('without a mask, the top take hides the bottom one', async () => {
    const out = await exportTo(cloneProject(0, null))
    expect(isWhite(await frameColor(out, 1, FIRST))).toBe(false)
    expect(isWhite(await frameColor(out, 1, SECOND))).toBe(true)
  })

  it('against a clean background image, only the person in the top take remains: both takes show', async () => {
    const out = await exportTo(cloneProject(0, { reference: 'plate', plate: m.plate.id }))
    expect(isWhite(await frameColor(out, 1, FIRST))).toBe(true)
    expect(isWhite(await frameColor(out, 1, SECOND))).toBe(true)
    expect(near(await frameColor(out, 1, BACKGROUND), bg, 6)).toBe(true)
  })

  it('the clean background can be a frame of a video (here: a moment where the box is out of the way)', async () => {
    // At 7.5 s the box is at x=310, off to the right of both measured areas.
    const out = await exportTo(cloneProject(0, { reference: 'plate', plate: m.clone.id, plateTime: 7.5 }))
    expect(isWhite(await frameColor(out, 1, FIRST))).toBe(true)
    expect(isWhite(await frameColor(out, 1, SECOND))).toBe(true)
  })

  it('“what is underneath” hides exactly what the clip shares with the layer below', async () => {
    // Over the clean background image, inverted: everything matching the background stays, the box goes.
    const p = project()
    placeMedia(p, m.plate, 0)
    p.clips[0].duration = 3
    const t = addTrack(p, 'video')
    const [id] = placeMedia(p, m.clone, 0, t.id)
    const top = p.clips.find((c) => c.id === id)!
    top.duration = 3
    top.effects = [fx('differenceMask', { reference: 'below', invert: true })]
    const out = await exportTo(p)
    expect(near(await frameColor(out, 1, FIRST), bg, 6)).toBe(true)
    // Not inverted: the matching background is hidden and the box remains.
    top.effects = [fx('differenceMask', { reference: 'below' })]
    const out2 = await exportTo(p)
    expect(isWhite(await frameColor(out2, 1, FIRST))).toBe(true)
  })

  it('a missing clean background leaves the clip unmasked', async () => {
    const out = await exportTo(cloneProject(0, { reference: 'plate', plate: 'gone' }))
    expect(isWhite(await frameColor(out, 1, FIRST))).toBe(false)
  })

  it('works for a clip starting late in a long timeline without stalling', async () => {
    const started = Date.now()
    const out = await exportTo(cloneProject(30, { reference: 'plate', plate: m.plate.id }))
    expect(isWhite(await frameColor(out, 31, FIRST))).toBe(true)
    expect(isWhite(await frameColor(out, 31, SECOND))).toBe(true)
    expect(Date.now() - started).toBeLessThan(60000)
  })
})

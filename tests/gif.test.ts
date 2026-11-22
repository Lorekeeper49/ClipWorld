// Transparent GIF export: a see-through background, a color made see-through (tolerance, feather), no
// trails from earlier frames, and settings saved before GIF transparency existed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import type { Caps } from '../src/shared/filtergraph'
import { type ExportSettings, type GifTransparency, defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { type MediaItem, type Project, newProject } from '../src/shared/model'
import { placeMedia } from '../src/shared/timeline-ops'
import { TMP, setupFfmpeg } from './helpers'

let caps: Caps
let screen: MediaItem

beforeAll(async () => {
  setupFfmpeg()
  caps = await usableCapabilities()
  // A red square sliding across a green screen, 2 s.
  const file = join(TMP, 'greenscreen.mkv')
  if (!existsSync(file)) {
    await ffmpeg(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=160x90:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=red:s=30x30:r=25:d=2',
      '-filter_complex', "[0][1]overlay=x='t*60':y=30", '-c:v', 'ffv1', file])
  }
  screen = await probeMedia(file)
})

/** The project: the green-screen clip, smaller than the frame (scaled to 50%) so part of the frame is empty. */
function project(): Project {
  const p = newProject()
  p.settings = { width: 160, height: 90, fps: 25 }
  p.media.push(screen)
  placeMedia(p, screen, 0)
  const c = p.clips[0]
  c.transform.start.scale = 0.5
  c.transform.end.scale = 0.5
  return p
}

let seq = 0
async function exportGif(p: Project, gif: Partial<GifTransparency>): Promise<string> {
  const out = join(TMP, `gif_${++seq}.gif`)
  const base = defaultExportSettings()
  const settings = normalizeExportSettings({ ...base, container: 'gif', gif: { ...base.gif, ...gif } }, caps.encoders)
  await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `gifjob_${seq}`), caps })
  return out
}

/** RGBA of one pixel of frame n (frames composed the way a GIF viewer shows them). */
async function pixel(file: string, n: number, x: number, y: number): Promise<number[]> {
  const chunks: Buffer[] = []
  await ffmpeg(['-loglevel', 'error', '-i', file, '-vf', `select='eq(n\\,${n})',crop=1:1:${x}:${y},format=rgba`, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { binary: (c) => chunks.push(c) })
  return [...Buffer.concat(chunks)]
}

describe('transparent GIF', () => {
  it('without transparency, empty areas are black as before', async () => {
    const out = await exportGif(project(), { transparent: false })
    expect((await pixel(out, 10, 5, 5))[3]).toBe(255)
    expect((await pixel(out, 10, 5, 5)).slice(0, 3).every((v) => v < 20)).toBe(true)
  })

  it('a transparent background leaves what nothing covers see-through, and keeps the clip', async () => {
    const out = await exportGif(project(), { transparent: true })
    expect((await pixel(out, 10, 5, 5))[3]).toBe(0)
    const green = await pixel(out, 10, 45, 30)
    expect(green[3]).toBe(255)
    expect(green[1]).toBeGreaterThan(200)
  })

  it('a chosen color disappears too, and nothing is left behind as things move', async () => {
    const out = await exportGif(project(), { transparent: true, key: true, color: '#00ff00', tolerance: 0.2, softness: 0.05 })
    // The green screen is gone, the red square stays.
    expect((await pixel(out, 0, 75, 30))[3]).toBe(0)
    const red = await pixel(out, 0, 49, 37)
    expect(red[3]).toBe(255)
    expect(red[0]).toBeGreaterThan(200)
    // Later the square has moved on: where it was is see-through again (no trail).
    expect((await pixel(out, 40, 49, 37))[3]).toBe(0)
  })

  it('feather rounds the corners of what stays', async () => {
    const sharp = await exportGif(project(), { transparent: true, key: true, color: '#00ff00', tolerance: 0.2, feather: 0 })
    // 60 px at 1080 lines is 5 px in this 90-line frame; the square is 15 px across.
    const soft = await exportGif(project(), { transparent: true, key: true, color: '#00ff00', tolerance: 0.2, feather: 60 })
    expect((await pixel(sharp, 0, 41, 39))[3]).toBe(255)
    expect((await pixel(soft, 0, 41, 39))[3]).toBe(0)
    expect((await pixel(soft, 0, 47, 45))[3]).toBe(255)
  })

  it('settings saved before GIF transparency existed get the defaults', () => {
    const old = { ...defaultExportSettings(), gif: undefined } as unknown as ExportSettings
    const s = normalizeExportSettings(old, caps.encoders)
    expect(s.gif).toEqual({ transparent: false, key: false, color: '#00ff00', tolerance: 0.15, softness: 0.05, feather: 0 })
    expect(normalizeExportSettings({ ...s, gif: { ...s.gif, tolerance: 7, color: 'red' } }, caps.encoders).gif).toMatchObject({ tolerance: 1, color: '#00ff00' })
  })
})

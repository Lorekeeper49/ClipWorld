// End-to-end export tests: real ffmpeg, synthetic media, results checked with ffprobe.
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import { EFFECTS, makeEffect } from '../src/shared/effects'
import type { Caps, ExportAssets } from '../src/shared/filtergraph'
import { CONTAINERS, type ExportSettings, defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { type MediaItem, type Project, defaultTransformState, newProject } from '../src/shared/model'
import { addTextClip, deleteClips, placeMedia, splitAt, stretchClip } from '../src/shared/timeline-ops'
import { type Fixtures, TMP, fixtures, frameColor, info, meanVolume, setupFfmpeg } from './helpers'

let fx: Fixtures
let caps: Caps
let video: MediaItem
let tone: MediaItem
let image: MediaItem
let gif: MediaItem
let seq = 0

beforeAll(async () => {
  setupFfmpeg()
  fx = await fixtures()
  caps = await usableCapabilities()
  ;[video, tone, image, gif] = await Promise.all([fx.video, fx.tone, fx.image, fx.gif].map(probeMedia))
})

function project(): Project {
  const p = newProject()
  p.settings = { width: 640, height: 360, fps: 30 }
  p.media.push(video, tone, image, gif)
  return p
}

async function exportTo(p: Project, ext: string, settings: Partial<ExportSettings> = {}, assets?: Partial<ExportAssets>): Promise<string> {
  const id = ++seq
  const outPath = join(TMP, `out_${id}.${ext}`)
  const s = normalizeExportSettings({ ...defaultExportSettings(), quality: 40, ...settings }, caps.encoders)
  await runExport({ project: p, settings: s, outPath, tmpDir: join(TMP, `job_${id}`), caps, assets })
  return outPath
}

describe('probe', () => {
  it('finds every audio stream of a video', () => {
    expect(video.kind).toBe('video')
    expect(video.duration).toBeCloseTo(6, 1)
    expect([video.width, video.height]).toEqual([640, 360])
    expect(video.audioStreams.map((a) => a.title)).toEqual(['Game', 'Mic'])
  })
  it('classifies audio, stills and animated images', () => {
    expect(tone.kind).toBe('audio')
    expect(image.kind).toBe('image')
    expect(image.animated).toBe(false)
    expect(gif.kind).toBe('image')
    expect(gif.animated).toBe(true)
    expect(gif.duration).toBeCloseTo(2, 1)
  })
})

describe('export', () => {
  it('exports a plain clip at the project resolution and frame rate', async () => {
    const p = project()
    p.settings = { width: 854, height: 480, fps: 24 }
    placeMedia(p, video, 0)
    const out = await exportTo(p, 'mp4')
    const i = await info(out)
    expect(i.duration).toBeCloseTo(6, 1)
    expect(i.video).toHaveLength(1)
    expect(i.audio).toHaveLength(1)
    expect([i.video[0].width, i.video[0].height]).toEqual([854, 480])
    expect(i.video[0].r_frame_rate).toBe('24/1')
  })

  it('rate-stretch changes the exported duration, video and audio alike', async () => {
    const p = project()
    const [v] = placeMedia(p, video, 0)
    stretchClip(p, v, 'end', 3)
    const fast = await info(await exportTo(p, 'mp4'))
    expect(fast.duration).toBeCloseTo(3, 1)
    expect(Number(fast.audio[0].duration)).toBeCloseTo(3, 1)
    stretchClip(p, v, 'end', 9)
    const slow = await info(await exportTo(p, 'mp4'))
    expect(slow.duration).toBeCloseTo(9, 1)
  })

  it('split + delete leaves a gap-free shorter timeline when the tail is removed', async () => {
    const p = project()
    placeMedia(p, video, 0)
    const right = splitAt(p, 2.5)
    deleteClips(p, right)
    const i = await info(await exportTo(p, 'mp4'))
    expect(i.duration).toBeCloseTo(2.5, 1)
  })

  it('per-track volume is applied, including above 100%', async () => {
    const base = project()
    placeMedia(base, video, 0)
    base.clips[2].volume = 0 // mute Mic
    const ref = await meanVolume(await exportTo(base, 'mkv', { container: 'mkv', audioCodec: 'flac' }))
    const loud = project()
    placeMedia(loud, video, 0)
    loud.clips[2].volume = 0
    loud.clips[1].volume = 0.25
    const quiet = await meanVolume(await exportTo(loud, 'mkv', { container: 'mkv', audioCodec: 'flac' }))
    expect(ref - quiet).toBeCloseTo(12.04, 0)
    // The source sine sits at about -21 dB, so +300% (x4, +12 dB) still has headroom.
    loud.clips[1].volume = 4
    const boosted = await meanVolume(await exportTo(loud, 'mkv', { container: 'mkv', audioCodec: 'flac' }))
    expect(boosted - ref).toBeCloseTo(12.04, 0)
  })

  it('can keep timeline audio tracks as separate streams', async () => {
    const p = project()
    placeMedia(p, video, 0)
    const i = await info(await exportTo(p, 'mkv', { container: 'mkv', audioMode: 'separate' }))
    expect(i.audio).toHaveLength(2)
    expect(i.audio.map((a) => a.tags?.title)).toEqual(['A1', 'A2'])
  })

  it('renders every video effect, zoom and an animated transform together', async () => {
    const p = project()
    const [v] = placeMedia(p, video, 0)
    const clip = p.clips.find((c) => c.id === v)!
    const assets: Partial<ExportAssets> = { overlays: {} }
    for (const def of EFFECTS.filter((e) => e.target === 'video')) {
      const e = makeEffect(def.type)
      clip.effects.push(e)
      if (def.kind === 'overlay') assets.overlays![e.id] = fx.overlay
    }
    clip.zoom = { enabled: true, start: 1, end: 1.6, focusX: 0.3, focusY: 0.6, ease: 'easeInOutQuad' }
    clip.transform = {
      animate: true, ease: 'easeOutCubic',
      start: { ...defaultTransformState(), x: -0.2, y: 0, scale: 0.5, rotation: 0, opacity: 0.2 },
      end: { ...defaultTransformState(), x: 0.2, y: 0.1, scale: 1.3, rotation: 25, opacity: 1, cropLeft: 0.1 }
    }
    const i = await info(await exportTo(p, 'mp4', {}, assets))
    expect(i.duration).toBeCloseTo(6, 1)
    expect([i.video[0].width, i.video[0].height]).toEqual([640, 360])
  })

  it('renders every audio effect together', async () => {
    const p = project()
    const [a] = placeMedia(p, tone, 0)
    const clip = p.clips.find((c) => c.id === a)!
    for (const def of EFFECTS.filter((e) => e.target === 'audio')) clip.effects.push(makeEffect(def.type))
    clip.preservePitch = false
    stretchClip(p, a, 'end', 4)
    const i = await info(await exportTo(p, 'flac', { container: 'flac' }))
    expect(i.video).toHaveLength(0)
    expect(i.duration).toBeCloseTo(4, 1)
  })

  it('pitch shift moves the tone', async () => {
    // A 1 kHz sine up an octave passes a 1.5 kHz high-pass almost untouched; unshifted it is attenuated.
    const make = async (semitones: number) => {
      const p = project()
      const [a] = placeMedia(p, tone, 0)
      const clip = p.clips.find((c) => c.id === a)!
      clip.effects.push({ ...makeEffect('pitch'), params: { semitones } })
      clip.effects.push({ ...makeEffect('highpass'), params: { frequency: 1500 } })
      return meanVolume(await exportTo(p, 'flac', { container: 'flac' }))
    }
    const shifted = await make(12)
    const plain = await make(0)
    expect(shifted - plain).toBeGreaterThan(4)
  })

  it('composites stills, GIFs and text above video in track order', async () => {
    const p = project()
    placeMedia(p, video, 0)
    placeMedia(p, image, 1)
    placeMedia(p, gif, 0.5)
    const t = addTextClip(p, 2)
    const text = p.clips.find((c) => c.id === t)!
    text.duration = 2
    const i = await info(await exportTo(p, 'mp4', {}, { text: { [t]: { path: fx.overlay, w: 200, h: 100, k: 1 } } }))
    expect(i.duration).toBeCloseTo(6, 1)
  })

  it('opacity, position and track visibility affect the picture', async () => {
    // A white-ish still over nothing: full opacity is bright, 25% is dark, hidden track is black.
    const make = async (mutate: (p: Project) => void) => {
      const p = project()
      placeMedia(p, image, 0)
      p.clips[0].effects.push({ ...makeEffect('brightness'), params: { amount: 3 } })
      p.clips[0].effects.push({ ...makeEffect('grayscale'), params: { amount: 1 } })
      mutate(p)
      return frameColor(await exportTo(p, 'mp4'), 1, '100:100:270:130')
    }
    const full = await make(() => {})
    const dim = await make((p) => { p.clips[0].transform.start.opacity = 0.25 })
    const hidden = await make((p) => { p.tracks[0].hidden = true; placeMedia(p, tone, 0) })
    const moved = await make((p) => { p.clips[0].transform.start.x = 2 })
    expect(full[0]).toBeGreaterThan(80)
    expect(dim[0]).toBeLessThan(full[0] * 0.45)
    expect(hidden[0]).toBeLessThan(25)
    expect(moved[0]).toBeLessThan(25)
  })

  it('exports to every container', async () => {
    for (const c of CONTAINERS) {
      const p = project()
      const [v] = placeMedia(p, video, 0)
      splitAt(p, 1)
      deleteClips(p, p.clips.filter((x) => x.start >= 1).map((x) => x.id))
      expect(v).toBeTruthy()
      const s = normalizeExportSettings({ ...defaultExportSettings(), container: c.id }, caps.encoders)
      const softwareFirst = { ...s, videoEncoder: s.videoEncoder }
      const i = await info(await exportTo(p, c.ext, softwareFirst))
      expect(i.duration, c.id).toBeGreaterThan(0.8)
      expect(i.duration, c.id).toBeLessThan(1.3)
      expect(i.video.length, c.id).toBe(c.video.length ? 1 : 0)
      expect(i.audio.length, c.id).toBe(c.audio.length ? 1 : 0)
    }
  })

  it('reports progress and can be cancelled', async () => {
    const p = project()
    placeMedia(p, video, 0)
    stretchClip(p, p.clips[0].id, 'end', 60)
    const seen: number[] = []
    const ac = new AbortController()
    const outPath = join(TMP, 'cancel.mp4')
    const s = normalizeExportSettings(defaultExportSettings(), caps.encoders)
    const run = runExport({
      project: p, settings: s, outPath, tmpDir: join(TMP, 'job_cancel'), caps, signal: ac.signal,
      onProgress: (f) => { seen.push(f); if (f > 0.05) ac.abort() }
    })
    await expect(run).rejects.toThrow(/Cancelled/)
    expect(seen.length).toBeGreaterThan(0)
  })
})

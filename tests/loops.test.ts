// Looping clips: the loop arithmetic, the timeline operations (Ctrl+drag, Properties changes, split,
// trim), and real-ffmpeg exports checked frame by frame and by loudness.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import type { Caps } from '../src/shared/filtergraph'
import { defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import {
  type ClipLoop, clipSegments, countForDuration, crossfadeGains, effectiveCrossfade, loopSegments, loopSpan, segmentAt, virtualToSource
} from '../src/shared/loop'
import { type Clip, type MediaItem, type Project, clipEnd, makeClip, makeTrack, newProject } from '../src/shared/model'
import { loopClip, placeMedia, setClipLoop, splitAt, stretchClip, trimClip } from '../src/shared/timeline-ops'
import { TMP, frameColor, info, setupFfmpeg } from './helpers'

const loop = (l: Partial<ClipLoop>): ClipLoop => ({ start: 1, end: 2, count: 1, intro: false, outro: false, crossfade: 0.5, ...l })

// ---------------------------------------------------------------- arithmetic

describe('loop arithmetic', () => {
  it('lays out intro, passes and outro', () => {
    const segs = loopSegments(loop({ count: 3, intro: true, outro: true }), 4)
    expect(segs.map((s) => [s.v0, s.v1, s.src])).toEqual([[0, 1, 0], [1, 2, 1], [2, 3, 1], [3, 4, 1], [4, 6, 2]])
    expect(loopSpan(loop({ count: 3, intro: true, outro: true }), 4)).toEqual({ first: 0, last: 6 })
    expect(loopSpan(loop({ count: 2.5 }), 4)).toEqual({ first: 1, last: 3.5 })
  })

  it('a partial pass into the outro crossfades, and nowhere else', () => {
    const l = loop({ count: 1.5, outro: true, crossfade: 0.4 })
    expect(effectiveCrossfade(l, 4)).toBeCloseTo(0.4)
    const segs = loopSegments(l, 4)
    expect(segs.map((s) => [s.v0, s.v1, s.src, s.mix?.src])).toEqual([[1, 2, 1, undefined], [2, 2.5, 1, undefined], [2.5, 2.9, 1.5, 2], [2.9, 4.5, 2.4, undefined]])
    // A whole number of passes runs straight into the outro; no outro means no fade.
    expect(effectiveCrossfade(loop({ count: 2, outro: true }), 4)).toBe(0)
    expect(effectiveCrossfade(loop({ count: 1.5 }), 4)).toBe(0)
    // The fade never runs past the loop end or the end of the file.
    expect(effectiveCrossfade(loop({ count: 1.9, outro: true, crossfade: 1 }), 4)).toBeCloseTo(0.1)
    expect(effectiveCrossfade(loop({ count: 1.5, outro: true, crossfade: 1, end: 3.8 }), 4)).toBeCloseTo(0.2)
  })

  it('maps virtual time to the file', () => {
    const l = loop({ count: 2.5, intro: true, outro: true, crossfade: 0.2 })
    expect(virtualToSource(l, 0.5, 4)).toBeCloseTo(0.5)
    expect(virtualToSource(l, 2.25, 4)).toBeCloseTo(1.25)
    expect(virtualToSource(l, 3.4, 4)).toBeCloseTo(1.4)
    // In the fade the old pass carries on; after it, the outro (shifted by the fade).
    expect(virtualToSource(l, 3.6, 4)).toBeCloseTo(1.6)
    expect(virtualToSource(l, 4, 4)).toBeCloseTo(2.5)
  })

  it('cuts segments to the clip window and finds the one playing', () => {
    const c = makeClip({ trackId: 't', type: 'audio', start: 10, duration: 1.5, srcIn: 1.5, speed: 1 })
    c.loop = loop({ count: 3 })
    expect(clipSegments(c, 4).map((s) => [s.v0, s.v1, s.src])).toEqual([[1.5, 2, 1.5], [2, 3, 1]])
    const at = segmentAt(c, 4, 11)
    expect([at.index, at.src, at.until]).toEqual([1, 1.5, 11.5])
  })

  it('equal-power crossfade keeps the loudness', () => {
    const [a, b] = crossfadeGains(0.5)
    expect(a * a + b * b).toBeCloseTo(1)
    expect(crossfadeGains(0)).toEqual([1, 0])
  })
})

// ---------------------------------------------------------------- timeline operations

function timeline(): { p: Project; media: MediaItem; video: Clip; audio: Clip } {
  const p = newProject()
  const media: MediaItem = {
    id: 'm', kind: 'video', name: 'beat.mp4', path: 'beat.mp4', size: 1, mtimeMs: 0, duration: 4, width: 320, height: 180, fps: 30,
    animated: false, hasAlpha: false, audioStreams: [{ index: 0, codec: 'aac', channels: 2, sampleRate: 48000, title: 'Audio 1' }]
  }
  p.media.push(media)
  const ids = placeMedia(p, media, 0)
  const video = p.clips.find((c) => c.id === ids[0])!
  const audio = p.clips.find((c) => c.type === 'audio')!
  // Show 1..3 s of the file, as if trimmed.
  for (const c of [video, audio]) Object.assign(c, { srcIn: 1, duration: 2 })
  return { p, media, video, audio }
}

describe('timeline operations', () => {
  it('Ctrl+drag loops what the clip shows, video and audio together', () => {
    const { p, video, audio } = timeline()
    expect(loopClip(p, video.id, 'end', 5)).toBe(true)
    for (const c of [video, audio]) {
      expect(c.loop).toMatchObject({ start: 1, end: 3, intro: false, outro: false })
      expect(c.loop!.count).toBeCloseTo(2.5)
      expect(c.duration).toBeCloseTo(5)
      expect(c.speed).toBe(1)
    }
    // Shorter again: fewer passes, down to part of one.
    loopClip(p, video.id, 'end', 1)
    expect(video.loop!.count).toBeCloseTo(0.5)
  })

  it('Ctrl+drag the start edge adds passes before the end', () => {
    const { p, video } = timeline()
    video.start = audio(p).start = 4
    expect(loopClip(p, video.id, 'start', 0)).toBe(true)
    expect(video.start).toBeCloseTo(0)
    expect(video.loop!.count).toBeCloseTo(3)
    expect(clipEnd(video)).toBeCloseTo(6)
  })

  it('Ctrl+drag stops at the next clip on the track', () => {
    const { p, video } = timeline()
    p.clips.push(makeClip({ trackId: video.trackId, type: 'video', start: 5, duration: 1, mediaId: 'm' }))
    loopClip(p, video.id, 'end', 9)
    expect(clipEnd(video)).toBeCloseTo(5)
  })

  it('loop counts at a different speed', () => {
    const { p, video } = timeline()
    stretchClip(p, video.id, 'end', 1) // 200%
    loopClip(p, video.id, 'end', 3)
    expect(video.loop!.count).toBeCloseTo(3)
    expect(countForDuration(video, video.loop!, 4, video.duration)).toBeCloseTo(3)
  })

  it('Properties: intro and outro move the start and end, loop points and count change the length', () => {
    const { p, video, audio: a } = timeline()
    expect(setClipLoop(p, video.id, { count: 2 })).toBe(true)
    expect(video.duration).toBeCloseTo(4)
    expect(setClipLoop(p, video.id, { intro: true })).toBe(true)
    expect(video.srcIn).toBe(0)
    expect(video.duration).toBeCloseTo(5)
    expect(setClipLoop(p, video.id, { outro: true })).toBe(true)
    expect(video.duration).toBeCloseTo(6)
    expect(setClipLoop(p, video.id, { start: 2, end: 3 })).toBe(true)
    expect(video.duration).toBeCloseTo(2 + 2 + 1)
    expect(a.loop).toEqual(video.loop)
    // Off again: the clip plays straight from where it was.
    expect(setClipLoop(p, video.id, null)).toBe(true)
    expect(video.loop).toBeUndefined()
    expect(video.srcIn).toBe(0)
  })

  it('Properties refuse a length that would run into the next clip', () => {
    const { p, video } = timeline()
    p.clips.push(makeClip({ trackId: video.trackId, type: 'video', start: 3, duration: 1, mediaId: 'm' }))
    expect(setClipLoop(p, video.id, { count: 3 })).toBe(false)
    expect(video.loop).toBeUndefined()
  })

  it('splitting a looped clip keeps playing the same thing', () => {
    const { p, video } = timeline()
    setClipLoop(p, video.id, { count: 2.5, intro: true, outro: true })
    const before = clipSegments(video, 4)
    const [rightId] = splitAt(p, 3.3, [video.id])
    const right = p.clips.find((c) => c.id === rightId)!
    const after = [...clipSegments(video, 4), ...clipSegments(right, 4)]
    // Same pieces of the file, possibly cut once more at the split.
    const sample = (segs: typeof before, v: number) => {
      const s = segs.find((x) => v >= x.v0 - 1e-9 && v < x.v1 - 1e-9)!
      return s.src + (v - s.v0)
    }
    for (let v = 0; v < 6.4; v += 0.1) expect(sample(after, v)).toBeCloseTo(sample(before, v))
  })

  it('trimming a looped clip stays inside the loop', () => {
    const { p, video } = timeline()
    setClipLoop(p, video.id, { count: 2 })
    trimClip(p, video.id, 'end', 20)
    expect(video.duration).toBeCloseTo(4)
    trimClip(p, video.id, 'start', -5)
    expect(video.srcIn).toBeCloseTo(1)
  })
})

function audio(p: Project): Clip {
  return p.clips.find((c) => c.type === 'audio')!
}

// ---------------------------------------------------------------- export

let caps: Caps
let src: MediaItem
const SECOND_COLORS = ['0xff0000', '0x00ff00', '0x0000ff', '0xffffff']
const SECOND_LEVELS = [0.05, 0.15, 0.4, 0.9]

beforeAll(async () => {
  setupFfmpeg()
  caps = await usableCapabilities()
  // Each second of the file has its own colour and its own loudness, so any frame or stretch of sound
  // tells which part of the file is playing.
  const file = join(TMP, 'loop_source.mkv')
  if (!existsSync(file)) {
    const video = SECOND_COLORS.map((c) => `color=c=${c}:s=160x90:r=30:d=1`).join('[v];')
    const graph =
      SECOND_COLORS.map((c, i) => `color=c=${c}:s=160x90:r=30:d=1[v${i}]`).join(';') + ';' +
      SECOND_LEVELS.map((l, i) => `sine=f=${300 + 200 * i}:d=1:sample_rate=48000,volume=${l * 8}[a${i}]`).join(';') + ';' +
      `${SECOND_COLORS.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=4:v=1:a=1[v][a]`
    void video
    await ffmpeg(['-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
      '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-c:a', 'pcm_s16le', file])
  }
  src = await probeMedia(file)
})

function loopProject(l: Partial<ClipLoop>, opts: { speed?: number; start?: number } = {}): { p: Project; video: Clip } {
  const p = newProject()
  p.settings = { width: 160, height: 90, fps: 30 }
  p.media.push(src)
  placeMedia(p, src, opts.start ?? 0)
  const video = p.clips.find((c) => c.type === 'video')!
  for (const c of p.clips) Object.assign(c, { srcIn: 1, duration: 1 })
  if (opts.speed) stretchClip(p, video.id, 'end', video.start + 1 / opts.speed)
  if (!setClipLoop(p, video.id, l)) throw new Error('could not loop')
  return { p, video }
}

let seq = 0
async function exportTo(p: Project): Promise<string> {
  const out = join(TMP, `loops_${++seq}.mkv`)
  const settings = normalizeExportSettings({ ...defaultExportSettings(), container: 'mkv', videoCodec: 'h264', quality: 100 }, caps.encoders)
  await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `loopsjob_${seq}`), caps })
  return out
}

/** RMS level of the exported audio between two times (mono mix). */
async function level(file: string, from: number, to: number): Promise<number> {
  const chunks: Buffer[] = []
  await ffmpeg(['-loglevel', 'error', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'],
    { binary: (c) => chunks.push(c) })
  const b = Buffer.concat(chunks)
  let sum = 0
  const n = b.length / 4
  for (let i = 0; i < n; i++) sum += b.readFloatLE(i * 4) ** 2
  return Math.sqrt(sum / n) * Math.SQRT2
}

const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(2).slice(i - 1, i + 1), 16))

describe('export', () => {
  it('intro, three passes and outro, in picture and sound', async () => {
    const { p } = loopProject({ count: 3, intro: true, outro: true })
    const out = await exportTo(p)
    expect((await info(out)).duration).toBeCloseTo(6, 1)
    // File seconds: 0 red (intro), 1 green ×3, then 2 blue and 3 white (outro).
    const expect_ = [[0.5, 0], [1.5, 1], [2.5, 1], [3.5, 1], [4.5, 2], [5.5, 3]]
    for (const [t, sec] of expect_) {
      expect(near(await frameColor(out, t), rgb(SECOND_COLORS[sec])), `frame at ${t}`).toBe(true)
      expect(await level(out, t - 0.3, t + 0.3), `sound at ${t}`).toBeCloseTo(SECOND_LEVELS[sec], 1)
    }
  })

  it('a partial pass crossfades into the outro', async () => {
    const { p, video } = loopProject({ count: 1.5, outro: true, crossfade: 0.4 })
    expect(video.duration).toBeCloseTo(3.5)
    const out = await exportTo(p)
    expect(near(await frameColor(out, 1.2), rgb(SECOND_COLORS[1])), 'partial pass').toBe(true)
    // Half way through the fade: half green, half blue.
    const mid = await frameColor(out, 1.7)
    expect(near(mid, [0, 128, 128], 45), `crossfade ${mid}`).toBe(true)
    expect(near(await frameColor(out, 2.2), rgb(SECOND_COLORS[2])), 'outro').toBe(true)
    expect(near(await frameColor(out, 3.0), rgb(SECOND_COLORS[3])), 'end of the file').toBe(true)
    // The sound fades from the loop's level into the outro's without a gap or a jump.
    expect(await level(out, 1.05, 1.4)).toBeCloseTo(SECOND_LEVELS[1], 1)
    const fade = await level(out, 1.6, 1.8)
    expect(fade).toBeGreaterThan(SECOND_LEVELS[1])
    expect(fade).toBeLessThan(SECOND_LEVELS[2] * 1.3)
    expect(await level(out, 2.05, 2.35)).toBeCloseTo(SECOND_LEVELS[2], 1)
  })

  it('loops at double speed, placed later on the timeline', async () => {
    const { p, video } = loopProject({ count: 4 }, { speed: 2, start: 3 })
    expect(video.duration).toBeCloseTo(2)
    const out = await exportTo(p)
    expect((await info(out)).duration).toBeCloseTo(5, 1)
    for (const t of [3.2, 3.7, 4.2, 4.8]) expect(near(await frameColor(out, t), rgb(SECOND_COLORS[1])), `frame at ${t}`).toBe(true)
  })

  it('many short passes stay in sync and export quickly', async () => {
    const { p, video } = loopProject({ start: 1, end: 1.5, count: 40, outro: true })
    expect(video.duration).toBeCloseTo(20 + 2.5)
    const t0 = Date.now()
    const out = await exportTo(p)
    expect(Date.now() - t0).toBeLessThan(60_000)
    const d = (await info(out)).duration
    expect(d).toBeCloseTo(22.5, 1)
    // After 40 passes the outro still starts on time: blue at 20.5 s, white at 21.5 s.
    expect(near(await frameColor(out, 19.8), rgb(SECOND_COLORS[1])), 'last pass').toBe(true)
    expect(near(await frameColor(out, 20.7), rgb(SECOND_COLORS[2])), 'outro').toBe(true)
    expect(await level(out, 20.6, 20.9)).toBeCloseTo(SECOND_LEVELS[2], 1)
    expect(near(await frameColor(out, 21.7), rgb(SECOND_COLORS[3])), 'end').toBe(true)
  })
})

void makeTrack

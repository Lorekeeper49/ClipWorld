// Reversed clips (negative speed): the time mapping shared by the preview and the export, the timeline
// operations, and real-ffmpeg exports checked frame by frame and by loudness.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import { type Caps, buildExport } from '../src/shared/filtergraph'
import { defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { forwardTime, playAt, reversePieces, virtualAt } from '../src/shared/loop'
import { type Clip, type MediaItem, type Project, makeClip, newProject, signedSpeed } from '../src/shared/model'
import { placeMedia, setClipLoop, setClipSpeed, splitAt, trimClip } from '../src/shared/timeline-ops'
import { TMP, frameColor, info, setupFfmpeg } from './helpers'

// ---------------------------------------------------------------- time mapping

describe('playing backwards', () => {
  const clip = (over: Partial<Clip> = {}) =>
    makeClip({ trackId: 't', type: 'video', start: 10, duration: 2, srcIn: 1, speed: 1.5, reverse: true, ...over })

  it('plays the same window from its end to its start', () => {
    const c = clip()
    // The window is 1 .. 4 s of the file.
    expect(virtualAt(c, 10)).toBeCloseTo(4, 3)
    expect(virtualAt(c, 11)).toBeCloseTo(2.5, 3)
    expect(virtualAt(c, 11.999)).toBeCloseTo(1, 2)
    // Just below each boundary: the frame before it, as the export shows.
    expect(virtualAt(c, 10)).toBeLessThan(4)
    expect(forwardTime(c, 10.5)).toBeCloseTo(11.5, 3)
    expect(virtualAt({ ...c, reverse: false }, 10.5)).toBeCloseTo(1.75)
  })

  it('a reversed loop plays its passes last to first', () => {
    const c = clip({ type: 'audio', duration: 3, srcIn: 1, speed: 1 })
    c.loop = { start: 1, end: 2, count: 3, intro: false, outro: false, crossfade: 0.5 }
    const at = playAt(c, 4, 10.25)
    // 0.25 s in, the last pass is playing, at 0.75 s into the loop, until the pass starts again.
    expect(at.index).toBe(2)
    expect(at.src).toBeCloseTo(1.75, 3)
    expect(at.until).toBeCloseTo(11, 3)
  })

  it('cuts the window into pieces in playing order', () => {
    const c = clip({ duration: 4, srcIn: 0, speed: 1 })
    const pieces = reversePieces(c, 10, 30, 50)
    expect(pieces.map((p) => p.count)).toEqual([50, 50, 20])
    expect(pieces.map((p) => Number(p.src.toFixed(4)))).toEqual([2.3333, 0.6667, 0])
    expect(pieces.reduce((s, p) => s + p.count, 0)).toBe(120)
  })

  it('a crossfade piece fades the other way', () => {
    const c = makeClip({ trackId: 't', type: 'video', start: 0, duration: 3.5, srcIn: 1, speed: 1, reverse: true })
    c.loop = { start: 1, end: 2, count: 1.5, intro: false, outro: true, crossfade: 0.4 }
    const pieces = reversePieces(c, 4, 30, 1000)
    const fade = pieces.find((p) => p.mix)!
    // In file order the outro's weight rises 0 → 1; the piece itself plays from 1 back to 0.
    expect(fade.mix!.p0).toBeCloseTo(0)
    expect(fade.mix!.p1).toBeCloseTo(1)
    expect(fade.count).toBe(12)
  })
})

// ---------------------------------------------------------------- timeline operations

function project(): { p: Project; media: MediaItem; video: Clip; audio: Clip } {
  const p = newProject()
  const media: MediaItem = {
    id: 'm', kind: 'video', name: 'clip.mp4', path: 'clip.mp4', size: 1, mtimeMs: 0, duration: 10, width: 320, height: 180, fps: 30,
    animated: false, hasAlpha: false, audioStreams: [{ index: 0, codec: 'aac', channels: 2, sampleRate: 48000, title: 'Audio 1' }]
  }
  p.media.push(media)
  placeMedia(p, media, 0)
  const video = p.clips.find((c) => c.type === 'video')!
  const audio = p.clips.find((c) => c.type === 'audio')!
  for (const c of p.clips) Object.assign(c, { srcIn: 2, duration: 4 })
  return { p, media, video, audio }
}

describe('reversed clips on the timeline', () => {
  it('a negative speed reverses the clip and its linked sound, keeping the same part of the file', () => {
    const { p, video, audio } = project()
    setClipSpeed(p, video.id, -2)
    for (const c of [video, audio]) {
      expect(c.reverse).toBe(true)
      expect(signedSpeed(c)).toBeCloseTo(-2)
      expect(c.srcIn).toBeCloseTo(2)
      expect(c.duration).toBeCloseTo(2)
    }
    setClipSpeed(p, video.id, 1)
    expect(video.reverse).toBeUndefined()
    expect(audio.reverse).toBeUndefined()
    expect(video.duration).toBeCloseTo(4)
  })

  it('text and pictures never play backwards', () => {
    const p = newProject()
    const c = makeClip({ trackId: p.tracks[0].id, type: 'text', start: 0, duration: 3 })
    p.clips.push(c)
    setClipSpeed(p, c.id, -1)
    expect(c.reverse).toBeUndefined()
  })

  it('splitting keeps every moment showing the same frame', () => {
    const { p, video } = project()
    setClipSpeed(p, video.id, -1)
    const before = (t: number) => virtualAt({ ...video, reverse: true, srcIn: 2, duration: 4 }, t)
    const [rightId] = splitAt(p, 1.5, [video.id])
    const right = p.clips.find((c) => c.id === rightId)!
    expect(right.reverse).toBe(true)
    for (let t = 0; t < 4; t += 0.25) {
      const c = t < 1.5 ? video : right
      expect(virtualAt(c, t), `at ${t}`).toBeCloseTo(before(t), 3)
    }
  })

  it('trimming an edge of a reversed clip shows more or less of the right end of the file', () => {
    const { p, video } = project()
    setClipSpeed(p, video.id, -1)
    // The right edge is the start of the window: dragging it out reveals earlier parts of the file.
    trimClip(p, video.id, 'end', 5)
    expect(video.srcIn).toBeCloseTo(1)
    expect(video.duration).toBeCloseTo(5)
    trimClip(p, video.id, 'end', 9)
    expect(video.srcIn).toBeCloseTo(0)
    expect(video.duration).toBeCloseTo(6)
    // The left edge is the end of the window: trimming it in keeps srcIn.
    trimClip(p, video.id, 'start', 1)
    expect(video.srcIn).toBeCloseTo(0)
    expect(video.duration).toBeCloseTo(5)
    expect(virtualAt(video, 1)).toBeCloseTo(5, 3)
  })
})

// ---------------------------------------------------------------- export

let caps: Caps
let src: MediaItem
const SECOND_COLORS = ['0xff0000', '0x00ff00', '0x0000ff', '0xffffff']
const SECOND_LEVELS = [0.05, 0.15, 0.4, 0.9]

beforeAll(async () => {
  setupFfmpeg()
  caps = await usableCapabilities()
  // Each second of the file has its own color and loudness, so a frame or a stretch of sound tells which
  // part of the file is playing.
  const file = join(TMP, 'loop_source.mkv')
  if (!existsSync(file)) {
    const graph =
      SECOND_COLORS.map((c, i) => `color=c=${c}:s=160x90:r=30:d=1[v${i}]`).join(';') + ';' +
      SECOND_LEVELS.map((l, i) => `sine=f=${300 + 200 * i}:d=1:sample_rate=48000,volume=${l * 8}[a${i}]`).join(';') + ';' +
      `${SECOND_COLORS.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=4:v=1:a=1[v][a]`
    await ffmpeg(['-loglevel', 'error', '-y', '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
      '-c:v', 'ffv1', '-pix_fmt', 'bgr0', '-c:a', 'pcm_s16le', file])
  }
  src = await probeMedia(file)
})

function reversedProject(speed = -1): { p: Project; video: Clip } {
  const p = newProject()
  p.settings = { width: 160, height: 90, fps: 30 }
  p.media.push(src)
  placeMedia(p, src, 0)
  const video = p.clips.find((c) => c.type === 'video')!
  setClipSpeed(p, video.id, speed)
  return { p, video }
}

let seq = 0
async function exportTo(p: Project): Promise<string> {
  const out = join(TMP, `reverse_${++seq}.mkv`)
  const settings = normalizeExportSettings({ ...defaultExportSettings(), container: 'mkv', videoCodec: 'h264', quality: 100 }, caps.encoders)
  await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `reversejob_${seq}`), caps })
  return out
}

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
  it('plays the file backwards, in picture and sound', async () => {
    const { p } = reversedProject()
    const out = await exportTo(p)
    expect((await info(out)).duration).toBeCloseTo(4, 1)
    for (const [t, sec] of [[0.5, 3], [1.5, 2], [2.5, 1], [3.5, 0]]) {
      expect(near(await frameColor(out, t), rgb(SECOND_COLORS[sec])), `frame at ${t}`).toBe(true)
      expect(await level(out, t - 0.3, t + 0.3), `sound at ${t}`).toBeCloseTo(SECOND_LEVELS[sec], 1)
    }
  })

  it('changes picture on the same frame as the preview', async () => {
    const { p, video } = reversedProject()
    const out = await exportTo(p)
    // Frames 28..32 straddle the first change (white → blue).
    for (let f = 28; f <= 32; f++) {
      const t = f / 30
      const sec = Math.floor(virtualAt(video, t + 1e-3))
      // A seek lands on the first frame at or after the time asked for.
      expect(near(await frameColor(out, t - 0.005), rgb(SECOND_COLORS[sec])), `frame ${f}`).toBe(true)
    }
  })

  it('reversed at double speed, with the in-graph pieces too', async () => {
    const { p, video } = reversedProject(-2)
    expect(video.duration).toBeCloseTo(2)
    const out = await exportTo(p)
    for (const [t, sec] of [[0.25, 3], [0.75, 2], [1.25, 1], [1.75, 0]]) {
      expect(near(await frameColor(out, t), rgb(SECOND_COLORS[sec])), `frame at ${t}`).toBe(true)
    }
    // Without rendered pieces the graph reverses them itself.
    const built = buildExport(p, normalizeExportSettings({ ...defaultExportSettings(), container: 'mkv' }, caps.encoders), { text: {}, overlays: {}, irs: {}, subtitles: {} }, caps)
    expect(built.filter).toContain('reverse')
    expect(built.filter).toContain('areverse')
  })

  it('a reversed loop with intro and outro', async () => {
    const { p, video } = reversedProject()
    setClipLoop(p, video.id, { start: 1, end: 2, count: 2, intro: true, outro: true })
    expect(video.duration).toBeCloseTo(5)
    const out = await exportTo(p)
    // Forwards: red, green, green, blue, white. Backwards: white, blue, green, green, red.
    for (const [t, sec] of [[0.5, 3], [1.5, 2], [2.5, 1], [3.5, 1], [4.5, 0]]) {
      expect(near(await frameColor(out, t), rgb(SECOND_COLORS[sec])), `frame at ${t}`).toBe(true)
      expect(await level(out, t - 0.3, t + 0.3), `sound at ${t}`).toBeCloseTo(SECOND_LEVELS[sec], 1)
    }
  })
})

// Looping clips. A looped clip plays a "virtual" stretch of its file:
//
//   [intro: file start → loop start]  [loop start → loop end] × count  [outro: loop end → file end]
//
// The intro and outro are optional. `count` can be fractional: the last pass then stops part way and, when
// there is an outro, crossfades into it (that jump is the only discontinuity, so it is the only fade).
// A clip's srcIn and duration*speed are measured on this virtual axis, which is ordinary source time up
// to the loop start, so splitting, trimming and speed changes work on looped clips unchanged.
//
// The preview and the export both play a clip from clipSegments(), so they agree.
import type { Clip, MediaItem } from './model'

export interface ClipLoop {
  /** Loop points, seconds in the source file. */
  start: number
  end: number
  /** Times the loop plays; can be fractional. */
  count: number
  /** Play the file from its start before the first loop. */
  intro: boolean
  /** Carry on past the loop end to the end of the file after the last loop. */
  outro: boolean
  /** Crossfade length (seconds of source) from a partial loop into the outro. */
  crossfade: number
}

export const MIN_LOOP = 0.05
export const MIN_LOOP_COUNT = 0.05
export const MAX_LOOP_COUNT = 999
export const DEFAULT_CROSSFADE = 0.5

/** A piece of the virtual timeline that plays one stretch of the file (or blends two). */
export interface Segment {
  /** Virtual range covered, [v0, v1). */
  v0: number
  v1: number
  /** Source time at v0; the source advances 1:1 with v. */
  src: number
  /** Crossfade: a second source blended in, its weight rising from p0 at v0 to p1 at v1. */
  mix?: { src: number; p0: number; p1: number }
}

/** Whether a clip can loop: video and audio clips of files with a known length. */
export const loopable = (c: Clip, m?: MediaItem): boolean => !!m && (c.type === 'video' || c.type === 'audio') && m.duration > 0

/** Keeps loop settings valid for a file of this length. */
export function clampLoop(l: ClipLoop, mediaDuration: number): ClipLoop {
  const end = Math.min(mediaDuration, Math.max(MIN_LOOP, l.end))
  const start = Math.min(end - MIN_LOOP, Math.max(0, l.start))
  return {
    start,
    end,
    count: Math.min(MAX_LOOP_COUNT, Math.max(MIN_LOOP_COUNT, Number.isFinite(l.count) ? l.count : 1)),
    intro: !!l.intro,
    outro: !!l.outro,
    crossfade: Math.max(0, Math.min(5, Number.isFinite(l.crossfade) ? l.crossfade : DEFAULT_CROSSFADE))
  }
}

/** The virtual range a loop covers: [first, last). */
export function loopSpan(l: ClipLoop, mediaDuration: number): { first: number; last: number } {
  const length = l.end - l.start
  return {
    first: l.intro ? 0 : l.start,
    last: l.start + l.count * length + (l.outro ? Math.max(0, mediaDuration - l.end) : 0)
  }
}

/** The virtual range a clip may cover: its loop's span, or the whole file. */
export function sourceBounds(c: Clip, mediaDuration: number): { first: number; last: number } {
  return c.loop ? loopSpan(c.loop, mediaDuration) : { first: 0, last: mediaDuration }
}

/** The crossfade actually used: only for a partial loop into an outro, and never longer than either side allows. */
export function effectiveCrossfade(l: ClipLoop, mediaDuration: number): number {
  const frac = l.count - Math.floor(l.count + 1e-9)
  if (!l.outro || frac < 1e-6) return 0
  const length = l.end - l.start
  return Math.max(0, Math.min(l.crossfade, (1 - frac) * length, mediaDuration - l.end))
}

/** Whether the loop stops part way into a pass before the outro (the case that may not sound right). */
export const partialIntoOutro = (l: ClipLoop): boolean => l.outro && l.count - Math.floor(l.count + 1e-9) > 1e-6

/** The whole virtual timeline of a loop as segments, in order. */
export function loopSegments(l: ClipLoop, mediaDuration: number): Segment[] {
  const out: Segment[] = []
  const length = l.end - l.start
  if (l.intro && l.start > 0) out.push({ v0: 0, v1: l.start, src: 0 })
  const whole = Math.floor(l.count + 1e-9)
  let v = l.start
  for (let k = 0; k < whole; k++, v += length) out.push({ v0: v, v1: v + length, src: l.start })
  const frac = l.count - whole
  const joint = l.start + l.count * length
  if (frac > 1e-6) out.push({ v0: v, v1: joint, src: l.start })
  if (l.outro && mediaDuration > l.end) {
    const x = effectiveCrossfade(l, mediaDuration)
    if (x > 0) {
      // The partial pass keeps going for x seconds while the outro fades in over it.
      out.push({ v0: joint, v1: joint + x, src: l.start + frac * length, mix: { src: l.end, p0: 0, p1: 1 } })
    }
    out.push({ v0: joint + x, v1: joint + (mediaDuration - l.end), src: l.end + x })
  }
  return out
}

/** The segments a clip plays, cut to its own window [srcIn, srcIn + duration*speed). */
export function clipSegments(c: Clip, mediaDuration: number): Segment[] {
  const w0 = c.srcIn
  const w1 = c.srcIn + c.duration * c.speed
  if (!c.loop) return [{ v0: w0, v1: w1, src: w0 }]
  const out: Segment[] = []
  for (const s of loopSegments(c.loop, mediaDuration)) {
    const a = Math.max(s.v0, w0)
    const b = Math.min(s.v1, w1)
    if (b - a < 1e-6) continue
    const off = a - s.v0
    const piece: Segment = { v0: a, v1: b, src: s.src + off }
    if (s.mix) {
      const span = s.v1 - s.v0
      const p = (v: number) => s.mix!.p0 + (s.mix!.p1 - s.mix!.p0) * ((v - s.v0) / span)
      piece.mix = { src: s.mix.src + off, p0: p(a), p1: p(b) }
    }
    out.push(piece)
  }
  // Rounding at the window's edges can leave it uncovered; play straight on rather than show nothing.
  return out.length ? out : [{ v0: w0, v1: w1, src: virtualToSource(c.loop, w0) }]
}

/** Source time at virtual time v (the primary source inside a crossfade). */
export function virtualToSource(l: ClipLoop | undefined, v: number, mediaDuration = Infinity): number {
  if (!l || v < l.start) return v
  const length = l.end - l.start
  const joint = l.start + l.count * length
  if (v < joint || !l.outro) return l.start + ((((v - l.start) % length) + length) % length)
  const x = effectiveCrossfade(l, mediaDuration)
  if (v < joint + x) return l.start + (l.count - Math.floor(l.count + 1e-9)) * length + (v - joint)
  return l.end + (v - joint)
}

export interface SegmentAt {
  index: number
  seg: Segment
  /** Source time of the primary stream. */
  src: number
  /** Crossfade only: source time of the stream fading in, and its weight 0..1. */
  mixSrc?: number
  mixWeight?: number
  /** Timeline time this segment ends. */
  until: number
}

/** Which segment plays at timeline time t, and where in the file. */
export function segmentAt(c: Clip, mediaDuration: number, t: number, segs = clipSegments(c, mediaDuration)): SegmentAt {
  const v = c.srcIn + Math.min(c.duration, Math.max(0, t - c.start)) * c.speed
  let index = segs.findIndex((s) => v < s.v1 - 1e-9)
  if (index < 0) index = segs.length - 1
  const seg = segs[index]
  const off = Math.max(0, v - seg.v0)
  const until = c.start + (seg.v1 - c.srcIn) / c.speed
  if (!seg.mix) return { index, seg, src: seg.src + off, until }
  const f = (v - seg.v0) / Math.max(1e-9, seg.v1 - seg.v0)
  return { index, seg, src: seg.src + off, mixSrc: seg.mix.src + off, mixWeight: seg.mix.p0 + (seg.mix.p1 - seg.mix.p0) * f, until }
}

/** Equal-power crossfade gains for audio (video blends linearly). */
export const crossfadeGains = (w: number): [number, number] => [Math.cos((w * Math.PI) / 2), Math.sin((w * Math.PI) / 2)]

/** Loop count that makes a clip with this loop last `duration` on the timeline. */
export function countForDuration(c: Clip, l: ClipLoop, mediaDuration: number, duration: number): number {
  const length = l.end - l.start
  const outro = l.outro ? Math.max(0, mediaDuration - l.end) : 0
  return (c.srcIn + duration * c.speed - outro - l.start) / length
}

/** A loop over what the clip shows now, played once: the starting point for Ctrl+drag. */
export function loopFromClip(c: Clip, mediaDuration: number): ClipLoop {
  const start = Math.max(0, Math.min(c.srcIn, mediaDuration - MIN_LOOP))
  const end = Math.min(mediaDuration, Math.max(start + MIN_LOOP, c.srcIn + c.duration * c.speed))
  return { start, end, count: 1, intro: false, outro: false, crossfade: DEFAULT_CROSSFADE }
}

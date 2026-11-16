import { describe, expect, it } from 'vitest'
import { EASES, EASE_NAMES, animExpr } from '../src/shared/easing'
import { atempoChain, echoTaps, reverbImpulse } from '../src/shared/effects'
import { type MediaItem, type Project, clipEnd, newProject, parseProject, projectDuration } from '../src/shared/model'
import {
  addTextClip, copyClips, deleteClips, deleteMedia, moveClips, pasteClips, placeMedia, splitAt, stretchClip,
  tracksOf, trimClip
} from '../src/shared/timeline-ops'

function media(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'm1', kind: 'video', name: 'clip.mkv', path: 'C:/clip.mkv', size: 1, mtimeMs: 1, duration: 10,
    width: 1920, height: 1080, fps: 30, animated: false, hasAlpha: false,
    audioStreams: [
      { index: 0, codec: 'aac', channels: 2, sampleRate: 48000, title: 'Game' },
      { index: 1, codec: 'aac', channels: 2, sampleRate: 48000, title: 'Mic' }
    ],
    ...over
  }
}

function withVideo(): { p: Project; ids: string[] } {
  const p = newProject()
  const m = media()
  p.media.push(m)
  return { p, ids: placeMedia(p, m, 0) }
}

/** Evaluates an ffmpeg expression in JS (only the functions the easing module emits). */
function evalExpr(expr: string, t: number): number {
  const fn = new Function(
    't', 'pow', 'clip', 'lt', 'if_',
    `return ${expr.replace(/\bif\(/g, 'if_(')}`
  )
  return fn(t, Math.pow, (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)), (a: number, b: number) => (a < b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b))
}

describe('easing', () => {
  it('ffmpeg expressions agree with the JS functions', () => {
    for (const name of EASE_NAMES) {
      const expr = animExpr(2, 10, name, 't', 1, 4)
      for (const t of [0, 1, 1.5, 2.9, 3, 3.1, 4.7, 5, 9]) {
        const p = Math.min(1, Math.max(0, (t - 1) / 4))
        expect(evalExpr(expr, t)).toBeCloseTo(2 + 8 * EASES[name].fn(p), 5)
      }
    }
  })
  it('constant animations collapse to a number', () => {
    expect(animExpr(1.5, 1.5, 'easeIn', 't', 0, 3)).toBe('1.5')
  })
})

describe('placing media', () => {
  it('a video brings one linked audio clip per audio stream, each on its own track', () => {
    const { p, ids } = withVideo()
    expect(ids).toHaveLength(3)
    const clips = p.clips
    expect(clips.map((c) => c.type)).toEqual(['video', 'audio', 'audio'])
    expect(new Set(clips.map((c) => c.linkId)).size).toBe(1)
    expect(clips[0].linkId).toBeTruthy()
    expect(new Set(clips.map((c) => c.trackId)).size).toBe(3)
    expect(tracksOf(p, 'audio')).toHaveLength(2)
    expect(clips[1].audioStream).toBe(0)
    expect(clips[2].audioStream).toBe(1)
  })
  it('places on a new track when the range is occupied', () => {
    const { p } = withVideo()
    placeMedia(p, p.media[0], 5)
    expect(tracksOf(p, 'video')).toHaveLength(2)
    expect(tracksOf(p, 'audio')).toHaveLength(4)
  })
})

describe('split', () => {
  it('splits a linked group at the playhead and keeps the halves linked separately', () => {
    const { p } = withVideo()
    const created = splitAt(p, 4)
    expect(created).toHaveLength(3)
    expect(p.clips).toHaveLength(6)
    const left = p.clips.filter((c) => c.start === 0)
    const right = p.clips.filter((c) => c.start === 4)
    expect(left.every((c) => c.duration === 4)).toBe(true)
    expect(right.every((c) => c.duration === 6 && c.srcIn === 4)).toBe(true)
    expect(new Set(left.map((c) => c.linkId)).size).toBe(1)
    expect(new Set(right.map((c) => c.linkId)).size).toBe(1)
    expect(left[0].linkId).not.toBe(right[0].linkId)
  })
  it('accounts for speed when computing the source in-point', () => {
    const { p, ids } = withVideo()
    stretchClip(p, ids[0], 'end', 5) // 2x speed
    splitAt(p, 2)
    const right = p.clips.find((c) => c.type === 'video' && c.start === 2)!
    expect(right.srcIn).toBeCloseTo(4)
    expect(right.duration).toBeCloseTo(3)
  })
  it('does nothing at clip edges', () => {
    const { p } = withVideo()
    expect(splitAt(p, 0)).toHaveLength(0)
    expect(splitAt(p, 10)).toHaveLength(0)
  })
  it('keeps animations continuous', () => {
    const { p, ids } = withVideo()
    const v = p.clips.find((c) => c.id === ids[0])!
    v.transform.animate = true
    v.transform.ease = 'linear'
    v.transform.end.scale = 3
    splitAt(p, 5)
    const right = p.clips.find((c) => c.type === 'video' && c.start === 5)!
    expect(v.transform.end.scale).toBeCloseTo(2)
    expect(right.transform.start.scale).toBeCloseTo(2)
    expect(right.transform.end.scale).toBeCloseTo(3)
  })
})

describe('rate-stretch', () => {
  it('changes speed instead of trimming, for the video and its audio', () => {
    const { p, ids } = withVideo()
    expect(stretchClip(p, ids[0], 'end', 5)).toBe(true)
    for (const c of p.clips) {
      expect(c.duration).toBeCloseTo(5)
      expect(c.speed).toBeCloseTo(2)
      expect(c.srcIn).toBe(0)
    }
    expect(stretchClip(p, ids[0], 'end', 20)).toBe(true)
    for (const c of p.clips) expect(c.speed).toBeCloseTo(0.5)
  })
  it('stretching from the left keeps the right edge fixed', () => {
    const { p, ids } = withVideo()
    moveClips(p, Object.fromEntries(p.clips.map((c) => [c.id, { start: c.start, trackId: c.trackId }])), 10)
    stretchClip(p, ids[0], 'start', 15)
    const v = p.clips[0]
    expect(v.start).toBeCloseTo(15)
    expect(clipEnd(v)).toBeCloseTo(20)
    expect(v.speed).toBeCloseTo(2)
  })
  it('stops at the neighbouring clip', () => {
    const { p, ids } = withVideo()
    const m2 = media({ id: 'm2', audioStreams: [] })
    p.media.push(m2)
    const [second] = placeMedia(p, m2, 12, p.clips[0].trackId)
    expect(p.clips.find((c) => c.id === second)!.trackId).toBe(p.clips[0].trackId)
    stretchClip(p, ids[0], 'end', 30)
    expect(clipEnd(p.clips[0])).toBeCloseTo(12)
  })
  it('stills just change length', () => {
    const p = newProject()
    const img = media({ id: 'i', kind: 'image', duration: 0, audioStreams: [] })
    p.media.push(img)
    const [id] = placeMedia(p, img, 0)
    stretchClip(p, id, 'end', 12)
    expect(p.clips[0].duration).toBeCloseTo(12)
    expect(p.clips[0].speed).toBe(1)
  })
})

describe('trim', () => {
  it('cannot reveal more source than exists', () => {
    const { p, ids } = withVideo()
    splitAt(p, 4)
    deleteClips(p, [p.clips.find((c) => c.start === 4)!.id])
    expect(p.clips).toHaveLength(3)
    trimClip(p, ids[0], 'end', 50)
    expect(p.clips[0].duration).toBeCloseTo(10)
    trimClip(p, ids[0], 'start', 3)
    expect(p.clips[0].start).toBeCloseTo(3)
    expect(p.clips[0].srcIn).toBeCloseTo(3)
    expect(p.clips[1].srcIn).toBeCloseTo(3)
  })
})

describe('move, copy, paste, delete', () => {
  it('refuses moves that overlap', () => {
    const { p } = withVideo()
    const m2 = media({ id: 'm2', audioStreams: [] })
    p.media.push(m2)
    const [second] = placeMedia(p, m2, 12, p.clips[0].trackId)
    const c = p.clips.find((x) => x.id === second)!
    expect(moveClips(p, { [second]: { start: 12, trackId: c.trackId } }, -5)).toBe(false)
    expect(c.start).toBe(12)
    expect(moveClips(p, { [second]: { start: 12, trackId: c.trackId } }, -2)).toBe(true)
    expect(c.start).toBe(10)
  })
  it('pastes a linked group at the playhead with fresh ids and links', () => {
    const { p, ids } = withVideo()
    const data = copyClips(p, [ids[0]])!
    expect(data.clips).toHaveLength(3)
    const pasted = pasteClips(p, data, 10)
    expect(pasted).toHaveLength(3)
    const fresh = p.clips.filter((c) => pasted.includes(c.id))
    expect(fresh.every((c) => c.start === 10)).toBe(true)
    expect(fresh[0].linkId).not.toBe(p.clips[0].linkId)
    expect(new Set(fresh.map((c) => c.linkId)).size).toBe(1)
    // Same tracks were free at t=10, so no new tracks.
    expect(p.tracks).toHaveLength(3)
    // Pasting on top of existing clips goes to new tracks.
    pasteClips(p, data, 0)
    expect(p.tracks).toHaveLength(6)
  })
  it('deleting media removes every clip that uses it', () => {
    const { p } = withVideo()
    splitAt(p, 3)
    addTextClip(p, 0)
    deleteMedia(p, 'm1')
    expect(p.media).toHaveLength(0)
    expect(p.clips.map((c) => c.type)).toEqual(['text'])
  })
  it('deleting one clip deletes its linked clips', () => {
    const { p, ids } = withVideo()
    deleteClips(p, [ids[1]])
    expect(p.clips).toHaveLength(0)
  })
})

describe('project files', () => {
  it('round-trips through JSON', () => {
    const { p } = withVideo()
    addTextClip(p, 2)
    const back = parseProject(JSON.parse(JSON.stringify(p)))
    expect(back).toEqual(p)
    expect(projectDuration(back)).toBe(10)
  })
  it('rejects foreign files', () => {
    expect(() => parseProject({ hello: 1 })).toThrow()
    expect(() => parseProject({ app: 'ClipWorld', version: 999, tracks: [], clips: [] })).toThrow(/newer/)
  })
})

describe('audio helpers', () => {
  it('atempo chains multiply to the requested tempo', () => {
    for (const t of [0.05, 0.3, 0.5, 1, 1.7, 20]) {
      const product = atempoChain(t).reduce((a, f) => a * Number(f.split('=')[1]), 1)
      expect(product).toBeCloseTo(t, 5)
    }
  })
  it('echo taps decay geometrically', () => {
    const { delays, decays } = echoTaps(250, 0.5)
    expect(delays.slice(0, 3)).toEqual([250, 500, 750])
    expect(decays.slice(0, 3)).toEqual([0.5, 0.25, 0.125])
  })
  it('reverb impulse carries the dry signal at mix 0', () => {
    const [l] = reverbImpulse(0.5, 0)
    expect(l[0]).toBeCloseTo(1)
    expect(Math.max(...Array.from(l.slice(1)).map(Math.abs))).toBeCloseTo(0)
  })
})

// Timeline editing operations. All of them mutate the given project in place, so they can run
// inside an Immer recipe (renderer) or on a plain object (tests).
import { lerp, transformAt, zoomAt } from './easing'
import {
  type Clip, type MediaItem, type Project, type TextProps, type Track, type TrackKind,
  DEFAULT_STILL_DURATION, MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED,
  clipEnd, clone, defaultText, isTimed, makeClip, makeTrack, uid
} from './model'

import {
  type ClipLoop, MAX_LOOP_COUNT, MIN_LOOP_COUNT, clampLoop, countForDuration, loopFromClip, loopSpan, loopable, sourceBounds, virtualToSource
} from './loop'

const EPS = 1e-6

export const mediaById = (p: Project, id?: string): MediaItem | undefined => p.media.find((m) => m.id === id)
export const clipById = (p: Project, id: string): Clip | undefined => p.clips.find((c) => c.id === id)
export const trackById = (p: Project, id: string): Track | undefined => p.tracks.find((t) => t.id === id)
export const tracksOf = (p: Project, kind: TrackKind): Track[] => p.tracks.filter((t) => t.kind === kind)

/** The clip plus everything linked to it. */
export function groupOf(p: Project, c: Clip): Clip[] {
  return c.linkId ? p.clips.filter((o) => o.linkId === c.linkId) : [c]
}

/** Expands a set of clip ids to include linked clips. */
export function withLinked(p: Project, ids: Iterable<string>): string[] {
  const set = new Set(ids)
  const links = new Set<string>()
  for (const c of p.clips) if (set.has(c.id) && c.linkId) links.add(c.linkId)
  for (const c of p.clips) if (c.linkId && links.has(c.linkId)) set.add(c.id)
  return [...set]
}

export function isRangeFree(p: Project, trackId: string, start: number, end: number, ignore?: Set<string>): boolean {
  for (const c of p.clips) {
    if (c.trackId !== trackId || ignore?.has(c.id)) continue
    if (start < clipEnd(c) - EPS && end > c.start + EPS) return false
  }
  return true
}

/** Adds a track. Video tracks are added in front (top), audio tracks at the bottom. */
export function addTrack(p: Project, kind: TrackKind): Track {
  const used = new Set(tracksOf(p, kind).map((t) => t.name))
  let i = 1
  while (used.has((kind === 'video' ? 'V' : 'A') + i)) i++
  const t = makeTrack(kind, i)
  if (kind === 'video') p.tracks.unshift(t)
  else p.tracks.push(t)
  return t
}

export function removeTrack(p: Project, trackId: string): boolean {
  const t = trackById(p, trackId)
  if (!t) return false
  if (p.clips.some((c) => c.trackId === trackId)) return false
  if (tracksOf(p, t.kind).length <= 1) return false
  p.tracks = p.tracks.filter((o) => o.id !== trackId)
  return true
}

/** Video tracks from back (bottom of the stack) to front. */
function videoTracksBackToFront(p: Project): Track[] {
  return tracksOf(p, 'video').reverse()
}

function freeTrack(p: Project, kind: TrackKind, start: number, end: number, preferred?: string, exclude?: Set<string>): Track {
  const pref = preferred ? trackById(p, preferred) : undefined
  if (pref && pref.kind === kind && !exclude?.has(pref.id) && isRangeFree(p, pref.id, start, end)) return pref
  const candidates = kind === 'video' ? videoTracksBackToFront(p) : tracksOf(p, 'audio')
  for (const t of candidates) {
    if (exclude?.has(t.id)) continue
    if (isRangeFree(p, t.id, start, end)) return t
  }
  return addTrack(p, kind)
}

/** Places a media item on the timeline. A video brings one linked audio clip per audio stream. */
export function placeMedia(p: Project, media: MediaItem, time: number, preferredTrackId?: string): string[] {
  const start = Math.max(0, time)
  const ids: string[] = []
  if (media.kind === 'audio') {
    const duration = Math.max(MIN_CLIP_DURATION, media.duration)
    const t = freeTrack(p, 'audio', start, start + duration, preferredTrackId)
    const c = makeClip({ trackId: t.id, type: 'audio', start, duration, mediaId: media.id, name: media.name })
    p.clips.push(c)
    return [c.id]
  }
  if (media.kind === 'image') {
    const duration = media.animated && media.duration > 0 ? media.duration : DEFAULT_STILL_DURATION
    const t = freeTrack(p, 'video', start, start + duration, preferredTrackId)
    const c = makeClip({ trackId: t.id, type: 'image', start, duration, mediaId: media.id, name: media.name })
    p.clips.push(c)
    return [c.id]
  }
  const duration = Math.max(MIN_CLIP_DURATION, media.duration)
  const linkId = media.audioStreams.length ? uid('l') : undefined
  const vt = freeTrack(p, 'video', start, start + duration, preferredTrackId)
  const v = makeClip({ trackId: vt.id, type: 'video', start, duration, mediaId: media.id, name: media.name, linkId })
  p.clips.push(v)
  ids.push(v.id)
  const usedTracks = new Set<string>()
  for (const s of media.audioStreams) {
    const at = freeTrack(p, 'audio', start, start + duration, undefined, usedTracks)
    usedTracks.add(at.id)
    const a = makeClip({
      trackId: at.id, type: 'audio', start, duration, mediaId: media.id, audioStream: s.index,
      name: s.title, linkId
    })
    p.clips.push(a)
    ids.push(a.id)
  }
  return ids
}

export function addTextClip(p: Project, time: number, text?: Partial<TextProps>): string {
  const start = Math.max(0, time)
  const duration = DEFAULT_STILL_DURATION
  const front = tracksOf(p, 'video')[0]
  const t = front && isRangeFree(p, front.id, start, start + duration) ? front : addTrack(p, 'video')
  const props = { ...defaultText(), ...text }
  const c = makeClip({ trackId: t.id, type: 'text', start, duration, name: 'Text', text: props })
  p.clips.push(c)
  return c.id
}

/**
 * Puts a subtitle track on the timeline as one clip on a new front video track, spanning its first
 * cue start to its last cue end, so the subtitles land exactly where they were timed.
 */
export function addSubtitleClip(p: Project, subtitleTrackId: string): string | null {
  const st = p.subtitles.find((s) => s.id === subtitleTrackId)
  if (!st || !st.cues.length) return null
  const first = Math.min(...st.cues.map((c) => c.start))
  const last = Math.max(...st.cues.map((c) => c.end))
  const duration = Math.max(MIN_CLIP_DURATION, last - first)
  const t = addTrack(p, 'video')
  const c = makeClip({
    trackId: t.id, type: 'subtitles', start: first, duration, srcIn: first, subtitleTrackId, name: st.name
  })
  p.clips.push(c)
  return c.id
}

/** Removes a subtitle track and every timeline clip that shows it. */
export function deleteSubtitleTrack(p: Project, subtitleTrackId: string): void {
  p.clips = p.clips.filter((c) => c.subtitleTrackId !== subtitleTrackId)
  p.subtitles = p.subtitles.filter((s) => s.id !== subtitleTrackId)
}

/**
 * Splits clips at `time`. With `ids`, only those clips (and their links); otherwise every clip under
 * the time. Returns the ids of the new right-hand halves.
 */
export function splitAt(p: Project, time: number, ids?: string[]): string[] {
  const only = ids?.length ? new Set(withLinked(p, ids)) : null
  const targets = p.clips.filter(
    (c) => (!only || only.has(c.id)) && time > c.start + MIN_CLIP_DURATION && time < clipEnd(c) - MIN_CLIP_DURATION
  )
  const linkMap = new Map<string, string>()
  const created: string[] = []
  for (const c of targets) {
    const local = time - c.start
    const right = clone(c) as Clip
    right.id = uid('c')
    right.start = time
    right.duration = c.duration - local
    right.srcIn = c.srcIn + local * c.speed
    right.effects = right.effects.map((e) => ({ ...e, id: uid('e') }))
    if (c.linkId) {
      if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('l'))
      right.linkId = linkMap.get(c.linkId)
    }
    // Keep animations continuous across the cut.
    if (c.transform.animate) {
      const mid = { ...transformAt(c.transform, local, c.duration) }
      right.transform.start = mid
      c.transform.end = { ...mid }
    }
    if (c.zoom.enabled) {
      const mid = zoomAt(c.zoom, local, c.duration)
      right.zoom.start = mid
      c.zoom.end = mid
    }
    c.duration = local
    p.clips.push(right)
    created.push(right.id)
  }
  return created
}

function neighbours(p: Project, c: Clip, ignore: Set<string>): { prevEnd: number; nextStart: number } {
  let prevEnd = 0
  let nextStart = Infinity
  for (const o of p.clips) {
    if (o.trackId !== c.trackId || ignore.has(o.id)) continue
    if (clipEnd(o) <= c.start + EPS) prevEnd = Math.max(prevEnd, clipEnd(o))
    else if (o.start >= clipEnd(c) - EPS) nextStart = Math.min(nextStart, o.start)
  }
  return { prevEnd, nextStart }
}

/**
 * Rate-stretch: drags a clip edge to `time`, changing the clip's length by changing its speed.
 * Linked clips stretch by the same factor. Returns false (and changes nothing) if impossible.
 */
export function stretchClip(p: Project, clipId: string, edge: 'start' | 'end', time: number): boolean {
  const g = clipById(p, clipId)
  if (!g) return false
  const members = groupOf(p, g)
  const ignore = new Set(members.map((m) => m.id))
  const gs = g.start
  const ge = clipEnd(g)
  const anchor = edge === 'end' ? gs : ge
  let factor = edge === 'end' ? (time - gs) / (ge - gs) : (ge - time) / (ge - gs)
  if (!Number.isFinite(factor)) return false

  let lo = 0
  let hi = Infinity
  for (const m of members) {
    lo = Math.max(lo, MIN_CLIP_DURATION / m.duration)
    if (isTimed(m, mediaById(p, m.mediaId))) {
      lo = Math.max(lo, m.speed / MAX_SPEED)
      hi = Math.min(hi, m.speed / MIN_SPEED)
    }
    const { prevEnd, nextStart } = neighbours(p, m, ignore)
    if (edge === 'end') {
      const span = clipEnd(m) - anchor
      if (span > EPS && nextStart < Infinity) hi = Math.min(hi, (nextStart - anchor) / span)
    } else {
      const span = anchor - m.start
      if (span > EPS) hi = Math.min(hi, (anchor - prevEnd) / span)
    }
  }
  if (hi < lo) return false
  factor = Math.min(hi, Math.max(lo, factor))
  if (Math.abs(factor - 1) < 1e-9) return true

  const next = members.map((m) => {
    const start = anchor + (m.start - anchor) * factor
    return { m, start, duration: m.duration * factor }
  })
  for (const n of next) {
    if (n.start < -EPS) return false
    if (!isRangeFree(p, n.m.trackId, n.start, n.start + n.duration, ignore)) return false
  }
  for (const n of next) {
    const timed = isTimed(n.m, mediaById(p, n.m.mediaId))
    n.m.start = Math.max(0, n.start)
    n.m.duration = n.duration
    if (timed) n.m.speed = n.m.speed / factor
  }
  return true
}

/** Classic trim: moves an edge without changing speed, revealing or hiding source material. */
export function trimClip(p: Project, clipId: string, edge: 'start' | 'end', time: number): boolean {
  const g = clipById(p, clipId)
  if (!g) return false
  const members = groupOf(p, g)
  const ignore = new Set(members.map((m) => m.id))
  let delta = edge === 'end' ? time - clipEnd(g) : time - g.start
  let lo = -Infinity
  let hi = Infinity
  for (const m of members) {
    const media = mediaById(p, m.mediaId)
    const timed = isTimed(m, media)
    const { prevEnd, nextStart } = neighbours(p, m, ignore)
    if (edge === 'end') {
      lo = Math.max(lo, MIN_CLIP_DURATION - m.duration)
      hi = Math.min(hi, nextStart - clipEnd(m))
      if (timed && media) hi = Math.min(hi, (sourceBounds(m, media.duration).last - m.srcIn) / m.speed - m.duration)
    } else {
      hi = Math.min(hi, m.duration - MIN_CLIP_DURATION)
      lo = Math.max(lo, prevEnd - m.start, -m.start)
      if (timed) lo = Math.max(lo, -(m.srcIn - (media ? sourceBounds(m, media.duration).first : 0)) / m.speed)
    }
  }
  if (hi < lo) return false
  delta = Math.min(hi, Math.max(lo, delta))
  if (Math.abs(delta) < 1e-9) return true
  for (const m of members) {
    if (edge === 'end') {
      m.duration += delta
    } else {
      if (isTimed(m, mediaById(p, m.mediaId))) m.srcIn = Math.max(m.loop?.intro === false ? m.loop.start : 0, m.srcIn + delta * m.speed)
      m.start = Math.max(0, m.start + delta)
      m.duration -= delta
    }
  }
  return true
}

/**
 * Loop-drag (Ctrl+drag an edge): makes the clip longer or shorter by playing it more or fewer times,
 * at the same speed. A clip that doesn't loop yet starts looping what it shows now. Linked clips loop
 * together. Returns false (and changes nothing) if the clip can't loop or there is no room.
 */
export function loopClip(p: Project, clipId: string, edge: 'start' | 'end', time: number): boolean {
  const g = clipById(p, clipId)
  if (!g) return false
  const members = groupOf(p, g)
  const ignore = new Set(members.map((m) => m.id))
  const plans: { m: Clip; dur: number; loop: ClipLoop }[] = []
  for (const m of members) {
    const media = mediaById(p, m.mediaId)
    if (!loopable(m, media)) return false
    plans.push({ m, dur: media!.duration, loop: m.loop ?? loopFromClip(m, media!.duration) })
  }
  let delta = edge === 'end' ? time - clipEnd(g) : g.start - time
  let lo = -Infinity
  let hi = Infinity
  for (const { m, dur, loop } of plans) {
    // Longest and shortest the loop count allows (and never shorter than the minimum clip).
    const length = (count: number) => (loopSpan({ ...loop, count }, dur).last - m.srcIn) / m.speed
    lo = Math.max(lo, Math.max(MIN_CLIP_DURATION, length(MIN_LOOP_COUNT)) - m.duration)
    hi = Math.min(hi, length(MAX_LOOP_COUNT) - m.duration)
    const { prevEnd, nextStart } = neighbours(p, m, ignore)
    if (edge === 'end') hi = Math.min(hi, nextStart - clipEnd(m))
    else hi = Math.min(hi, m.start - prevEnd)
  }
  if (hi < lo) return false
  delta = Math.min(hi, Math.max(lo, delta))
  for (const { m, dur, loop } of plans) {
    const duration = m.duration + delta
    m.loop = clampLoop({ ...loop, count: countForDuration(m, loop, dur, duration) }, dur)
    if (edge === 'start') m.start = Math.max(0, m.start - delta)
    m.duration = duration
  }
  return true
}

/**
 * Changes a clip's loop (and its linked clips'), or removes it with `null`. The clip's length follows:
 * it ends where the loop (and outro) ends. Turning the intro on or off moves where the clip starts in
 * the file. Returns false (and changes nothing) when the new length would overlap the next clip.
 */
export function setClipLoop(p: Project, clipId: string, patch: Partial<ClipLoop> | null): boolean {
  const g = clipById(p, clipId)
  if (!g) return false
  const members = groupOf(p, g)
  const ignore = new Set(members.map((m) => m.id))
  const next: { m: Clip; loop?: ClipLoop; srcIn: number; duration: number }[] = []
  for (const m of members) {
    const media = mediaById(p, m.mediaId)
    if (!loopable(m, media)) return false
    const dur = media!.duration
    if (!patch) {
      if (!m.loop) continue
      const srcIn = virtualToSource(m.loop, m.srcIn, dur)
      next.push({ m, srcIn, duration: Math.max(MIN_CLIP_DURATION, Math.min(m.duration, (dur - srcIn) / m.speed)) })
      continue
    }
    const old = m.loop ?? loopFromClip(m, dur)
    const loop = clampLoop({ ...old, ...patch }, dur)
    const oldFirst = loopSpan(old, dur).first
    const { first, last } = loopSpan(loop, dur)
    // A clip that starts at the beginning of its loop keeps doing so (intro on: the file start).
    let srcIn = !m.loop || Math.abs(m.srcIn - oldFirst) < 1e-6 ? first : m.srcIn
    if (srcIn < first || srcIn > last - MIN_CLIP_DURATION * m.speed) srcIn = first
    const duration = (last - srcIn) / m.speed
    if (duration < MIN_CLIP_DURATION) return false
    next.push({ m, loop, srcIn, duration })
  }
  for (const n of next) if (!isRangeFree(p, n.m.trackId, n.m.start, n.m.start + n.duration, ignore)) return false
  for (const n of next) {
    n.m.srcIn = n.srcIn
    n.m.duration = n.duration
    if (n.loop) n.m.loop = n.loop
    else delete n.m.loop
  }
  return true
}

export interface MoveOrigin {
  [clipId: string]: { start: number; trackId: string }
}

/**
 * Moves clips to `origin + dt`. `retarget` optionally moves one clip to another track of the same
 * kind. Returns false (and changes nothing) when the result would overlap other clips.
 */
export function moveClips(p: Project, origin: MoveOrigin, dt: number, retarget?: { clipId: string; trackId: string }): boolean {
  const ids = new Set(Object.keys(origin))
  let minStart = Infinity
  for (const id of ids) minStart = Math.min(minStart, origin[id].start)
  const d = Math.max(dt, -minStart)
  const next: { c: Clip; start: number; trackId: string }[] = []
  for (const c of p.clips) {
    if (!ids.has(c.id)) continue
    let trackId = origin[c.id].trackId
    if (retarget && retarget.clipId === c.id) {
      const t = trackById(p, retarget.trackId)
      const cur = trackById(p, trackId)
      if (t && cur && t.kind === cur.kind) trackId = t.id
    }
    next.push({ c, start: origin[c.id].start + d, trackId })
  }
  for (const n of next) {
    if (!isRangeFree(p, n.trackId, n.start, n.start + n.c.duration, ids)) return false
  }
  // Moving clips must not land on each other either.
  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const a = next[i]
      const b2 = next[j]
      if (a.trackId === b2.trackId && a.start < b2.start + b2.c.duration - EPS && a.start + a.c.duration > b2.start + EPS) return false
    }
  }
  for (const n of next) {
    n.c.start = n.start
    n.c.trackId = n.trackId
  }
  return true
}

export function deleteClips(p: Project, ids: Iterable<string>): void {
  const all = new Set(withLinked(p, ids))
  p.clips = p.clips.filter((c) => !all.has(c.id))
}

/** Removes a media item and every clip that uses it. */
export function deleteMedia(p: Project, mediaId: string): void {
  p.clips = p.clips.filter((c) => c.mediaId !== mediaId)
  p.media = p.media.filter((m) => m.id !== mediaId)
}

export function unlinkClips(p: Project, ids: Iterable<string>): void {
  const all = new Set(withLinked(p, ids))
  for (const c of p.clips) if (all.has(c.id)) delete c.linkId
}

export interface ClipboardData {
  clips: Clip[]
  /** Kind of the track each clip came from. */
  kinds: Record<string, TrackKind>
  origin: number
}

export function copyClips(p: Project, ids: Iterable<string>): ClipboardData | null {
  const all = new Set(withLinked(p, ids))
  const clips = p.clips.filter((c) => all.has(c.id)).map((c) => clone(c) as Clip)
  if (!clips.length) return null
  const kinds: Record<string, TrackKind> = {}
  for (const c of clips) kinds[c.id] = trackById(p, c.trackId)?.kind ?? (c.type === 'audio' ? 'audio' : 'video')
  return { clips, kinds, origin: Math.min(...clips.map((c) => c.start)) }
}

/** Pastes clipboard clips at `time`, on their original tracks when free, otherwise on other tracks. */
export function pasteClips(p: Project, data: ClipboardData, time: number): string[] {
  const dt = Math.max(0, time) - data.origin
  const linkMap = new Map<string, string>()
  const bySource = new Map<string, Clip[]>()
  for (const c of data.clips) {
    if (c.mediaId && !mediaById(p, c.mediaId)) continue
    if (c.subtitleTrackId && !p.subtitles.some((s) => s.id === c.subtitleTrackId)) continue
    const list = bySource.get(c.trackId) ?? []
    list.push(c)
    bySource.set(c.trackId, list)
  }
  const created: string[] = []
  const taken = new Set<string>()
  for (const [srcTrack, clips] of bySource) {
    const kind = data.kinds[clips[0].id]
    const fits = (t: Track) =>
      t.kind === kind && !taken.has(t.id) && clips.every((c) => isRangeFree(p, t.id, c.start + dt, c.start + dt + c.duration))
    const original = trackById(p, srcTrack)
    let target = original && fits(original) ? original : undefined
    if (!target) target = (kind === 'video' ? tracksOf(p, 'video').reverse() : tracksOf(p, 'audio')).find(fits)
    if (!target) target = addTrack(p, kind)
    taken.add(target.id)
    for (const c of clips) {
      const n = clone(c) as Clip
      n.id = uid('c')
      n.trackId = target.id
      n.start = c.start + dt
      n.effects = n.effects.map((e) => ({ ...e, id: uid('e') }))
      if (c.linkId) {
        if (!linkMap.has(c.linkId)) linkMap.set(c.linkId, uid('l'))
        n.linkId = linkMap.get(c.linkId)
      }
      p.clips.push(n)
      created.push(n.id)
    }
  }
  // A link with a single member is not a link.
  const counts = new Map<string, number>()
  for (const c of p.clips) if (c.linkId) counts.set(c.linkId, (counts.get(c.linkId) ?? 0) + 1)
  for (const c of p.clips) if (c.linkId && counts.get(c.linkId) === 1 && created.includes(c.id)) delete c.linkId
  return created
}

/** Clips visible/audible at `time`, visual ones ordered back to front. */
export function activeClips(p: Project, time: number): { visual: Clip[]; audio: Clip[] } {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id))
  const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id))
  const visual: Clip[] = []
  const audio: Clip[] = []
  for (const c of p.clips) {
    if (time < c.start || time >= clipEnd(c)) continue
    if (c.type === 'audio') {
      if (!muted.has(c.trackId)) audio.push(c)
    } else if (!hidden.has(c.trackId)) visual.push(c)
  }
  visual.sort((a, b2) => (order.get(b2.trackId) ?? 0) - (order.get(a.trackId) ?? 0))
  return { visual, audio }
}

/** Snap candidates: clip edges and the origin. */
export function snapPoints(p: Project, ignore?: Set<string>): number[] {
  const pts = [0]
  for (const c of p.clips) {
    if (ignore?.has(c.id)) continue
    pts.push(c.start, clipEnd(c))
  }
  return pts
}

export function snapTime(t: number, points: number[], tolerance: number): number {
  let best = t
  let bestD = tolerance
  for (const pt of points) {
    const d = Math.abs(pt - t)
    if (d < bestD) {
      bestD = d
      best = pt
    }
  }
  return best
}

export { lerp }

// Presets: a saved group of clips (with their effects, transforms, text, timing and links) that can be
// placed into any project. A preset carries a copy of the media items its clips use, so applying it in
// another project knows which files to import, and copies of the subtitle tracks its subtitle clips show.
import { EFFECT_MAP } from './effects'
import {
  type Clip, type MediaItem, type Project, type SubtitleTrack, type TrackKind, clone, defaultSubtitleStyle, makeClip,
  normalizeAnimation, uid
} from './model'
import { type ClipboardData, copyClips, pasteClips } from './timeline-ops'

export const PRESET_VERSION = 1

export interface Preset {
  id: string
  version: number
  name: string
  /** When it was saved (ms since the epoch). */
  created: number
  clips: Clip[]
  /** Kind of the track each clip came from (by clip id). */
  kinds: Record<string, TrackKind>
  /** Earliest clip start: clip times are placed relative to it. */
  origin: number
  /** Media used by the clips or by their effects (image masks, clean backgrounds). */
  media: MediaItem[]
  subtitles: SubtitleTrack[]
}

/** Media ids an effect refers to through its 'media' parameters. */
function effectMedia(c: Clip): string[] {
  const ids: string[] = []
  for (const e of c.effects) {
    for (const p of EFFECT_MAP[e.type]?.params ?? []) {
      if (p.type === 'media' && typeof e.params[p.key] === 'string' && e.params[p.key]) ids.push(e.params[p.key] as string)
    }
  }
  return ids
}

/** A preset from the given clips (and the clips linked to them). Null when none of them exist. */
export function makePreset(p: Project, ids: Iterable<string>, name: string): Preset | null {
  const data = copyClips(p, ids)
  if (!data) return null
  const mediaIds = new Set(data.clips.flatMap((c) => [...(c.mediaId ? [c.mediaId] : []), ...effectMedia(c)]))
  const subtitleIds = new Set(data.clips.map((c) => c.subtitleTrackId).filter(Boolean))
  return {
    id: uid('p'),
    version: PRESET_VERSION,
    name: name.trim() || 'Preset',
    created: Date.now(),
    clips: data.clips,
    kinds: data.kinds,
    origin: data.origin,
    // Saved without project-relative details: a preset belongs to no project.
    media: p.media.filter((m) => mediaIds.has(m.id)).map(({ relPath: _rel, fastSeek: _fs, ...m }) => clone(m)),
    subtitles: p.subtitles.filter((s) => subtitleIds.has(s.id)).map((s) => clone(s))
  }
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * Which of a preset's media the project already has (preset media id -> project media id, matched by file
 * path), and which would have to be imported first.
 */
export function matchPresetMedia(p: Project, preset: Preset): { found: Map<string, string>; needed: MediaItem[] } {
  const found = new Map<string, string>()
  const needed: MediaItem[] = []
  for (const m of preset.media) {
    const have = p.media.find((x) => samePath(x.path, m.path))
    if (have) found.set(m.id, have.id)
    else needed.push(m)
  }
  return { found, needed }
}

/**
 * Places a preset's clips at `time`. `mediaMap` maps the preset's media ids to this project's; clips whose
 * media is not in it are left out, and effects pointing at such media lose that image. Subtitle tracks are
 * added as new tracks. Returns the new clips' ids.
 */
export function applyPreset(p: Project, preset: Preset, time: number, mediaMap: Map<string, string>): string[] {
  const subtitleMap = new Map<string, string>()
  for (const s of preset.subtitles) {
    const copy = clone(s)
    copy.id = uid('s')
    copy.cues = copy.cues.map((c) => ({ ...c, id: uid('q') }))
    p.subtitles.push(copy)
    subtitleMap.set(s.id, copy.id)
  }
  const clips: Clip[] = []
  for (const c of preset.clips) {
    if (c.mediaId && !mediaMap.has(c.mediaId)) continue
    const n = clone(c)
    if (n.mediaId) n.mediaId = mediaMap.get(n.mediaId)
    if (n.subtitleTrackId) n.subtitleTrackId = subtitleMap.get(n.subtitleTrackId)
    for (const e of n.effects) {
      for (const d of EFFECT_MAP[e.type]?.params ?? []) {
        if (d.type === 'media' && typeof e.params[d.key] === 'string' && e.params[d.key]) {
          e.params[d.key] = mediaMap.get(e.params[d.key] as string) ?? ''
        }
      }
    }
    clips.push(n)
  }
  if (!clips.length) return []
  const data: ClipboardData = { clips, kinds: preset.kinds, origin: preset.origin }
  return pasteClips(p, data, time)
}

/** Reads a stored preset, filling in anything a newer or older version may lack. Null if it isn't one. */
export function parsePreset(raw: unknown): Preset | null {
  const r = raw as Partial<Preset> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Array.isArray(r.clips) || !r.clips.length) return null
  if ((r.version ?? 0) > PRESET_VERSION) return null
  return {
    id: r.id,
    version: PRESET_VERSION,
    name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Preset',
    created: Number(r.created) || 0,
    clips: r.clips.map((c) => ({
      ...makeClip({ trackId: c.trackId, type: c.type, start: c.start, duration: c.duration }),
      ...c,
      ...normalizeAnimation(c),
      effects: c.effects ?? []
    })),
    kinds: r.kinds ?? {},
    origin: Number.isFinite(r.origin) ? Number(r.origin) : Math.min(...r.clips.map((c) => c.start)),
    media: (r.media ?? []).map((m) => ({ ...m, audioStreams: m.audioStreams ?? [] })),
    subtitles: (r.subtitles ?? []).map((s) => ({ ...s, style: { ...defaultSubtitleStyle(), ...(s.style ?? {}) }, cues: s.cues ?? [] }))
  }
}

/** Length of the preset on the timeline, seconds. */
export const presetLength = (preset: Preset): number =>
  Math.max(0, ...preset.clips.map((c) => c.start + c.duration)) - preset.origin

/*
 * Copyright (C) 2026 Lorekeeper49
 *
 * This file is part of ClipWorld.
 *
 * ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
 * General Public License as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with ClipWorld. If not,
 * see <https://www.gnu.org/licenses/>.
 */

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

// ---------------------------------------------------------------- preset files (export and import)
// An exported preset is a zip holding preset.json and the media files the user chose to include, side by
// side. preset.json refers to each file by its name alone, so the preset also works once unzipped: its
// files are then looked for next to preset.json.

/** Marks a JSON file as an exported ClipWorld preset. */
export const PRESET_FILE_FORMAT = 'ClipWorld preset'
/** The preset's JSON file inside an export. */
export const PRESET_JSON = 'preset.json'

/** The contents of preset.json. */
export interface PresetJson {
  format: typeof PRESET_FILE_FORMAT
  version: number
  preset: Preset
}

/** The last part of a path, with either kind of slash. */
export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** A name that is a plain file name on every system: no folders, nothing Windows forbids. */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned)) return fallback
  return cleaned
}

/**
 * The file name each of the preset's media gets in an export (by media id): its own name, numbered when
 * two files share one, as "clip (2).mp4".
 */
export function presetFileNames(media: MediaItem[]): Map<string, string> {
  const names = new Map<string, string>()
  const taken = new Set([PRESET_JSON])
  for (const m of media) {
    const base = safeFileName(fileName(m.path), safeFileName(m.name, 'media'))
    const dot = base.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`
    taken.add(name.toLowerCase())
    names.set(m.id, name)
  }
  return names
}

/** preset.json for an export: the preset with each media file referred to by its file name only. */
export function presetJsonFor(preset: Preset, names: Map<string, string>): PresetJson {
  const copy = clone(preset)
  copy.media = copy.media.map(({ relPath: _rel, fastSeek: _fs, ...m }) => ({ ...m, path: names.get(m.id) ?? safeFileName(fileName(m.path)) }))
  return { format: PRESET_FILE_FORMAT, version: PRESET_VERSION, preset: copy }
}

const isAbsolute = (path: string) => /^([a-z]:[\\/]|[\\/])/i.test(path)

/**
 * Reads preset.json (or a preset file saved by ClipWorld itself) as a new preset. Media given by name are
 * looked for in `folder` (where preset.json is, or where an export's files were unpacked); full paths are
 * kept as they are. Null if it isn't a preset.
 */
export function readPresetFile(raw: unknown, folder: string, sep = '/'): Preset | null {
  const r = raw as Partial<PresetJson> | null
  const inner = r && typeof r === 'object' && r.format === PRESET_FILE_FORMAT ? r.preset : raw
  if (r && typeof r === 'object' && r.format === PRESET_FILE_FORMAT && (Number(r.version) || 0) > PRESET_VERSION) return null
  const preset = parsePreset(inner)
  if (!preset) return null
  const dir = folder.replace(/[\\/]+$/, '')
  preset.id = uid('p')
  preset.media = preset.media.map((m) => ({ ...m, path: isAbsolute(m.path) ? m.path : `${dir}${sep}${m.path.replace(/[\\/]/g, sep)}` }))
  return preset
}

/** Length of the preset on the timeline, seconds. */
export const presetLength = (preset: Preset): number =>
  Math.max(0, ...preset.clips.map((c) => c.start + c.duration)) - preset.origin

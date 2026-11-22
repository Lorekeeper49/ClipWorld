// The project model. Pure data — shared by the main process, the renderer and tests.

export const PROJECT_VERSION = 1
export const PROJECT_EXT = 'vcws'
/** Pixel-valued settings (font size, blur radius, shadow distance) are authored at this frame height. */
export const REF_HEIGHT = 1080
export const MIN_CLIP_DURATION = 0.04
export const MIN_SPEED = 0.05
export const MAX_SPEED = 20
export const MAX_VOLUME = 5
export const DEFAULT_STILL_DURATION = 5

export type MediaKind = 'video' | 'audio' | 'image'

export interface AudioStreamInfo {
  /** Index among the file's audio streams (ffmpeg `0:a:N`). */
  index: number
  codec: string
  channels: number
  sampleRate: number
  title: string
  language?: string
}

import type { ClipLoop } from './loop'
import { normalizeEase } from './easing'

export interface MediaItem {
  id: string
  kind: MediaKind
  name: string
  path: string
  /** Path relative to the project file, written on save so projects can be moved. */
  relPath?: string
  size: number
  mtimeMs: number
  duration: number
  width: number
  height: number
  fps: number
  /** Animated image (GIF, APNG, animated WebP). Treated like a silent video. */
  animated: boolean
  hasAlpha: boolean
  videoCodec?: string
  colorSpace?: string
  /** Longest gap between keyframes near the start of the file, seconds. Long gaps make seeking slow. */
  keyframeInterval?: number
  /** The user asked for a fast-seek preview copy of this video (Media panel button). */
  fastSeek?: boolean
  audioStreams: AudioStreamInfo[]
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
}

/** A built-in easing: 'linear' or an easings.net name such as 'easeOutBounce' (see easing.ts). */
export type EaseName = string

/** A point of a custom easing curve; handles are offsets from the point, in the graph's units. */
export interface CurvePoint {
  /** Time, 0..1. */
  x: number
  /** Progress at that time: 0 is the start value, 1 the end value (beyond them overshoots). */
  y: number
  in: [number, number]
  out: [number, number]
}

/** A custom easing curve drawn in the easing graph. Starts at (0,0) and ends at (1,1). */
export interface EaseCurve {
  points: CurvePoint[]
}

export type Ease = EaseName | EaseCurve

export interface TransformState {
  /** Offset from frame center as a fraction of frame width. */
  x: number
  /** Offset from frame center as a fraction of frame height. */
  y: number
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  opacity: number
  /** Crop: how much of each edge of the clip is hidden, as a fraction of its width or height. */
  cropLeft: number
  cropRight: number
  cropTop: number
  cropBottom: number
}

export interface TransformAnim {
  animate: boolean
  start: TransformState
  end: TransformState
  ease: Ease
}

export interface ZoomAnim {
  enabled: boolean
  start: number
  end: number
  /** Focal point inside the clip, 0..1. */
  focusX: number
  focusY: number
  ease: Ease
}

export interface TextProps {
  content: string
  fontFamily: string
  /** Pixels at REF_HEIGHT. */
  fontSize: number
  bold: boolean
  italic: boolean
  fill: string
  outline: string
  /** Pixels at REF_HEIGHT. 0 disables the outline. */
  outlineWidth: number
  align: 'left' | 'center' | 'right'
}

export type ParamValue = number | string | boolean

export interface EffectInstance {
  id: string
  type: string
  enabled: boolean
  params: Record<string, ParamValue>
}

export interface SubtitleCue {
  id: string
  /** Seconds in the subtitle track's own time. */
  start: number
  end: number
  text: string
}

export interface SubtitleStyle {
  fontFamily: string
  /** Pixels at REF_HEIGHT. */
  fontSize: number
  bold: boolean
  italic: boolean
  fill: string
  outline: string
  /** Pixels at REF_HEIGHT. 0 disables the outline. */
  outlineWidth: number
  /** Draw a box behind the text. */
  box: boolean
  boxColor: string
  boxOpacity: number
  position: 'bottom' | 'middle' | 'top'
  /** Distance from the top/bottom edge as a fraction of the frame height. */
  margin: number
  align: 'left' | 'center' | 'right'
  /** Lines wrap at this fraction of the frame width. */
  maxWidth: number
}

export interface SubtitleTrack {
  id: string
  name: string
  /** ISO 639-2 code, e.g. 'eng'. */
  language: string
  style: SubtitleStyle
  /** Kept sorted by start time. */
  cues: SubtitleCue[]
}

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'subtitles'

export interface Clip {
  id: string
  trackId: string
  type: ClipType
  name: string
  mediaId?: string
  /** For audio clips: which audio stream of the media file. */
  audioStream: number
  /** Timeline position and length, seconds. */
  start: number
  duration: number
  /** Source in-point, seconds. */
  srcIn: number
  /** Source seconds consumed per timeline second. */
  speed: number
  preservePitch: boolean
  /** Clips sharing a linkId move, split, stretch and delete together. */
  linkId?: string
  /** Audio clips: 0..MAX_VOLUME, 1 = 100%. */
  volume: number
  muted: boolean
  transform: TransformAnim
  zoom: ZoomAnim
  text?: TextProps
  /** Subtitle clips: the subtitle track shown. srcIn/speed map clip time to the track's time. */
  subtitleTrackId?: string
  effects: EffectInstance[]
  /** Video and audio clips: plays part of the file repeatedly. srcIn is then on the loop's virtual axis (see loop.ts). */
  loop?: ClipLoop
  /**
   * Video and audio clips: plays backwards (shown to the user as a negative speed). The clip covers the same
   * part of the file, srcIn to srcIn + duration * speed, but plays it from the end to the start.
   */
  reverse?: boolean
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  hidden: boolean
}

export interface Project {
  app: 'ClipWorld'
  version: number
  settings: ProjectSettings
  media: MediaItem[]
  /** Display order, top to bottom: video tracks (first = front-most), then audio tracks. */
  tracks: Track[]
  clips: Clip[]
  subtitles: SubtitleTrack[]
}

let uidCounter = 0
export function uid(prefix = ''): string {
  uidCounter = (uidCounter + 1) % 1679616
  return (
    prefix +
    Date.now().toString(36) +
    uidCounter.toString(36).padStart(4, '0') +
    Math.floor(Math.random() * 1679616)
      .toString(36)
      .padStart(4, '0')
  )
}

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T

export function defaultTransformState(): TransformState {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 }
}

export function defaultTransform(): TransformAnim {
  return { animate: false, start: defaultTransformState(), end: defaultTransformState(), ease: 'easeInOutQuad' }
}

export function defaultZoom(): ZoomAnim {
  return { enabled: false, start: 1, end: 1.5, focusX: 0.5, focusY: 0.5, ease: 'easeInOutQuad' }
}

export function defaultText(): TextProps {
  return {
    content: 'Your text',
    fontFamily: 'Segoe UI',
    fontSize: 96,
    bold: true,
    italic: false,
    fill: '#ffffff',
    outline: '#000000',
    outlineWidth: 6,
    align: 'center'
  }
}

export function makeTrack(kind: TrackKind, n: number): Track {
  return { id: uid('t'), kind, name: (kind === 'video' ? 'V' : 'A') + n, muted: false, hidden: false }
}

export function newProject(): Project {
  return {
    app: 'ClipWorld',
    version: PROJECT_VERSION,
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [makeTrack('video', 1), makeTrack('audio', 1)],
    clips: [],
    subtitles: []
  }
}

export function defaultSubtitleStyle(): SubtitleStyle {
  return {
    fontFamily: 'Segoe UI',
    fontSize: 54,
    bold: true,
    italic: false,
    fill: '#ffffff',
    outline: '#000000',
    outlineWidth: 4,
    box: false,
    boxColor: '#000000',
    boxOpacity: 0.6,
    position: 'bottom',
    margin: 0.07,
    align: 'center',
    maxWidth: 0.85
  }
}

export function makeSubtitleTrack(name: string, language = 'eng'): SubtitleTrack {
  return { id: uid('s'), name, language, style: defaultSubtitleStyle(), cues: [] }
}

export function makeClip(partial: Partial<Clip> & Pick<Clip, 'trackId' | 'type' | 'start' | 'duration'>): Clip {
  return {
    id: uid('c'),
    name: '',
    audioStream: 0,
    srcIn: 0,
    speed: 1,
    preservePitch: true,
    volume: 1,
    muted: false,
    transform: defaultTransform(),
    zoom: defaultZoom(),
    effects: [],
    ...partial
  }
}

export const isVisual = (c: Clip): boolean => c.type !== 'audio'
/** Whether a clip can play backwards: video and audio clips of a file with a known length. */
export const reversible = (c: Clip, media?: MediaItem): boolean => !!media && (c.type === 'video' || c.type === 'audio') && media.duration > 0
/** Speed as the user sees it: negative when the clip plays backwards. */
export const signedSpeed = (c: Clip): number => (c.reverse ? -c.speed : c.speed)
export const clipEnd = (c: Clip): number => c.start + c.duration
/** Whether the clip plays a time-based source (and therefore has a meaningful speed). */
export const isTimed = (c: Clip, media?: MediaItem): boolean =>
  c.type === 'audio' || c.type === 'subtitles' || (c.type === 'video' && !!media) || (c.type === 'image' && !!media?.animated)

export function projectDuration(p: Project): number {
  let d = 0
  for (const c of p.clips) d = Math.max(d, clipEnd(c))
  return d
}

/** Size of a media layer when fitted (contain) into the project frame, in project pixels. */
export function fitSize(mw: number, mh: number, W: number, H: number): { w: number; h: number } {
  if (!mw || !mh) return { w: W, h: H }
  const s = Math.min(W / mw, H / mh)
  return { w: Math.max(2, Math.round(mw * s)), h: Math.max(2, Math.round(mh * s)) }
}

/**
 * A clip's transform and zoom with everything filled in: crop for files saved before it existed, and
 * easing names from before the easings.net set mapped to their new names.
 */
export function normalizeAnimation(c: Partial<Clip>): Pick<Clip, 'transform' | 'zoom'> {
  const t = { ...defaultTransform(), ...(c.transform ?? {}) }
  const z = { ...defaultZoom(), ...(c.zoom ?? {}) }
  return {
    transform: {
      ...t,
      start: { ...defaultTransformState(), ...t.start },
      end: { ...defaultTransformState(), ...t.end },
      ease: normalizeEase(t.ease)
    },
    zoom: { ...z, ease: normalizeEase(z.ease) }
  }
}

/** Validates and upgrades a parsed .vcws file. Throws on anything that is not a ClipWorld project. */
export function parseProject(raw: unknown): Project {
  const p = raw as Partial<Project> | null
  if (!p || typeof p !== 'object' || p.app !== 'ClipWorld' || !Array.isArray(p.tracks) || !Array.isArray(p.clips)) {
    throw new Error('Not a ClipWorld project file')
  }
  if ((p.version ?? 0) > PROJECT_VERSION) {
    throw new Error('This project was saved by a newer version of ClipWorld')
  }
  const base = newProject()
  const project: Project = {
    app: 'ClipWorld',
    version: PROJECT_VERSION,
    settings: { ...base.settings, ...(p.settings ?? {}) },
    media: (p.media ?? []).map((m) => ({ ...m, audioStreams: m.audioStreams ?? [] })),
    tracks: p.tracks.map((t) => ({ ...t, muted: !!t.muted, hidden: !!t.hidden })),
    clips: [],
    // Projects saved before subtitles existed have none.
    subtitles: (p.subtitles ?? []).map((s) => ({
      ...s,
      style: { ...defaultSubtitleStyle(), ...(s.style ?? {}) },
      cues: [...(s.cues ?? [])].sort((a, b) => a.start - b.start)
    }))
  }
  const trackIds = new Set(project.tracks.map((t) => t.id))
  const subtitleIds = new Set(project.subtitles.map((s) => s.id))
  for (const c of p.clips) {
    if (!trackIds.has(c.trackId)) continue
    if (c.type === 'subtitles' && !subtitleIds.has(c.subtitleTrackId ?? '')) continue
    project.clips.push({
      ...makeClip({ trackId: c.trackId, type: c.type, start: c.start, duration: c.duration }),
      ...c,
      ...normalizeAnimation(c),
      effects: c.effects ?? []
    })
  }
  return project
}

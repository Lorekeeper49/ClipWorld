// User-facing commands. Menus, toolbar buttons and keyboard shortcuts all call these.
import { layerInfo, overlayEffects } from '@shared/filtergraph'
import { CONTAINER_MAP, type ExportSettings } from '@shared/formats'
import type { ExportRequest, ExportResult, RasterAsset } from '@shared/ipc'
import {
  type MediaItem, type Project, type SubtitleCue, type SubtitleTrack, type TextProps, clipEnd, makeSubtitleTrack, newProject,
  projectDuration, uid
} from '@shared/model'
import {
  SUBTITLE_FORMATS, clipCues, clipTrackTime, cueAt, isSubtitleFile, sortCues, timelineCues, writeSubtitles
} from '@shared/subtitles'
import {
  addSubtitleClip, addTextClip, copyClips, deleteClips, deleteMedia as opDeleteMedia, deleteSubtitleTrack, pasteClips,
  placeMedia, splitAt, trimClip, unlinkClips, withLinked
} from '@shared/timeline-ops'
import { checkPlayable, player } from '../engine/player'
import { canvasToPng, measureText, rasterOverlay, rasterSubtitle, rasterText } from '../engine/raster'
import { edit, get, loadProject, patchSettings, projectName, redo, set, toast, undo, useStore } from './store'

// ---------------------------------------------------------------- project lifecycle

/** Runs `then` immediately, or after the user has dealt with unsaved changes. */
export function guardUnsaved(then: () => void): void {
  if (!get().dirty) then()
  else set({ modal: 'close', pendingAfterClose: then })
}

function adopt(project: Project, path: string | null, dirty = false): void {
  player.pause()
  loadProject(project, path, dirty)
  player.seek(0)
  if (project.media.length) void window.cw.prepareMedia(project.media)
}

export function newProjectAction(): void {
  guardUnsaved(() => adopt(newProject(), null))
}

export async function openProjectPath(path?: string): Promise<void> {
  try {
    const opened = await window.cw.openProject(path)
    if (!opened) return
    adopt(opened.project, opened.path)
    patchSettings({ recent: [opened.path, ...get().settings.recent.filter((r) => r !== opened.path)].slice(0, 10) })
  } catch (err) {
    toast(`Could not open project: ${(err as Error).message}`, 'error')
  }
}

export function openProjectAction(path?: string): void {
  guardUnsaved(() => void openProjectPath(path))
}

export async function saveProjectAction(saveAs = false): Promise<boolean> {
  const s = get()
  try {
    const path = await window.cw.saveProject(saveAs ? null : s.projectPath, s.project)
    if (!path) return false
    // Only clear the dirty flag if nothing changed while the file was being written.
    set((cur) => ({ projectPath: path, dirty: cur.project !== s.project }))
    patchSettings({ recent: [path, ...get().settings.recent.filter((r) => r !== path)].slice(0, 10) })
    void window.cw.writeRecovery(null)
    toast('Project saved')
    return true
  } catch (err) {
    toast(`Could not save: ${(err as Error).message}`, 'error')
    return false
  }
}

// ---------------------------------------------------------------- media

export async function importPaths(all: string[]): Promise<MediaItem[]> {
  // Subtitle files become subtitle tracks rather than media.
  const subtitleFiles = all.filter(isSubtitleFile)
  if (subtitleFiles.length) await importSubtitleFilesAction(subtitleFiles)
  const paths = all.filter((p) => !isSubtitleFile(p))
  if (!paths.length) return []
  if (!get().ffmpegVersion) {
    toast('ffmpeg was not found, so media cannot be imported.', 'error')
    return []
  }
  const existing = new Set(get().project.media.map((m) => m.path.toLowerCase()))
  const fresh = paths.filter((p) => !existing.has(p.toLowerCase()))
  if (!fresh.length) {
    toast('Already imported')
    return []
  }
  const { items, errors } = await window.cw.importMedia(fresh)
  if (items.length) {
    edit((p) => {
      p.media.push(...items)
    })
    set({ selectedMediaId: items[items.length - 1].id })
  }
  for (const e of errors) toast(e, 'error')
  return items
}

export async function importMediaAction(): Promise<void> {
  const paths = await window.cw.pickMedia()
  await importPaths(paths)
}

/** Adds media to the timeline at `time` (default: the playhead). `audioStream` places only that track. */
export function addToTimeline(mediaId: string, time?: number, trackId?: string, audioStream?: number): void {
  const m = get().project.media.find((x) => x.id === mediaId)
  if (!m) return
  let created: string[] = []
  edit((p) => {
    const media = p.media.find((x) => x.id === mediaId)!
    if (audioStream !== undefined) {
      const only: MediaItem = { ...media, kind: 'audio', audioStreams: media.audioStreams.filter((a) => a.index === audioStream) }
      created = placeMedia(p, only, time ?? player.time, trackId)
      for (const c of p.clips) {
        if (created.includes(c.id)) {
          c.audioStream = audioStream
          c.name = only.audioStreams[0]?.title ?? media.name
        }
      }
    } else {
      created = placeMedia(p, media, time ?? player.time, trackId)
    }
  })
  set({ selection: created })
}

export function deleteMediaAction(mediaId: string): void {
  const s = get()
  const m = s.project.media.find((x) => x.id === mediaId)
  if (!m) return
  const used = s.project.clips.filter((c) => c.mediaId === mediaId).length
  edit((p) => opDeleteMedia(p, mediaId))
  set((cur) => ({
    selectedMediaId: cur.selectedMediaId === mediaId ? null : cur.selectedMediaId,
    selection: cur.selection.filter((id) => cur.project.clips.some((c) => c.id === id))
  }))
  toast(used ? `Removed ${m.name} and ${used} clip${used === 1 ? '' : 's'} from the timeline` : `Removed ${m.name}`)
}

export async function relinkMediaAction(mediaId: string): Promise<void> {
  const m = get().project.media.find((x) => x.id === mediaId)
  if (!m) return
  try {
    const fresh = await window.cw.relinkMedia(m)
    if (!fresh) return
    set((s) => {
      const playable = { ...s.playable }
      delete playable[mediaId]
      return { playable }
    })
    edit((p) => {
      const i = p.media.findIndex((x) => x.id === mediaId)
      if (i >= 0) p.media[i] = fresh
    })
  } catch (err) {
    toast(`Could not relink: ${(err as Error).message}`, 'error')
  }
}

/**
 * Writes an MP4 copy of a video next to the original and switches the project over to it. Clips keep
 * their positions and edits; the original file is left untouched.
 */
export async function convertToMp4Action(mediaId: string): Promise<void> {
  const m = get().project.media.find((x) => x.id === mediaId)
  if (!m) return
  const r = await window.cw.convertToMp4(mediaId)
  if (!r.ok) {
    if (!r.cancelled) toast(`Could not convert ${m.name}: ${r.error.split('\n')[0]}`, 'error')
    return
  }
  if (!get().project.media.some((x) => x.id === mediaId)) return // deleted while converting
  set((s) => {
    const mediaCache = { ...s.mediaCache }
    const playable = { ...s.playable }
    delete mediaCache[mediaId]
    delete playable[mediaId]
    return { mediaCache, playable }
  })
  // Keep the user's fast-seek choice; when every stream was copied its finished chunks carry over.
  const item = { ...r.item, fastSeek: m.fastSeek }
  edit((p) => {
    const i = p.media.findIndex((x) => x.id === mediaId)
    if (i >= 0) p.media[i] = item
  })
  void window.cw.prepareMedia([item])
  const name = r.path.split(/[\\/]/).pop()
  toast(`Converted to ${name}${r.copied ? ' without re-encoding' : ''}. The original file was not changed.`)
}

/** Turns the optional fast-seek preview copy of a video on or off; the choice is saved in the project. */
export function setFastSeekAction(mediaId: string, on: boolean): void {
  edit((p) => {
    const m = p.media.find((x) => x.id === mediaId)
    if (m) m.fastSeek = on
  })
}

/**
 * Receives cache updates from the main process, and keeps the main process's fast-seek work in step
 * with the project (so undo/redo of the toggle starts or stops it too).
 */
export function initMediaCacheListener(): () => void {
  const sentFastSeek = new Map<string, boolean>()
  let lastMedia = get().project.media
  let lastEpoch = get().projectEpoch
  const unsubStore = useStore.subscribe((s) => {
    if (s.project.media === lastMedia) return
    // A different project was loaded: its media is prepared (and fast seek resumed) on load.
    const reloaded = s.projectEpoch !== lastEpoch
    lastMedia = s.project.media
    lastEpoch = s.projectEpoch
    if (reloaded) sentFastSeek.clear()
    for (const m of s.project.media) {
      if (m.kind !== 'video') continue
      const want = !!m.fastSeek
      if (reloaded) sentFastSeek.set(m.id, want)
      else if ((sentFastSeek.get(m.id) ?? false) !== want) {
        sentFastSeek.set(m.id, want)
        void window.cw.setFastSeek(m.id, want)
      }
    }
  })
  const unsubCache = window.cw.onMediaCache((id, patch) => {
    const s = get()
    const media = s.project.media.find((m) => m.id === id)
    const cur = s.mediaCache[id] ?? { sourceUrl: '', audioUrls: {}, peakUrls: {} }
    const next = {
      ...cur,
      ...patch,
      audioUrls: { ...cur.audioUrls, ...(patch.audioUrls ?? {}) },
      peakUrls: { ...cur.peakUrls, ...(patch.peakUrls ?? {}) }
    }
    set({ mediaCache: { ...s.mediaCache, [id]: next } })
    if (media?.kind === 'video' && next.sourceUrl && !next.missing && !s.playable[id]) checkPlayable(id, next.sourceUrl)
  })
  return () => {
    unsubStore()
    unsubCache()
  }
}

// ---------------------------------------------------------------- editing

export function splitAction(): void {
  const s = get()
  const t = player.time
  let created: string[] = []
  // With a selection under the playhead, split just that; otherwise split everything under it.
  const sel = withLinked(s.project, s.selection)
  const under = sel.filter((id) => {
    const c = s.project.clips.find((x) => x.id === id)
    return c && t > c.start && t < clipEnd(c)
  })
  const ok = edit((p) => {
    created = splitAt(p, t, under.length ? under : undefined)
  })
  if (!ok) toast('Nothing to split at the playhead')
  else if (under.length) set({ selection: created })
}

export function copyAction(): boolean {
  const s = get()
  const data = copyClips(s.project, s.selection)
  if (!data) return false
  set({ clipboard: data })
  return true
}

export function cutAction(): void {
  if (copyAction()) deleteSelectionAction()
}

export function pasteAction(): void {
  const data = get().clipboard
  if (!data) return
  let created: string[] = []
  edit((p) => {
    created = pasteClips(p, data, player.time)
  })
  if (created.length) set({ selection: created })
}

export function duplicateAction(): void {
  const s = get()
  const data = copyClips(s.project, s.selection)
  if (!data) return
  const end = Math.max(...data.clips.map((c) => clipEnd(c)))
  let created: string[] = []
  edit((p) => {
    created = pasteClips(p, data, end)
  })
  set({ selection: created })
}

export function deleteSelectionAction(): void {
  const s = get()
  if (s.selection.length) {
    edit((p) => deleteClips(p, s.selection))
    set({ selection: [] })
  } else if (s.selectedMediaId && document.activeElement?.closest('[data-panel="media"]')) {
    deleteMediaAction(s.selectedMediaId)
  }
}

export function selectAllAction(): void {
  set({ selection: get().project.clips.map((c) => c.id) })
}

export function unlinkAction(): void {
  const s = get()
  if (s.selection.length) edit((p) => unlinkClips(p, s.selection))
}

export function addTextAction(text?: Partial<TextProps>): void {
  let id = ''
  edit((p) => {
    id = addTextClip(p, player.time, { fontFamily: preferredFont(), ...text })
  })
  set({ selection: [id] })
}

/** Common sans-serif fonts, in order of preference: Windows, then typical Linux and macOS installs. */
const DEFAULT_FONTS = ['Segoe UI', 'Noto Sans', 'Ubuntu', 'Cantarell', 'DejaVu Sans', 'Liberation Sans', 'Helvetica Neue', 'Arial']

/** Font for new text and subtitles: the first common one this computer has installed. */
export function preferredFont(): string {
  const installed = new Set(get().fonts)
  return DEFAULT_FONTS.find((f) => installed.has(f)) ?? get().fonts[0] ?? 'Segoe UI'
}

// ---------------------------------------------------------------- subtitles

const activeTrack = (): SubtitleTrack | undefined => {
  const s = get()
  return s.project.subtitles.find((t) => t.id === s.activeSubtitleTrack) ?? s.project.subtitles[0]
}

/** Track time under the playhead: through the track's clip when it is on the timeline, else timeline time. */
export function trackTimeAt(p: Project, track: SubtitleTrack, t: number): number {
  const clips = p.clips.filter((c) => c.subtitleTrackId === track.id)
  if (!clips.length) return t
  const under = clips.find((c) => t >= c.start && t < clipEnd(c))
  const nearest = under ?? clips.reduce((a, b) => (Math.abs(b.start - t) < Math.abs(a.start - t) ? b : a))
  return clipTrackTime(nearest, t)
}

/** Timeline time where a track time appears (inverse of trackTimeAt), for seeking to a cue. */
export function timelineTimeOf(p: Project, track: SubtitleTrack, trackTime: number): number {
  const clips = p.clips.filter((c) => c.subtitleTrackId === track.id)
  if (!clips.length) return trackTime
  const covering = clips.find((c) => trackTime >= c.srcIn && trackTime < c.srcIn + c.duration * c.speed)
  const c = covering ?? clips[0]
  return c.start + (trackTime - c.srcIn) / c.speed
}

export function newSubtitleTrackAction(name?: string): string {
  const n = get().project.subtitles.length + 1
  const track = makeSubtitleTrack(name ?? (n === 1 ? 'Subtitles' : `Subtitles ${n}`))
  track.style.fontFamily = preferredFont()
  edit((p) => {
    p.subtitles.push(track)
  })
  set({ activeSubtitleTrack: track.id })
  return track.id
}

export function deleteSubtitleTrackAction(trackId: string): void {
  const track = get().project.subtitles.find((t) => t.id === trackId)
  if (!track) return
  edit((p) => deleteSubtitleTrack(p, trackId))
  set((s) => ({ activeSubtitleTrack: s.project.subtitles[0]?.id ?? null, activeCueId: null }))
  toast(`Deleted subtitle track “${track.name}”`)
}

/** Edits a subtitle track; rapid edits to the same field merge into one undo step. */
export function editSubtitleTrack(trackId: string, key: string, fn: (t: SubtitleTrack) => void): void {
  edit((p) => {
    const t = p.subtitles.find((x) => x.id === trackId)
    if (t) fn(t)
  }, { key: `sub:${trackId}:${key}` })
}

/** Changes one cue, keeping the list sorted and start < end. */
export function updateCueAction(trackId: string, cueId: string, patch: Partial<SubtitleCue>): void {
  editSubtitleTrack(trackId, `${cueId}:${Object.keys(patch).join(',')}`, (t) => {
    const c = t.cues.find((x) => x.id === cueId)
    if (!c) return
    Object.assign(c, patch)
    if (c.end < c.start + MIN_CUE) {
      if (patch.start !== undefined) c.end = c.start + MIN_CUE
      else c.start = Math.max(0, c.end - MIN_CUE)
    }
    c.start = Math.max(0, c.start)
    sortCues(t.cues)
  })
  extendClipsToCues(trackId)
}

const MIN_CUE = 0.1

/**
 * When a track is on the timeline as a single clip and a cue falls outside it, grows the clip so the
 * cue shows (if there is room on its timeline track).
 */
function extendClipsToCues(trackId: string): void {
  const p = get().project
  const track = p.subtitles.find((t) => t.id === trackId)
  const clips = p.clips.filter((c) => c.subtitleTrackId === trackId)
  if (!track || clips.length !== 1 || !track.cues.length) return
  const c = clips[0]
  const first = Math.min(...track.cues.map((q) => q.start))
  const last = Math.max(...track.cues.map((q) => q.end))
  const startAt = c.start + (first - c.srcIn) / c.speed
  const endAt = c.start + (last - c.srcIn) / c.speed
  if (startAt >= c.start - 1e-6 && endAt <= clipEnd(c) + 1e-6) return
  edit((d) => {
    if (endAt > clipEnd(c)) trimClip(d, c.id, 'end', endAt)
    if (startAt < c.start) trimClip(d, c.id, 'start', Math.max(0, startAt))
  }, { key: `sub:${trackId}:extend` })
}

export function deleteCueAction(trackId: string, cueId: string): void {
  edit((p) => {
    const t = p.subtitles.find((x) => x.id === trackId)
    if (t) t.cues = t.cues.filter((c) => c.id !== cueId)
  })
  if (get().activeCueId === cueId) set({ activeCueId: null })
}

/** Adds a subtitle at the playhead: 2 s long, or up to the next one. Creates a track if there is none. */
export function addCueAction(): string | null {
  const trackId = activeTrack()?.id ?? newSubtitleTrackAction()
  const p = get().project
  const track = p.subtitles.find((t) => t.id === trackId)!
  const start = Math.max(0, trackTimeAt(p, track, player.time))
  const next = track.cues.find((c) => c.start > start + 1e-6)
  const end = Math.max(start + MIN_CUE * 5, Math.min(start + 2, next ? next.start : Infinity))
  const cue: SubtitleCue = { id: uid('q'), start, end, text: '' }
  edit((d) => {
    const t = d.subtitles.find((x) => x.id === trackId)!
    t.cues.push(cue)
    sortCues(t.cues)
  })
  extendClipsToCues(trackId)
  set({ activeSubtitleTrack: trackId, activeCueId: cue.id, focusCue: cue.id })
  return cue.id
}

/** Sets the start or end of the selected subtitle (or the one under the playhead) to the playhead. */
export function setCueEdgeAction(edge: 'start' | 'end'): void {
  const track = activeTrack()
  if (!track) return
  const p = get().project
  const t = trackTimeAt(p, track, player.time)
  const cue = track.cues.find((c) => c.id === get().activeCueId) ?? cueAt(track, t)
  if (!cue) {
    toast('Select a subtitle first')
    return
  }
  updateCueAction(track.id, cue.id, edge === 'start' ? { start: t } : { end: t })
}

export function addSubtitlesToTimelineAction(trackId: string): void {
  const track = get().project.subtitles.find((t) => t.id === trackId)
  if (!track?.cues.length) {
    toast('Add some subtitles to this track first')
    return
  }
  let id: string | null = null
  edit((p) => {
    id = addSubtitleClip(p, trackId)
  })
  if (id) set({ selection: [id] })
}

function addImportedTrack(name: string, language: string, cues: SubtitleCue[]): void {
  const track = makeSubtitleTrack(name, language)
  track.style.fontFamily = preferredFont()
  track.cues = cues
  sortCues(track.cues)
  edit((p) => {
    p.subtitles.push(track)
  })
  set({ activeSubtitleTrack: track.id, activeCueId: null })
  toast(`Imported ${cues.length} subtitle${cues.length === 1 ? '' : 's'} into “${name}”`)
}

export async function importSubtitleFilesAction(paths?: string[]): Promise<void> {
  const files = paths ?? (await window.cw.pickSubtitleFiles())
  const fps = get().project.settings.fps
  for (const f of files) {
    try {
      const r = await window.cw.readSubtitleFile(f, fps)
      addImportedTrack(r.name, r.language, r.cues)
    } catch (err) {
      toast(`Could not import ${f.split(/[\\/]/).pop()}: ${(err as Error).message.split('\n')[0]}`, 'error')
    }
  }
}

export async function importSubtitleStreamAction(mediaId: string, index: number, label: string, language: string): Promise<void> {
  const m = get().project.media.find((x) => x.id === mediaId)
  if (!m) return
  try {
    const cues = await window.cw.extractSubtitleStream(m.path, index)
    addImportedTrack(label, language, cues)
  } catch (err) {
    toast(`Could not import subtitles from ${m.name}: ${(err as Error).message.split('\n')[0]}`, 'error')
  }
}

export async function exportSubtitlesAction(trackId: string, format: string, timing: 'timeline' | 'original'): Promise<void> {
  const s = get()
  const track = s.project.subtitles.find((t) => t.id === trackId)
  const def = SUBTITLE_FORMATS.find((f) => f.id === format)
  if (!track || !def) return
  const cues = (timing === 'timeline' ? timelineCues(s.project.clips, track) : track.cues).filter((c) => c.text.trim())
  if (!cues.length) {
    toast('There are no subtitles with text to export', 'error')
    return
  }
  const { width, height, fps } = s.project.settings
  const content = writeSubtitles(format, track, cues, { fps, width, height, title: track.name })
  const base = `${projectName(s)} - ${track.name}`.replace(/[\\/:*?"<>|]/g, '_')
  const path = await window.cw.saveSubtitleFile(base, def.ext, def.label.split(' (')[0], content)
  if (path) toast(`Saved ${cues.length} subtitles to ${path.split(/[\\/]/).pop()}`)
}

export function zoomTimeline(factor: number): void {
  set((s) => ({ pps: Math.min(800, Math.max(2, s.pps * factor)) }))
}

// ---------------------------------------------------------------- export

type BuiltAssets = Pick<ExportRequest, 'text' | 'overlays' | 'subtitleImages' | 'subtitleClips'>

/** Largest raster scale for subtitle frames (2 = 4K images for a 1080p project). */
const SUBTITLE_MAX_K = 2

/** Rasterises text clips, subtitle cues and overlay effects exactly as the preview draws them. */
async function buildAssets(project: Project): Promise<BuiltAssets> {
  const text: RasterAsset[] = []
  const overlays: RasterAsset[] = []
  const subtitleImages: BuiltAssets['subtitleImages'] = []
  const subtitleClips: BuiltAssets['subtitleClips'] = []
  const imageIds = new Set<string>()
  const st = project.settings
  for (const c of project.clips) {
    if (c.type === 'audio') continue
    let size: { w: number; h: number; k: number } | undefined
    if (c.type === 'subtitles') {
      const track = project.subtitles.find((t) => t.id === c.subtitleTrackId)
      if (!track) continue
      const info = layerInfo(c, undefined, st, { w: st.width, h: st.height, k: SUBTITLE_MAX_K })
      const k = info?.q ?? 1
      size = { w: st.width, h: st.height, k }
      const gap = `gap:${k}`
      if (!imageIds.has(gap)) {
        imageIds.add(gap)
        subtitleImages.push({ id: gap, png: await canvasToPng(rasterSubtitle('', track.style, st.width, st.height, k)) })
      }
      const cues: BuiltAssets['subtitleClips'][number]['cues'] = []
      for (const placed of clipCues(c, track)) {
        const id = `${track.id}:${placed.cue.id}:${k}`
        if (!imageIds.has(id)) {
          imageIds.add(id)
          subtitleImages.push({ id, png: await canvasToPng(rasterSubtitle(placed.cue.text, track.style, st.width, st.height, k)) })
        }
        cues.push({ image: id, start: placed.start - c.start, end: placed.end - c.start })
      }
      subtitleClips.push({ clipId: c.id, w: st.width, h: st.height, k, duration: c.duration, gap, cues })
    }
    if (c.type === 'text') {
      if (!c.text) continue
      const m = measureText(c.text, st.height)
      const info = layerInfo(c, undefined, st, { w: m.w, h: m.h, k: 4 })
      const k = Math.max(1, Math.min(info?.q ?? 1, 8192 / Math.max(m.w, m.h)))
      const r = rasterText(c.text, st.height, k)
      size = { w: r.w, h: r.h, k }
      text.push({ id: c.id, png: await canvasToPng(r.canvas), w: r.w, h: r.h, k })
    }
    const ids = overlayEffects(c)
    if (!ids.length) continue
    const media = project.media.find((m) => m.id === c.mediaId)
    const info = layerInfo(c, media, st, size)
    if (!info) continue
    for (const e of c.effects) {
      if (!ids.includes(e.id)) continue
      overlays.push({ id: e.id, png: await canvasToPng(rasterOverlay(e, info.bw, info.bh)), w: info.bw, h: info.bh, k: 1 })
    }
  }
  return { text, overlays, subtitleImages, subtitleClips }
}

export async function runExportAction(settings: ExportSettings): Promise<ExportResult | null> {
  const s = get()
  if (projectDuration(s.project) <= 0) {
    toast('The timeline is empty', 'error')
    return null
  }
  const container = CONTAINER_MAP[settings.container]
  const outPath = await window.cw.pickExportPath(projectName(s), container.ext, container.label)
  if (!outPath) return null
  player.pause()
  patchSettings({ exportSettings: settings })
  const assets = await buildAssets(s.project)
  return window.cw.startExport({ project: s.project, settings, outPath, ...assets })
}

export { undo, redo }

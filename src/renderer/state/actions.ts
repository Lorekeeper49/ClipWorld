// User-facing commands. Menus, toolbar buttons and keyboard shortcuts all call these.
import { overlayEffects } from '@shared/filtergraph'
import { layerInfo } from '@shared/filtergraph'
import { CONTAINER_MAP, type ExportSettings } from '@shared/formats'
import type { ExportResult, RasterAsset } from '@shared/ipc'
import { type MediaItem, type Project, type TextProps, clipEnd, newProject, projectDuration } from '@shared/model'
import {
  addTextClip, copyClips, deleteClips, deleteMedia as opDeleteMedia, pasteClips, placeMedia, splitAt, unlinkClips,
  withLinked
} from '@shared/timeline-ops'
import { checkPlayable, player } from '../engine/player'
import { canvasToPng, measureText, rasterOverlay, rasterText } from '../engine/raster'
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

export async function importPaths(paths: string[]): Promise<MediaItem[]> {
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
    id = addTextClip(p, player.time, text)
  })
  set({ selection: [id] })
}

export function zoomTimeline(factor: number): void {
  set((s) => ({ pps: Math.min(800, Math.max(2, s.pps * factor)) }))
}

// ---------------------------------------------------------------- export

/** Rasterises text clips and overlay effects exactly as the preview draws them. */
async function buildAssets(project: Project): Promise<{ text: RasterAsset[]; overlays: RasterAsset[] }> {
  const text: RasterAsset[] = []
  const overlays: RasterAsset[] = []
  const st = project.settings
  for (const c of project.clips) {
    if (c.type === 'audio') continue
    let size: { w: number; h: number; k: number } | undefined
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
  return { text, overlays }
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

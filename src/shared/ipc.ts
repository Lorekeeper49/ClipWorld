// The contract between the renderer and the main process.
import type { Caps } from './filtergraph'
import type { ExportSettings } from './formats'
import type { MediaItem, Project, SubtitleCue } from './model'
import type { Preset } from './presets'

/** Waveform peak resolution of the cached peak files (one unsigned byte per window). */
export const PEAKS_PER_SECOND = 50

export interface Filmstrip {
  url: string
  count: number
  tileW: number
  tileH: number
}

/**
 * A fast-seeking preview copy of a video, built in fixed-length chunks so the part being edited is
 * ready first and finished work survives a restart. Chunk k covers source time [k*seconds, (k+1)*seconds).
 */
export interface ProxyChunks {
  seconds: number
  count: number
  /** URL of chunk k is `${prefix}${chunkName(k)}`. */
  prefix: string
  done: number[]
  /** The original cannot be decoded by the preview, so only finished chunks can be shown. */
  required: boolean
  failed?: boolean
}

export const chunkName = (k: number): string => `${String(k).padStart(5, '0')}.mp4`

/** What the main process has prepared for a media item so the renderer can preview it. */
export interface MediaCache {
  /** Original file, served over the media protocol. */
  sourceUrl: string
  /** Chunked fast-seek preview copy (long-keyframe, very large or undecodable video). */
  chunks?: ProxyChunks
  /** Proxy for animated images (GIF etc.), with alpha. */
  proxyUrl?: string
  proxyState?: 'pending' | 'ready' | 'error'
  proxyProgress?: number
  /** Progress of a running conversion to MP4, 0..1; absent when not converting. */
  convertProgress?: number
  /** Progress of the single pass that extracts every audio track, 0..1. */
  audioProgress?: number
  /** Extracted audio, by audio stream index. */
  audioUrls: Record<number, string>
  /** Waveform peak files, by audio stream index. */
  peakUrls: Record<number, string>
  posterUrl?: string
  filmstrip?: Filmstrip
  missing?: boolean
  error?: string
}

export interface AppSettings {
  /** Shortcut overrides: action id -> accelerator ("Ctrl+K"). */
  shortcuts: Record<string, string>
  layout?: unknown
  previewVolume: number
  recent: string[]
  ffmpegDir?: string
  exportSettings?: ExportSettings
  lastExportDir?: string
  /** The Subtitles window was added to a layout saved before it existed (done once, so closing it sticks). */
  subtitlesPanelAdded?: boolean
  /** Interface language code ("ja"), or "system" / unset to follow the operating system. */
  language?: string
  /** Import a preset's missing media without asking. */
  autoImportPresetMedia?: boolean
}

export interface AppInfo {
  version: string
  ffmpegVersion: string | null
  caps: Caps
  settings: AppSettings
  /** Project file passed on the command line (file association). */
  openPath: string | null
  /** Unsaved work from a session that did not exit cleanly. */
  recovery: Recovery | null
  isDev: boolean
  /** The operating system's preferred languages, most preferred first ("ja-JP", "en-US"). */
  systemLanguages: string[]
}

export interface Recovery {
  project: Project
  path: string | null
}

export interface RasterAsset {
  /** Clip id (text) or effect id (overlay). */
  id: string
  png: Uint8Array
  w: number
  h: number
  k: number
}

export interface ExportRequest {
  project: Project
  settings: ExportSettings
  outPath: string
  text: RasterAsset[]
  overlays: RasterAsset[]
  /** Rendered subtitle cue images (and blank gap images), each written once. */
  subtitleImages: { id: string; png: Uint8Array }[]
  /** Subtitle clips to burn in; image fields refer to `subtitleImages` ids. */
  subtitleClips: {
    clipId: string
    w: number
    h: number
    k: number
    duration: number
    gap: string
    cues: { image: string; start: number; end: number }[]
  }[]
}

export type ExportResult = { ok: true; outPath: string } | { ok: false; cancelled: boolean; error: string }

export interface SubtitleStreamListing {
  index: number
  codec: string
  title: string
  language: string
  text: boolean
}

export type ConvertResult =
  | { ok: true; item: MediaItem; path: string; /** Every stream was copied, so nothing was re-encoded. */ copied: boolean }
  | { ok: false; cancelled: boolean; error: string }

export interface OpenedProject {
  path: string
  project: Project
}

export interface Api {
  getInfo(): Promise<AppInfo>
  saveSettings(patch: Partial<AppSettings>): Promise<void>

  pickMedia(): Promise<string[]>
  importMedia(paths: string[]): Promise<{ items: MediaItem[]; errors: string[] }>
  /** Starts (or resumes from cache) preparation of preview assets. Updates arrive via onMediaCache. */
  prepareMedia(items: MediaItem[]): Promise<void>
  /** The preview cannot decode this video's original: build the chunked preview copy (required). */
  requestProxy(mediaId: string): Promise<void>
  /** Turns the optional fast-seek preview copy of a video on or off. */
  setFastSeek(mediaId: string, on: boolean): Promise<void>
  /** Where the user is working in a video (source seconds), so nearby preview chunks are built first. */
  proxyFocus(mediaId: string, sourceTime: number): void
  /** Writes an MP4 copy next to the original (which is left untouched) and describes it. */
  convertToMp4(mediaId: string): Promise<ConvertResult>
  cancelConvert(mediaId: string): Promise<void>
  relinkMedia(item: MediaItem): Promise<MediaItem | null>
  onMediaCache(cb: (mediaId: string, patch: Partial<MediaCache>) => void): () => void
  pathForFile(file: File): string

  listFonts(): Promise<string[]>

  listPresets(): Promise<Preset[]>
  savePreset(preset: Preset): Promise<void>
  deletePreset(id: string): Promise<void>
  /** Whether each file exists. */
  filesExist(paths: string[]): Promise<boolean[]>

  /** Asks for subtitle files to import. */
  pickSubtitleFiles(): Promise<string[]>
  readSubtitleFile(path: string, fps: number): Promise<{ name: string; language: string; cues: SubtitleCue[] }>
  listSubtitleStreams(mediaPath: string): Promise<SubtitleStreamListing[]>
  extractSubtitleStream(mediaPath: string, index: number): Promise<SubtitleCue[]>
  /** Asks where to save a subtitle file and writes it. Returns the path, or null if cancelled. */
  saveSubtitleFile(suggestedName: string, ext: string, label: string, content: string): Promise<string | null>

  openProject(path?: string): Promise<OpenedProject | null>
  /** Saves to `path`, or asks for a location when it is null. Returns the path, or null if cancelled. */
  saveProject(path: string | null, project: Project): Promise<string | null>
  writeRecovery(data: Recovery | null): Promise<void>
  /** A project file was opened from outside (double-clicked while the app is running). */
  onOpenPath(cb: (path: string) => void): () => void

  pickExportPath(suggestedName: string, ext: string, label: string): Promise<string | null>
  startExport(req: ExportRequest): Promise<ExportResult>
  cancelExport(): Promise<void>
  onExportProgress(cb: (fraction: number) => void): () => void
  showInFolder(path: string): Promise<void>

  setWindowState(state: { title: string; dirty: boolean }): void
  /** The window wants to close while there are unsaved changes. */
  onCloseRequest(cb: () => void): () => void
  confirmClose(): void
  toggleDevTools(): void
}

declare global {
  interface Window {
    cw: Api
  }
}

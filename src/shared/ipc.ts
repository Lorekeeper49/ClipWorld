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

// The contract between the renderer and the main process.
import type { Caps } from './filtergraph'
import type { ExportSettings } from './formats'
import type { EaseCurve, MediaItem, Project, SubtitleCue } from './model'
import type { BrokenPlugin, PluginInfo } from './plugins'
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
  /**
   * Reversed copy of the picture for clips that play backwards: chunk k holds source time [k*seconds,
   * (k+1)*seconds) played from its end, so chunk time τ shows source time (k*seconds + chunk length) - τ.
   */
  reverse?: ProxyChunks
  /** Each audio track reversed whole, by audio stream index: file time τ is source time duration - τ. */
  reverseAudio?: Record<number, { url: string; duration: number }>
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

/** The plugins found, the plugin.json files that could not be read, and the Plugins folder. */
export interface PluginList {
  plugins: PluginInfo[]
  broken: BrokenPlugin[]
  folder: string
}

/** How installing a plugin went: cancelled, installed (or updated), or an error message. */
export interface PluginInstallReply {
  canceled?: boolean
  id?: string
  updated?: boolean
  error?: string
}

/** A plugin effect's picture to preview: the layer before the effect, as a PNG. */
export interface PluginPreviewRequest {
  type: string
  params: Record<string, unknown>
  png: Uint8Array
  width: number
  height: number
  /** Pixels per reference pixel (sizes in effects are given for a 1080-line frame). */
  scale: number
  fps: number
  duration: number
}

/** How a preset export went: cancelled, saved (with chosen files that were gone), or an error message. */
export interface PresetExportReply {
  canceled?: boolean
  path?: string
  skipped?: string[]
  error?: string
}

/** How a preset import went: cancelled, the imported preset, or an error message. */
export interface PresetImportReply {
  canceled?: boolean
  preset?: Preset
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
  /** Plugins that are on, by id. */
  enabledPlugins?: string[]
  /** Plugin folders loaded where they are (a developer's), rather than installed. */
  pluginFolders?: string[]
  /** Folder of the last preset exported or imported. */
  lastPresetDir?: string
  /** The Subtitles window was added to a layout saved before it existed (done once, so closing it sticks). */
  subtitlesPanelAdded?: boolean
  /** Windows added to layouts saved before they existed (each only once, so closing them sticks). */
  addedPanels?: string[]
  /** Interface language code ("ja"), or "system" / unset to follow the operating system. */
  language?: string
  /** Import a preset's missing media without asking. */
  autoImportPresetMedia?: boolean
  /** Timeline color for each kind of clip ('#rrggbb'); missing kinds use the default. */
  clipColors?: Partial<Record<'video' | 'audio' | 'image' | 'text' | 'subtitles', string>>
  /** Easing curves saved from the easing graph. */
  easePresets?: { id: string; name: string; curve: EaseCurve }[]
  /** Microphone for voiceovers (a device id); unset uses the system's default. */
  voiceoverDevice?: string
  /** Play the timeline's sound while recording a voiceover (off when there are no headphones). */
  voiceoverMonitor?: boolean
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
  /**
   * Where clips play a file backwards (source ranges) and the source time at the playhead, so the reversed
   * copies they need are built (nearest first). An empty list means no clip plays it backwards any more.
   */
  reverseFocus(mediaId: string, ranges: [number, number][], sourceTime: number): void
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
  /** Asks where to save, then writes the preset as a zip with the media whose ids are in `include`. */
  exportPreset(preset: Preset, include: string[]): Promise<PresetExportReply>
  /** Asks for an exported preset (a zip, or preset.json from an unzipped one) and adds it to the presets. */
  importPreset(): Promise<PresetImportReply>
  /** Whether each file exists. */
  filesExist(paths: string[]): Promise<boolean[]>

  listPlugins(): Promise<PluginList>
  /** Looks for plugins again (after adding one to the Plugins folder) and starts any that are on. */
  rescanPlugins(): Promise<PluginList>
  setPluginsEnabled(changes: { id: string; on: boolean }[]): Promise<PluginList>
  restartPlugin(id: string): Promise<PluginList>
  /** The plugin's recent messages (what it wrote to stderr). */
  pluginLog(id: string): Promise<string[]>
  removePlugin(id: string): Promise<PluginList>
  openPluginsFolder(): Promise<string>
  /** Asks for a plugin's zip (installed) or plugin.json (loaded where it is). */
  installPlugin(): Promise<PluginInstallReply>
  /** Asks a plugin something (command, import, export, effectFilter). */
  invokePlugin(id: string, method: string, params: unknown, timeoutMs?: number): Promise<{ result?: unknown; error?: string }>
  notifyPlugin(id: string, method: string, params: unknown): void
  /** Answers a plugin's request (see onPluginRequest). */
  replyToPlugin(reqId: number, ok: boolean, value: unknown): void
  pluginPreviewFrame(req: PluginPreviewRequest): Promise<{ png?: Uint8Array | null; error?: string }>
  pluginSaveDialog(title: string, defaultName: string, ext: string, label: string): Promise<string | null>
  pluginOpenDialog(title: string, exts: string[], label: string): Promise<string[]>
  onPluginsChanged(cb: (list: PluginList) => void): () => void
  /** A plugin asks about the project, or for an edit: answer with replyToPlugin. */
  onPluginRequest(cb: (reqId: number, pluginId: string, method: string, params: unknown) => void): () => void
  /** A plugin sends something to one of its windows. */
  onPluginPanel(cb: (pluginId: string, params: unknown) => void): () => void

  /** Asks for subtitle files to import. */
  pickSubtitleFiles(): Promise<string[]>
  readSubtitleFile(path: string, fps: number): Promise<{ name: string; language: string; cues: SubtitleCue[] }>
  listSubtitleStreams(mediaPath: string): Promise<SubtitleStreamListing[]>
  extractSubtitleStream(mediaPath: string, index: number): Promise<SubtitleCue[]>
  /** Asks where to save a subtitle file and writes it. Returns the path, or null if cancelled. */
  saveSubtitleFile(suggestedName: string, ext: string, label: string, content: string): Promise<string | null>

  openProject(path?: string): Promise<OpenedProject | null>
  /**
   * Saves to `path`, or asks for a location when it is null (starting next to `saveAsFrom`, the project's
   * current file, or in Documents/ClipWorld/Projects). Returns the path, or null if cancelled.
   */
  saveProject(path: string | null, project: Project, saveAsFrom?: string | null): Promise<string | null>
  writeRecovery(data: Recovery | null): Promise<void>
  /** A project file was opened from outside (double-clicked while the app is running). */
  onOpenPath(cb: (path: string) => void): () => void

  pickExportPath(suggestedName: string, ext: string, label: string): Promise<string | null>
  startExport(req: ExportRequest): Promise<ExportResult>
  cancelExport(): Promise<void>
  onExportProgress(cb: (fraction: number) => void): () => void
  showInFolder(path: string): Promise<void>

  /**
   * Voiceover recording: opens a WAV file (next to the project, or in Documents/ClipWorld/Voiceovers before
   * it is saved), appends 16-bit mono samples as they are recorded, and finishes or throws the take away.
   */
  voiceoverBegin(projectPath: string | null, sampleRate: number): Promise<{ id: string; path: string }>
  voiceoverWrite(id: string, samples: Uint8Array): Promise<void>
  voiceoverEnd(id: string, sampleRate: number): Promise<{ path: string; duration: number } | null>
  voiceoverDiscard(id: string): Promise<void>
  /** Deletes a finished take's file. */
  voiceoverRemove(path: string): Promise<void>

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

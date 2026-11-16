// The contract between the renderer and the main process.
import type { Caps } from './filtergraph'
import type { ExportSettings } from './formats'
import type { MediaItem, Project } from './model'

/** Waveform peak resolution of the cached peak files (one unsigned byte per window). */
export const PEAKS_PER_SECOND = 50

export interface Filmstrip {
  url: string
  count: number
  tileW: number
  tileH: number
}

/** What the main process has prepared for a media item so the renderer can preview it. */
export interface MediaCache {
  /** Original file, served over the media protocol. */
  sourceUrl: string
  /** Proxy video for files Chromium cannot decode (and for GIFs). */
  proxyUrl?: string
  proxyState?: 'pending' | 'ready' | 'error'
  proxyProgress?: number
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
}

export type ExportResult = { ok: true; outPath: string } | { ok: false; cancelled: boolean; error: string }

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
  requestProxy(mediaId: string): Promise<void>
  relinkMedia(item: MediaItem): Promise<MediaItem | null>
  onMediaCache(cb: (mediaId: string, patch: Partial<MediaCache>) => void): () => void
  pathForFile(file: File): string

  listFonts(): Promise<string[]>

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

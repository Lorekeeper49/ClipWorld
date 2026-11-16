// Application state. The project is edited through `edit()`, which records Immer patches for
// undo/redo. Everything else (selection, zoom, caches) is plain UI state.
import { type Patch, applyPatches, enablePatches, produceWithPatches } from 'immer'
import { create } from 'zustand'
import type { Caps } from '@shared/filtergraph'
import type { AppSettings, MediaCache } from '@shared/ipc'
import { type Clip, type MediaItem, type Project, newProject } from '@shared/model'
import type { ClipboardData } from '@shared/timeline-ops'

enablePatches()

interface HistoryEntry {
  patches: Patch[]
  inverse: Patch[]
  key?: string
  time: number
}

export type Modal = null | 'export' | 'shortcuts' | 'close' | 'about'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export interface State {
  project: Project
  projectPath: string | null
  /** Bumped whenever a different project is loaded, so views can reset. */
  projectEpoch: number
  dirty: boolean
  undo: HistoryEntry[]
  redo: HistoryEntry[]

  selection: string[]
  selectedMediaId: string | null
  clipboard: ClipboardData | null
  /** Timeline zoom, pixels per second. */
  pps: number
  snapping: boolean

  mediaCache: Record<string, MediaCache>
  /** Whether Chromium can decode each media's original file. */
  playable: Record<string, 'ok' | 'bad'>

  settings: AppSettings
  caps: Caps
  ffmpegVersion: string | null
  fonts: string[]
  modal: Modal
  /** What to do after the "unsaved changes" dialog resolves. */
  pendingAfterClose: (() => void) | null
  toasts: Toast[]
}

export const useStore = create<State>(() => ({
  project: newProject(),
  projectPath: null,
  projectEpoch: 0,
  dirty: false,
  undo: [],
  redo: [],
  selection: [],
  selectedMediaId: null,
  clipboard: null,
  pps: 60,
  snapping: true,
  mediaCache: {},
  playable: {},
  settings: { shortcuts: {}, previewVolume: 1, recent: [] },
  caps: { encoders: [], filters: [] },
  ffmpegVersion: null,
  fonts: [],
  modal: null,
  pendingAfterClose: null,
  toasts: []
}))

export const get = useStore.getState
export const set = useStore.setState

const MAX_HISTORY = 300

export interface EditOptions {
  /** Edits with the same key merge into one undo step (within a second, or always when `sticky`). */
  key?: string
  sticky?: boolean
}

/** Applies a change to the project and records it for undo. Returns false if nothing changed. */
export function edit(recipe: (p: Project) => void, opts: EditOptions = {}): boolean {
  const state = get()
  const [next, patches, inverse] = produceWithPatches(state.project, (draft) => {
    recipe(draft as Project)
  })
  if (!patches.length) return false
  const now = performance.now()
  const undo = state.undo.slice()
  const top = undo[undo.length - 1]
  if (opts.key && top && top.key === opts.key && (opts.sticky || now - top.time < 1000)) {
    undo[undo.length - 1] = {
      patches: [...top.patches, ...patches],
      inverse: [...inverse, ...top.inverse],
      key: top.key,
      time: now
    }
  } else {
    undo.push({ patches, inverse, key: opts.key, time: now })
    if (undo.length > MAX_HISTORY) undo.shift()
  }
  set({ project: next, undo, redo: [], dirty: true })
  return true
}

function pruneSelection(project: Project, selection: string[]): string[] {
  const ids = new Set(project.clips.map((c) => c.id))
  return selection.filter((id) => ids.has(id))
}

export function undo(): void {
  const s = get()
  const entry = s.undo[s.undo.length - 1]
  if (!entry) return
  const project = applyPatches(s.project, entry.inverse)
  set({
    project,
    undo: s.undo.slice(0, -1),
    redo: [...s.redo, { ...entry, key: undefined }],
    dirty: true,
    selection: pruneSelection(project, s.selection)
  })
}

export function redo(): void {
  const s = get()
  const entry = s.redo[s.redo.length - 1]
  if (!entry) return
  const project = applyPatches(s.project, entry.patches)
  set({
    project,
    redo: s.redo.slice(0, -1),
    undo: [...s.undo, { ...entry, key: undefined }],
    dirty: true,
    selection: pruneSelection(project, s.selection)
  })
}

/** Replaces the whole project (new / open). Clears history. */
export function loadProject(project: Project, path: string | null, dirty = false): void {
  set((s) => ({
    project,
    projectPath: path,
    projectEpoch: s.projectEpoch + 1,
    dirty,
    undo: [],
    redo: [],
    selection: [],
    selectedMediaId: null,
    mediaCache: {},
    playable: {}
  }))
}

let toastId = 0
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 3500)
}

export function patchSettings(patch: Partial<AppSettings>): void {
  set((s) => ({ settings: { ...s.settings, ...patch } }))
  void window.cw.saveSettings(patch)
}

// ---------------------------------------------------------------- selectors

export const selectedClips = (s: State): Clip[] => {
  if (!s.selection.length) return []
  const ids = new Set(s.selection)
  return s.project.clips.filter((c) => ids.has(c.id))
}

/** The clip the Tools panel edits: the first selected visual clip, else the first selected clip. */
export function primaryClip(s: State): Clip | undefined {
  const sel = selectedClips(s)
  return sel.find((c) => c.type !== 'audio') ?? sel[0]
}

export const mediaOf = (s: State, id?: string): MediaItem | undefined => s.project.media.find((m) => m.id === id)

export function projectName(s: State): string {
  if (!s.projectPath) return 'Untitled'
  const base = s.projectPath.split(/[\\/]/).pop() ?? 'Untitled'
  return base.replace(/\.vcws$/i, '')
}

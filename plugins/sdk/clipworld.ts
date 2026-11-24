// ClipWorld plugin SDK for TypeScript. Copy this file next to your plugin's main file. ClipWorld runs .ts
// plugins directly (Node.js strips the types), so there is nothing to build.
//
// SPDX-License-Identifier: MIT
// This SDK is MIT licensed (unlike ClipWorld itself, which is GPL-3.0-or-later), so plugins that use it
// can be under any license. Copyright (C) 2026 Lorekeeper49.
//
//   import { plugin, api } from './clipworld.ts'
//   plugin.command('hello', async () => { await api.showMessage('Hello!') })
//   plugin.start()
//
// See PLUGINS.md for the whole protocol and every method.
import { createInterface } from 'node:readline'

export interface Context {
  /** Ids of the selected clips. */
  selection: string[]
  /** Playhead time, seconds. */
  playhead: number
}
export interface CommandRequest extends Context { command: string }
export interface ImportRequest extends Context { importer: string; path: string }
export interface ExportRequest extends Context { exporter: string; path: string }
export interface EffectInfo {
  target: 'video' | 'audio'
  width: number
  height: number
  fps: number
  /** Pixels per pixel of a 1080-line frame: multiply sizes by it. */
  scale: number
  /** The clip's length, seconds. */
  duration: number
  /** True when it's for the paused preview (one picture) rather than the export. */
  preview: boolean
}
export type Params = Record<string, string | number | boolean>
export interface FormField {
  key: string
  label: string
  type?: 'text' | 'multiline' | 'number' | 'checkbox' | 'select' | 'color'
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
}
export interface Cue { start: number; end: number; text: string }

// The project's shape is described in PLUGINS.md; these are the parts most plugins use.
export interface Clip {
  id: string
  trackId: string
  type: 'video' | 'audio' | 'image' | 'text' | 'subtitles'
  mediaId?: string
  name: string
  start: number
  duration: number
  srcIn: number
  speed: number
  volume: number
  text?: { content: string; [key: string]: unknown }
  effects: { id: string; type: string; enabled: boolean; params: Params }[]
  [key: string]: unknown
}
export interface MediaItem { id: string; kind: 'video' | 'audio' | 'image'; name: string; path: string; duration: number; width: number; height: number; [key: string]: unknown }
export interface Track { id: string; kind: 'video' | 'audio'; name: string; [key: string]: unknown }
export interface Project {
  settings: { width: number; height: number; fps: number }
  media: MediaItem[]
  tracks: Track[]
  clips: Clip[]
  subtitles: { id: string; name: string; cues: (Cue & { id: string })[]; [key: string]: unknown }[]
  [key: string]: unknown
}

type Fn<T> = (req: T) => unknown | Promise<unknown>
const handlers = {
  command: new Map<string, Fn<CommandRequest>>(),
  import: new Map<string, Fn<ImportRequest>>(),
  export: new Map<string, Fn<ExportRequest>>(),
  effect: new Map<string, (params: Params, info: EffectInfo) => string | Promise<string>>(),
  panel: new Map<string, (data: unknown) => unknown>()
}
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let nextId = 1
let initInfo: unknown = null
let onShutdown: (() => unknown) | null = null

function send(msg: object): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

/** Sends a request to ClipWorld and resolves with its answer. */
export function call<T = unknown>(method: string, params: object = {}): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    send({ id, method, params })
  })
}

/** Sends a message that needs no answer. */
export function notify(method: string, params: object = {}): void {
  send({ method, params })
}

/** Everything a plugin can ask ClipWorld. */
export const api = {
  getProject: () => call<Project>('getProject'),
  /** Replaces the whole project (one undo step). */
  setProject: (project: Project) => call<null>('setProject', { project }),
  getSelection: () => call<string[]>('getSelection'),
  setSelection: (ids: string[]) => call<null>('setSelection', { ids }),
  getPlayhead: () => call<number>('getPlayhead'),
  setPlayhead: (time: number) => call<null>('setPlayhead', { time }),
  importMedia: (paths: string[]) => call<MediaItem[]>('importMedia', { paths }),
  addMediaClip: (mediaId: string, start?: number, trackId?: string) => call<string[]>('addMediaClip', { mediaId, start, trackId }),
  addTextClip: (start?: number, text: Record<string, unknown> = {}, duration?: number) => call<string>('addTextClip', { start, text, duration }),
  /** Changes a clip (objects such as transform are merged). */
  updateClip: (id: string, changes: Record<string, unknown>) => call<null>('updateClip', { id, changes }),
  removeClips: (ids: string[]) => call<null>('removeClips', { ids }),
  addEffect: (clipId: string, type: string, params: Params = {}) => call<string>('addEffect', { clipId, type, params }),
  addSubtitleTrack: (name: string, cues: Cue[], opts: { language?: string; addClip?: boolean } = {}) =>
    call<{ trackId: string; clipId: string | null }>('addSubtitleTrack', { name, cues, language: opts.language ?? 'eng', addClip: opts.addClip ?? true }),
  showMessage: (text: string, kind: 'info' | 'error' = 'info') => call<null>('showMessage', { text, kind }),
  askUser: (form: { title?: string; message?: string; okLabel?: string; fields: FormField[] }) => call<Record<string, unknown> | null>('askUser', form),
  pickFile: (options: { save?: boolean; title?: string; defaultName?: string; filters?: { name: string; extensions: string[] }[] } = {}) =>
    call<string | null>('pickFile', options),
  getAppInfo: () => call<{ version: string; language: string; platform: string; ffmpeg: string | null; ffprobe: string | null; pluginDir: string; dataDir: string }>('getAppInfo'),
  postToPanel: (panel: string, data: unknown) => notify('postToPanel', { panel, data })
}

function pick<T>(map: Map<string, T>, kind: string, id: string): T {
  const fn = map.get(id)
  if (!fn) throw new Error(`This plugin has no ${kind} "${id}"`)
  return fn
}

async function handle(method: string, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      initInfo = p
      return { ok: true }
    case 'command':
      return pick(handlers.command, 'command', String(p.command))(p as unknown as CommandRequest)
    case 'import':
      return pick(handlers.import, 'importer', String(p.importer))(p as unknown as ImportRequest)
    case 'export':
      return pick(handlers.export, 'exporter', String(p.exporter))(p as unknown as ExportRequest)
    case 'effectFilter': {
      const { effect, params, ...info } = p
      return { filter: await pick(handlers.effect, 'effect', String(effect))((params ?? {}) as Params, info as unknown as EffectInfo) }
    }
    default:
      throw new Error(`Unknown method "${method}"`)
  }
}

function start(): void {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: { id?: number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method) {
      const params = msg.params ?? {}
      if (msg.id === undefined || msg.id === null) {
        if (msg.method === 'panelMessage') {
          const fn = handlers.panel.get(String(params.panel))
          if (fn) Promise.resolve().then(() => fn(params.data)).catch((e) => console.error(e))
        } else if (msg.method === 'shutdown') {
          Promise.resolve(onShutdown?.()).finally(() => process.exit(0))
        }
        return
      }
      const id = msg.id
      handle(msg.method, params).then(
        (result) => send({ id, result: result ?? null }),
        (err: Error) => send({ id, error: { code: -32000, message: err?.message ?? String(err) } })
      )
    } else if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  })
  rl.on('close', () => process.exit(0))
  // console.log would break the protocol: send it to the plugin's messages (stderr) instead.
  console.log = (...args: unknown[]) => console.error(...args)
}

/** Registers what the plugin does, by the ids given in plugin.json. */
export const plugin = {
  command: (id: string, fn: Fn<CommandRequest>) => void handlers.command.set(id, fn),
  importer: (id: string, fn: Fn<ImportRequest>) => void handlers.import.set(id, fn),
  exporter: (id: string, fn: Fn<ExportRequest>) => void handlers.export.set(id, fn),
  /** Returns the ffmpeg filter chain for the effect's settings, e.g. "hue=s=0". */
  effect: (id: string, fn: (params: Params, info: EffectInfo) => string | Promise<string>) => void handlers.effect.set(id, fn),
  panel: (id: string, fn: (data: unknown) => unknown) => void handlers.panel.set(id, fn),
  onShutdown: (fn: () => unknown) => void (onShutdown = fn),
  get info(): unknown {
    return initInfo
  },
  start
}

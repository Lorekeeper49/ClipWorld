// ClipWorld plugin SDK for JavaScript (Node.js). Copy this file next to your plugin's main file.
//
// SPDX-License-Identifier: MIT
// This SDK is MIT licensed (unlike ClipWorld itself, which is GPL-3.0-or-later), so plugins that use it
// can be under any license. Copyright (C) 2026 Lorekeeper49.
//
//   import { plugin, api } from './clipworld.mjs'
//   plugin.command('hello', async (ctx) => { await api.showMessage('Hello!') })
//   plugin.start()
//
// See PLUGINS.md for the whole protocol and every method.
import { createInterface } from 'node:readline'

const handlers = { command: new Map(), import: new Map(), export: new Map(), effect: new Map(), panel: new Map() }
const pending = new Map()
let nextId = 1
let initInfo = null
let onShutdown = null

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

/** Sends a request to ClipWorld and resolves with its answer. */
export function call(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

/** Sends a message that needs no answer. */
export function notify(method, params = {}) {
  send({ method, params })
}

/** Everything a plugin can ask ClipWorld. All return promises. */
export const api = {
  getProject: () => call('getProject'),
  /** Replaces the whole project (one undo step). */
  setProject: (project) => call('setProject', { project }),
  getSelection: () => call('getSelection'),
  setSelection: (ids) => call('setSelection', { ids }),
  getPlayhead: () => call('getPlayhead'),
  setPlayhead: (time) => call('setPlayhead', { time }),
  /** Imports files into the project's media; resolves with their media items. */
  importMedia: (paths) => call('importMedia', { paths }),
  /** Puts media on the timeline (a video brings its sound); resolves with the new clips' ids. */
  addMediaClip: (mediaId, start, trackId) => call('addMediaClip', { mediaId, start, trackId }),
  /** Adds a text clip; `text` can set content, fontFamily, fontSize, color… Resolves with its id. */
  addTextClip: (start, text = {}, duration) => call('addTextClip', { start, text, duration }),
  /** Changes a clip: { start, duration, volume, transform: { start: { x } } … } (objects are merged). */
  updateClip: (id, changes) => call('updateClip', { id, changes }),
  removeClips: (ids) => call('removeClips', { ids }),
  /** Adds an effect (a built-in type such as "blur", or one of this plugin's effects by its id). */
  addEffect: (clipId, type, params = {}) => call('addEffect', { clipId, type, params }),
  /** Adds a subtitle track ({ start, end, text } cues) and, unless addClip is false, puts it on the timeline. */
  addSubtitleTrack: (name, cues, { language = 'eng', addClip = true } = {}) => call('addSubtitleTrack', { name, cues, language, addClip }),
  showMessage: (text, kind = 'info') => call('showMessage', { text, kind }),
  /**
   * Asks the user: { title, message, okLabel, fields: [{ key, label, type, default, options, min, max }] }
   * with type text, multiline, number, checkbox, select or color. Resolves with { key: value } or null.
   */
  askUser: (form) => call('askUser', form),
  /** A file to open, or with save: true where to save: { save, title, defaultName, filters }. Null if cancelled. */
  pickFile: (options = {}) => call('pickFile', options),
  /** ClipWorld's version and language, ffmpeg's path, this plugin's folder and a folder for its data. */
  getAppInfo: () => call('getAppInfo'),
  /** Sends something to one of this plugin's windows (it arrives there as a message event). */
  postToPanel: (panel, data) => notify('postToPanel', { panel, data })
}

/** Registers what the plugin does, by the ids given in plugin.json. */
export const plugin = {
  /** A command: fn({ command, selection, playhead }). Return a string to show it as a message. */
  command: (id, fn) => handlers.command.set(id, fn),
  /** An importer: fn({ importer, path, selection, playhead }). */
  importer: (id, fn) => handlers.import.set(id, fn),
  /** An exporter: fn({ exporter, path, selection, playhead }): write the file at path. */
  exporter: (id, fn) => handlers.export.set(id, fn),
  /**
   * An effect: fn(params, info) returns the ffmpeg filter chain for those settings, such as "hue=s=0".
   * info: { target, width, height, fps, scale (pixels per 1080p pixel), duration, preview }.
   */
  effect: (id, fn) => handlers.effect.set(id, fn),
  /** Messages from one of this plugin's windows: fn(data). */
  panel: (id, fn) => handlers.panel.set(id, fn),
  /** Called when ClipWorld closes the plugin. */
  onShutdown: (fn) => (onShutdown = fn),
  /** What ClipWorld said when it started the plugin: { apiVersion, app: { version, language }, plugin: { id, dir } }. */
  get info() {
    return initInfo
  },
  start
}

function pick(kind, id) {
  const fn = handlers[kind].get(id)
  if (!fn) throw new Error(`This plugin has no ${kind} "${id}"`)
  return fn
}

async function handle(msg) {
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      initInfo = p
      return { ok: true }
    case 'command':
      return pick('command', p.command)(p)
    case 'import':
      return pick('import', p.importer)(p)
    case 'export':
      return pick('export', p.exporter)(p)
    case 'effectFilter': {
      const { effect, params, ...info } = p
      return { filter: await pick('effect', effect)(params ?? {}, info) }
    }
    default:
      throw new Error(`Unknown method "${msg.method}"`)
  }
}

function start() {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method) {
      if (msg.id === undefined || msg.id === null) {
        if (msg.method === 'panelMessage') {
          const fn = handlers.panel.get(msg.params?.panel)
          if (fn) Promise.resolve().then(() => fn(msg.params.data)).catch((e) => console.error(e))
        } else if (msg.method === 'shutdown') {
          Promise.resolve(onShutdown?.()).finally(() => process.exit(0))
        }
        return
      }
      Promise.resolve()
        .then(() => handle(msg))
        .then(
          (result) => send({ id: msg.id, result: result ?? null }),
          (err) => send({ id: msg.id, error: { code: -32000, message: err?.message ?? String(err) } })
        )
    } else if (pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  })
  rl.on('close', () => process.exit(0))
  // console.log would break the protocol: send it to the plugin's messages (stderr) instead.
  console.log = (...args) => console.error(...args)
}

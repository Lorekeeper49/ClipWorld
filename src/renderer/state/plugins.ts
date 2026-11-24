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

// Plugins, on the window's side: what they add to the menus, shortcuts and effects list, running their
// commands, importers and exporters, and answering what they ask about the project (the project lives
// here, so every edit a plugin makes goes through edit() and can be undone).
import { EFFECT_MAP, makeEffect, setPluginEffects } from '@shared/effects'
import { t } from '@shared/i18n'
import type { PluginList } from '@shared/ipc'
import { type Clip, type Project, type TextProps, clone, makeSubtitleTrack, parseProject, uid } from '@shared/model'
import {
  type PluginCommand, type PluginConflict, type PluginInfo, findConflicts, pluginCommandId, pluginEffectDefs, pluginText
} from '@shared/plugins'
import { addSubtitleClip, addTextClip, placeMedia } from '@shared/timeline-ops'
import { player } from '../engine/player'
import { clearPluginPreviews } from '../engine/pluginPreview'
import { importPaths } from './actions'
import { SHORTCUTS, bindingFor } from './shortcuts'
import { edit, get, set, toast, useStore } from './store'

/** A field of a plugin's question to the user (askUser). */
export interface PluginFormField {
  key: string
  label: string
  type: 'text' | 'multiline' | 'number' | 'checkbox' | 'select' | 'color'
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
}

export interface PluginForm {
  plugin: string
  title: string
  message?: string
  okLabel?: string
  fields: PluginFormField[]
  answer: (values: Record<string, unknown> | null) => void
}

const lang = () => get().lang
export const pluginName = (p: PluginInfo): string => pluginText(p.manifest.name, lang())
export const activePlugins = (list: PluginList | null): PluginInfo[] => (list?.plugins ?? []).filter((p) => p.enabled)
export const runningPlugins = (list: PluginList | null): PluginInfo[] => (list?.plugins ?? []).filter((p) => p.enabled && p.state === 'running')

// ---------------------------------------------------------------- what plugins add

/** Plugin command names for the shortcuts list (by shortcut id). */
const commandNames = new Map<string, string>()
export const pluginCommandName = (id: string): string | undefined => commandNames.get(id)

/** Puts the plugins' effects, commands and shortcuts in place for the plugins that are on. */
function register(list: PluginList): void {
  const on = activePlugins(list)
  setPluginEffects(pluginEffectDefs(on, lang()))
  for (let i = SHORTCUTS.length - 1; i >= 0; i--) if (SHORTCUTS[i].id.startsWith('plugin:')) SHORTCUTS.splice(i, 1)
  commandNames.clear()
  for (const p of on) {
    for (const c of p.manifest.commands) {
      const id = pluginCommandId(p.manifest.id, c.id)
      commandNames.set(id, `${pluginName(p)}: ${pluginText(c.title, lang())}`)
      SHORTCUTS.push({ id, group: 'Plugins', default: c.shortcut ?? '', run: () => void runPluginCommand(p.manifest.id, c.id) })
    }
  }
}

function apply(list: PluginList): void {
  register(list)
  // Effects may now look different (or their plugin is gone): draw them again.
  clearPluginPreviews()
  player.invalidate()
  set({ plugins: list })
}

export async function loadPlugins(): Promise<void> {
  apply(await window.cw.listPlugins())
  window.cw.onPluginsChanged(apply)
  window.cw.onPluginRequest((reqId, pluginId, method, params) => {
    void answer(pluginId, method, params).then(
      (value) => window.cw.replyToPlugin(reqId, true, value ?? null),
      (err: unknown) => window.cw.replyToPlugin(reqId, false, (err as Error)?.message ?? String(err))
    )
  })
  window.cw.onPluginPanel((pluginId, params) => {
    const p = (params ?? {}) as { panel?: string; data?: unknown }
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[data-plugin-panel]')) {
      if (frame.dataset.plugin === pluginId && (!p.panel || frame.dataset.pluginPanel === p.panel)) {
        frame.contentWindow?.postMessage({ type: 'clipworld', data: p.data ?? null }, '*')
      }
    }
  })
}

// Names follow the language.
useStore.subscribe((s, prev) => {
  if (s.lang !== prev.lang && s.plugins) register(s.plugins)
})

// ---------------------------------------------------------------- turning plugins on and off

/** The current shortcut of a plugin's command, after the user's changes. */
const shortcutOf = (pluginId: string, c: PluginCommand) => {
  const id = pluginCommandId(pluginId, c.id)
  return get().settings.shortcuts[id] ?? c.shortcut ?? ''
}

/** Plugins that are on and could break if `plugin` were turned on. */
export function conflictsFor(plugin: PluginInfo): PluginConflict[] {
  return findConflicts(plugin.manifest, activePlugins(get().plugins).map((p) => p.manifest), shortcutOf)
}

export async function setPluginsEnabled(changes: { id: string; on: boolean }[]): Promise<void> {
  apply(await window.cw.setPluginsEnabled(changes))
}

// ---------------------------------------------------------------- running what plugins add

/** Edits a plugin makes while one of its commands runs are undone together. */
const runKeys = new Map<string, string>()

async function invoke(pluginId: string, method: string, params: unknown): Promise<unknown> {
  const run = `plugin:${pluginId}:${uid('r')}`
  runKeys.set(pluginId, run)
  let r: { result?: unknown; error?: string }
  try {
    r = await window.cw.invokePlugin(pluginId, method, params)
  } finally {
    if (runKeys.get(pluginId) === run) runKeys.delete(pluginId)
  }
  if (r.error !== undefined) throw new Error(r.error)
  // A plugin may answer with a message to show.
  const msg = typeof r.result === 'string' ? r.result : (r.result as { message?: unknown } | null)?.message
  if (typeof msg === 'string' && msg) toast(msg)
  return r.result
}

const context = () => ({ selection: get().selection, playhead: player.time })

export async function runPluginCommand(pluginId: string, commandId: string): Promise<void> {
  try {
    await invoke(pluginId, 'command', { command: commandId, ...context() })
  } catch (err) {
    toast(t('plugins.failed', { error: (err as Error).message }), 'error')
  }
}

/** Plugin importers for a file, by extension: the first plugin that is on and reads it. */
export function importerFor(path: string): { plugin: PluginInfo; importer: string } | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  for (const p of runningPlugins(get().plugins)) {
    const imp = p.manifest.importers.find((i) => i.extensions.includes(ext))
    if (imp) return { plugin: p, importer: imp.id }
  }
  return null
}

export async function runImporter(pluginId: string, importerId: string, path: string): Promise<void> {
  try {
    await invoke(pluginId, 'import', { importer: importerId, path, ...context() })
  } catch (err) {
    toast(t('plugins.importFailed', { name: path.split(/[\\/]/).pop(), error: (err as Error).message }), 'error')
  }
}

/** File ▸ Import with a plugin: asks for files of its types, then hands each to the plugin. */
export async function importWithPlugin(pluginId: string, importerId: string): Promise<void> {
  const p = get().plugins?.plugins.find((x) => x.manifest.id === pluginId)
  const imp = p?.manifest.importers.find((i) => i.id === importerId)
  if (!p || !imp) return
  const title = pluginText(imp.title, lang())
  const files = await window.cw.pluginOpenDialog(title, imp.extensions, title)
  for (const f of files) await runImporter(pluginId, importerId, f)
}

/** File ▸ Export with a plugin: asks where, then the plugin writes the file. */
export async function exportWithPlugin(pluginId: string, exporterId: string): Promise<void> {
  const p = get().plugins?.plugins.find((x) => x.manifest.id === pluginId)
  const exp = p?.manifest.exporters.find((e) => e.id === exporterId)
  if (!p || !exp) return
  const title = pluginText(exp.title, lang())
  const name = (get().projectPath?.split(/[\\/]/).pop() ?? t('app.untitled')).replace(/\.vcws$/i, '')
  const path = await window.cw.pluginSaveDialog(title, `${name}.${exp.extension}`, exp.extension, title)
  if (!path) return
  try {
    await invoke(pluginId, 'export', { exporter: exporterId, path, ...context() })
    toast(t('plugins.exported', { name: path.split(/[\\/]/).pop() }))
  } catch (err) {
    toast(t('plugins.exportFailed', { error: (err as Error).message }), 'error')
  }
}

// ---------------------------------------------------------------- what plugins can ask

function ask(pluginId: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const fields = (Array.isArray(params.fields) ? params.fields : []).map((f0): PluginFormField => {
    const f = f0 as Record<string, unknown>
    const type = (['text', 'multiline', 'number', 'checkbox', 'select', 'color'] as const).find((x) => x === f.type) ?? 'text'
    return {
      key: String(f.key ?? ''), label: pluginText(f.label as string, lang()) || String(f.key ?? ''), type,
      default: f.default as PluginFormField['default'],
      options: Array.isArray(f.options) ? (f.options as Record<string, unknown>[]).map((o) => ({ value: String(o.value), label: pluginText(o.label as string, lang()) || String(o.value) })) : undefined,
      min: typeof f.min === 'number' ? f.min : undefined, max: typeof f.max === 'number' ? f.max : undefined,
      step: typeof f.step === 'number' ? f.step : undefined
    }
  })
  const plugin = get().plugins?.plugins.find((p) => p.manifest.id === pluginId)
  return new Promise((resolve) => {
    const before = get().modal
    set({
      modal: 'pluginForm',
      pluginForm: {
        plugin: plugin ? pluginName(plugin) : pluginId,
        title: pluginText(params.title as string, lang()) || (plugin ? pluginName(plugin) : pluginId),
        message: params.message ? pluginText(params.message as string, lang()) : undefined,
        okLabel: params.okLabel ? pluginText(params.okLabel as string, lang()) : undefined,
        fields,
        answer: (values) => {
          set({ modal: before === 'pluginForm' ? null : before, pluginForm: null })
          resolve(values)
        }
      }
    })
  })
}

const clipOf = (p: Project, id: unknown): Clip => {
  const c = p.clips.find((x) => x.id === id)
  if (!c) throw new Error(`No clip with id "${String(id)}"`)
  return c
}

/** Copies plain values over, merging one level into objects (so { transform: { start: {...} } } works). */
function merge(target: Record<string, unknown>, changes: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'id') continue
    const cur = target[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      merge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else target[k] = clone(v)
  }
}

async function answer(pluginId: string, method: string, params0: unknown): Promise<unknown> {
  const params = (params0 ?? {}) as Record<string, unknown>
  const key = runKeys.get(pluginId) ?? `plugin:${pluginId}`
  // Every edit by the same run is one undo step.
  const change = (recipe: (p: Project) => void) => edit(recipe, { key, sticky: runKeys.has(pluginId) })
  switch (method) {
    case 'getProject':
      return get().project
    case 'setProject': {
      const next = parseProject(params.project)
      change((p) => {
        for (const k of Object.keys(p) as (keyof Project)[]) delete (p as Partial<Project>)[k]
        Object.assign(p, next)
      })
      return null
    }
    case 'getSelection':
      return get().selection
    case 'setSelection': {
      const ids = new Set(get().project.clips.map((c) => c.id))
      set({ selection: (Array.isArray(params.ids) ? params.ids.map(String) : []).filter((id) => ids.has(id)) })
      return null
    }
    case 'getPlayhead':
      return player.time
    case 'setPlayhead':
      player.seek(Number(params.time) || 0)
      return null
    case 'importMedia': {
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : []
      const before = new Set(get().project.media.map((m) => m.id))
      await importPaths(paths, { plugins: false })
      // Files already in the project are given back too.
      const wanted = new Set(paths.map((x) => x.toLowerCase()))
      return get().project.media.filter((m) => !before.has(m.id) || wanted.has(m.path.toLowerCase()))
    }
    case 'addMediaClip': {
      const media = get().project.media.find((m) => m.id === params.mediaId)
      if (!media) throw new Error(`No media with id "${String(params.mediaId)}"`)
      let ids: string[] = []
      change((p) => { ids = placeMedia(p, media, Number(params.start ?? player.time) || 0, params.trackId as string | undefined) })
      return ids
    }
    case 'addTextClip': {
      let id = ''
      change((p) => {
        id = addTextClip(p, Number(params.start ?? player.time) || 0, (params.text ?? {}) as Partial<TextProps>)
        if (typeof params.duration === 'number' && params.duration > 0) clipOf(p, id).duration = params.duration
      })
      return id
    }
    case 'updateClip':
      change((p) => merge(clipOf(p, params.id) as unknown as Record<string, unknown>, (params.changes ?? {}) as Record<string, unknown>))
      return null
    case 'removeClips': {
      const ids = new Set(Array.isArray(params.ids) ? params.ids.map(String) : [])
      change((p) => { p.clips = p.clips.filter((c) => !ids.has(c.id)) })
      set((s) => ({ selection: s.selection.filter((id) => !ids.has(id)) }))
      return null
    }
    case 'addEffect': {
      const type = String(params.type ?? '')
      // A plugin may name its own effects by their short id.
      const full = EFFECT_MAP[type] ? type : `plugin:${pluginId}/${type}`
      if (!EFFECT_MAP[full]) throw new Error(`No effect "${type}"`)
      const fx = makeEffect(full)
      Object.assign(fx.params, (params.params ?? {}) as Record<string, unknown>)
      change((p) => { clipOf(p, params.clipId).effects.push(fx) })
      return fx.id
    }
    case 'addSubtitleTrack': {
      const track = makeSubtitleTrack(String(params.name ?? 'Subtitles'), String(params.language ?? 'eng'))
      track.cues = (Array.isArray(params.cues) ? params.cues : []).map((c0) => {
        const c = c0 as Record<string, unknown>
        return { id: uid('q'), start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text ?? '') }
      }).filter((c) => c.end > c.start)
      let clipId: string | null = null
      change((p) => {
        p.subtitles.push(track)
        if (params.addClip !== false) clipId = addSubtitleClip(p, track.id)
      })
      return { trackId: track.id, clipId }
    }
    case 'showMessage':
      toast(pluginText(params.text as string, lang()), params.kind === 'error' ? 'error' : 'info')
      return null
    case 'askUser':
      return ask(pluginId, params)
    default:
      throw new Error(`Unknown method "${method}"`)
  }
}

/** The shortcut shown next to a plugin command in the menu. */
export const pluginCommandShortcut = (pluginId: string, commandId: string): string => bindingFor(pluginCommandId(pluginId, commandId))

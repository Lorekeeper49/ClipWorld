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

// Plugins: programs in any language that add commands, file importers and exporters, effects and
// windows to ClipWorld. Each runs as its own process and talks to ClipWorld with JSON-RPC 2.0 messages,
// one per line, on its stdin and stdout (see PLUGINS.md). This file reads plugin.json and works out
// what plugins add, how to start them, and which plugins get in each other's way.
import type { EffectDef, ParamDef } from './effects'
import type { ParamValue } from './model'

/** The protocol version this ClipWorld speaks. Plugins asking for a newer one are not started. */
export const PLUGIN_API_VERSION = 1

/** Text shown to the user: one string, or one per language code ("en", "ja"…). */
export type PluginText = string | Record<string, string>

export interface PluginCommand {
  id: string
  title: PluginText
  /** Default keyboard shortcut, such as "Ctrl+Alt+H" (the user can change it). */
  shortcut?: string
}

export interface PluginImporter {
  id: string
  title: PluginText
  /** File extensions it reads, without the dot. */
  extensions: string[]
}

export interface PluginExporter {
  id: string
  title: PluginText
  /** The extension of the file it writes, without the dot. */
  extension: string
}

export interface PluginEffectParam {
  key: string
  label: PluginText
  type: 'number' | 'color' | 'boolean' | 'select'
  default: ParamValue
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: PluginText }[]
}

export interface PluginEffect {
  id: string
  title: PluginText
  /** What it changes: the picture ("video", the default) or the sound ("audio"). */
  target: 'video' | 'audio'
  params: PluginEffectParam[]
}

export interface PluginPanel {
  id: string
  title: PluginText
  /** The window's page, relative to the plugin's folder. */
  page: string
}

export interface PluginManifest {
  id: string
  name: PluginText
  version: string
  description?: PluginText
  author?: string
  /** The protocol version it was written for. */
  apiVersion: number
  /** The program to run, relative to the plugin's folder: its extension picks how (see pluginRuntime). */
  main?: string
  /** Or the exact command line to run, e.g. ["ruby", "main.rb"] (run in the plugin's folder). */
  command?: string[]
  /** Plugins this one is known not to work alongside, by id. */
  conflicts: string[]
  commands: PluginCommand[]
  importers: PluginImporter[]
  exporters: PluginExporter[]
  effects: PluginEffect[]
  panels: PluginPanel[]
}

export type PluginState = 'off' | 'starting' | 'running' | 'error'

/** A plugin found on disk, as the app shows it. */
export interface PluginInfo {
  /** Folder holding plugin.json. */
  dir: string
  /** Installed into the Plugins folder (removable), or loaded from a folder of its own (a developer's). */
  installed: boolean
  manifest: PluginManifest
  enabled: boolean
  state: PluginState
  /** Why it isn't running, when state is 'error'. */
  error?: string
}

/** A plugin.json that could not be read, so the user can be told why. */
export interface BrokenPlugin {
  dir: string
  error: string
}

/** Picks the text for the language, falling back to English, then to whatever there is. */
export function pluginText(text: PluginText | undefined, lang = 'en'): string {
  if (text === undefined || text === null) return ''
  if (typeof text === 'string') return text
  const base = lang.split('-')[0]
  return text[lang] ?? text[base] ?? text.en ?? Object.values(text)[0] ?? ''
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const isText = (v: unknown): v is PluginText =>
  typeof v === 'string' || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'))
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const ext = (v: unknown) => String(v ?? '').replace(/^\./, '').toLowerCase()

/** Reads plugin.json. Returns the manifest, or a message saying what's wrong with it. */
export function parseManifest(raw: unknown): PluginManifest | string {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'plugin.json must hold an object'
  if (typeof r.id !== 'string' || !ID.test(r.id)) return '"id" must be letters, digits, dots, dashes or underscores (up to 64)'
  if (!isText(r.name) || !pluginText(r.name)) return '"name" is missing'
  const apiVersion = Number(r.apiVersion ?? 1)
  if (!Number.isInteger(apiVersion) || apiVersion < 1) return '"apiVersion" must be a whole number'
  const command = Array.isArray(r.command) ? r.command.map(String) : undefined
  if (command && !command.length) return '"command" is empty'
  if (!command && typeof r.main !== 'string') return 'Either "main" or "command" is needed'
  const items = <T>(key: string, read: (x: Record<string, unknown>) => T | string): T[] | string => {
    const out: T[] = []
    const ids = new Set<string>()
    for (const [i, x] of list(r[key]).entries()) {
      const item = x as Record<string, unknown>
      if (!item || typeof item !== 'object') return `${key}[${i}] must be an object`
      if (typeof item.id !== 'string' || !ID.test(item.id)) return `${key}[${i}] needs an "id" (letters, digits, dots, dashes, underscores)`
      if (ids.has(item.id)) return `${key}[${i}]: "${item.id}" is used twice`
      ids.add(item.id)
      if (!isText(item.title) || !pluginText(item.title)) return `${key}[${i}] needs a "title"`
      const read1 = read(item)
      if (typeof read1 === 'string') return `${key}[${i}]: ${read1}`
      out.push(read1)
    }
    return out
  }
  const commands = items<PluginCommand>('commands', (x) => ({
    id: String(x.id), title: x.title as PluginText, ...(typeof x.shortcut === 'string' && x.shortcut ? { shortcut: x.shortcut } : {})
  }))
  if (typeof commands === 'string') return commands
  const importers = items<PluginImporter>('importers', (x) => {
    const exts = list(x.extensions).map(ext).filter(Boolean)
    return exts.length ? { id: String(x.id), title: x.title as PluginText, extensions: exts } : '"extensions" is empty'
  })
  if (typeof importers === 'string') return importers
  const exporters = items<PluginExporter>('exporters', (x) =>
    ext(x.extension) ? { id: String(x.id), title: x.title as PluginText, extension: ext(x.extension) } : '"extension" is missing')
  if (typeof exporters === 'string') return exporters
  const effects = items<PluginEffect>('effects', (x) => {
    const params: PluginEffectParam[] = []
    for (const [j, p0] of list(x.params).entries()) {
      const p = p0 as Record<string, unknown>
      if (!p || typeof p.key !== 'string' || !/^\w+$/.test(p.key)) return `params[${j}] needs a "key" (letters, digits, underscores)`
      const type = (['number', 'color', 'boolean', 'select'] as const).find((t) => t === p.type) ?? 'number'
      const options = list(p.options).map((o) => {
        const v = o as Record<string, unknown>
        return { value: String(v?.value ?? ''), label: (isText(v?.label) ? v.label : String(v?.value ?? '')) as PluginText }
      })
      if (type === 'select' && !options.length) return `params[${j}] is a "select" without "options"`
      const fallback = type === 'number' ? 0 : type === 'boolean' ? false : type === 'color' ? '#ffffff' : options[0]?.value ?? ''
      params.push({
        key: p.key, label: (isText(p.label) ? p.label : p.key) as PluginText, type,
        default: (p.default ?? fallback) as ParamValue,
        ...(typeof p.min === 'number' ? { min: p.min } : {}),
        ...(typeof p.max === 'number' ? { max: p.max } : {}),
        ...(typeof p.step === 'number' ? { step: p.step } : {}),
        ...(typeof p.unit === 'string' ? { unit: p.unit } : {}),
        ...(type === 'select' ? { options } : {})
      })
    }
    return { id: String(x.id), title: x.title as PluginText, target: x.target === 'audio' ? 'audio' : 'video', params }
  })
  if (typeof effects === 'string') return effects
  const panels = items<PluginPanel>('panels', (x) =>
    typeof x.page === 'string' && x.page ? { id: String(x.id), title: x.title as PluginText, page: x.page } : '"page" is missing')
  if (typeof panels === 'string') return panels
  return {
    id: r.id,
    name: r.name as PluginText,
    version: typeof r.version === 'string' ? r.version : '0.0.0',
    ...(isText(r.description) ? { description: r.description } : {}),
    ...(typeof r.author === 'string' ? { author: r.author } : {}),
    apiVersion,
    ...(typeof r.main === 'string' ? { main: r.main } : {}),
    ...(command ? { command } : {}),
    conflicts: list(r.conflicts).map(String),
    commands, importers, exporters, effects, panels
  }
}

/** How a plugin is started. */
export type PluginRuntime =
  | { kind: 'node'; file: string }
  | { kind: 'python'; file: string }
  | { kind: 'lua'; file: string }
  | { kind: 'command'; command: string[] }

/**
 * JavaScript and TypeScript run on the Node.js inside ClipWorld (nothing to install); Python and Lua on
 * the interpreter installed on the computer; anything else through "command".
 */
export function pluginRuntime(m: PluginManifest): PluginRuntime | null {
  if (m.command?.length) return { kind: 'command', command: m.command }
  const file = m.main ?? ''
  if (/\.(m|c)?(js|ts)$/i.test(file)) return { kind: 'node', file }
  if (/\.pyw?$/i.test(file)) return { kind: 'python', file }
  if (/\.lua$/i.test(file)) return { kind: 'lua', file }
  return null
}

/** The command lines to try for an interpreter, in order (the first one found on the computer is used). */
export function interpreterCandidates(kind: 'python' | 'lua', platform: string): string[][] {
  if (kind === 'python') return platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
  return [['lua'], ['lua5.4'], ['lua54'], ['lua5.3'], ['lua53']]
}

// ---------------------------------------------------------------- ids of what plugins add

/** The effect type a plugin effect gets in projects. */
export const pluginEffectType = (pluginId: string, effectId: string): string => `plugin:${pluginId}/${effectId}`

export function parsePluginEffectType(type: string): { pluginId: string; effectId: string } | null {
  const m = /^plugin:([^/]+)\/(.+)$/.exec(type)
  return m ? { pluginId: m[1], effectId: m[2] } : null
}

/** The shortcut / action id a plugin command gets. */
export const pluginCommandId = (pluginId: string, commandId: string): string => `plugin:${pluginId}/${commandId}`

/** The effect definitions plugins add, in the form the effects list uses. */
export function pluginEffectDefs(plugins: { manifest: PluginManifest }[], lang = 'en'): EffectDef[] {
  return plugins.flatMap(({ manifest }) =>
    manifest.effects.map((fx): EffectDef => ({
      type: pluginEffectType(manifest.id, fx.id),
      target: fx.target,
      group: 'Plugins',
      kind: 'plugin',
      params: fx.params.map((p): ParamDef => ({
        key: p.key, type: p.type, default: p.default,
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        ...(p.step !== undefined ? { step: p.step } : {}),
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.options ? { options: p.options.map((o) => ({ value: o.value })) } : {})
      })),
      labels: {
        name: pluginText(fx.title, lang),
        params: Object.fromEntries(fx.params.map((p) => [p.key, pluginText(p.label, lang)])),
        options: Object.fromEntries(fx.params.map((p) => [p.key, Object.fromEntries((p.options ?? []).map((o) => [o.value, pluginText(o.label, lang)]))]))
      }
    }))
  )
}

// ---------------------------------------------------------------- conflicts

export interface PluginConflict {
  /** The plugin that is on and may break. */
  id: string
  /** Why: one of the plugins says so, or both want the same shortcut or file type. */
  reason: 'declared' | 'shortcut' | 'importer'
  /** The shortcut or file extension they share. */
  detail?: string
}

/**
 * Plugins that are on now and could break if `plugin` is turned on too: either one lists the other under
 * "conflicts", or both claim the same keyboard shortcut or the same file type to import (only one of
 * them could get it). `shortcutOf` gives a command's current shortcut, after the user's changes.
 */
export function findConflicts(
  plugin: PluginManifest,
  enabled: PluginManifest[],
  shortcutOf: (pluginId: string, command: PluginCommand) => string = (_p, c) => c.shortcut ?? ''
): PluginConflict[] {
  const out: PluginConflict[] = []
  const mine = {
    keys: new Set(plugin.commands.map((c) => shortcutOf(plugin.id, c).toLowerCase()).filter(Boolean)),
    exts: new Set(plugin.importers.flatMap((i) => i.extensions))
  }
  for (const other of enabled) {
    if (other.id === plugin.id) continue
    if (plugin.conflicts.includes(other.id) || other.conflicts.includes(plugin.id)) {
      out.push({ id: other.id, reason: 'declared' })
      continue
    }
    const key = other.commands.map((c) => shortcutOf(other.id, c)).find((k) => k && mine.keys.has(k.toLowerCase()))
    if (key) {
      out.push({ id: other.id, reason: 'shortcut', detail: key })
      continue
    }
    const shared = other.importers.flatMap((i) => i.extensions).find((e) => mine.exts.has(e))
    if (shared) out.push({ id: other.id, reason: 'importer', detail: shared })
  }
  return out
}

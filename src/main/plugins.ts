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

// The plugin host: finds plugins (Documents/ClipWorld/Plugins, plus folders loaded in place), starts the
// ones that are on, installs and removes them, and connects them to the window: plugins' requests about
// the project go to the window, which owns it, and its answers come back.
import { type BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { openPromise } from 'yauzl'
import { EFFECT_MAP, setPluginEffects } from '@shared/effects'
import { t } from '@shared/i18n'
import type { PluginInstallReply, PluginList } from '@shared/ipc'
import { REF_HEIGHT, type Project } from '@shared/model'
import {
  type BrokenPlugin, type PluginInfo, type PluginManifest, parseManifest, parsePluginEffectType, pluginEffectDefs, pluginText
} from '@shared/plugins'
import { spawn } from 'node:child_process'
import { getFfmpegPaths, hasFfmpeg } from './ffmpeg'
import { PluginProcess, launchSpec } from './pluginProcess'
import { flushSettings, loadSettings, saveSettings } from './settings'

interface Entry {
  info: PluginInfo
  proc: PluginProcess | null
}

const plugins = new Map<string, Entry>()
let broken: BrokenPlugin[] = []
let getWin: () => BrowserWindow | null = () => null
let pickAnswer: (kind: 'open' | 'save') => string[] | string | null | undefined = () => undefined

/** Where installed plugins live: Documents/ClipWorld/Plugins. */
export function pluginsFolder(): string {
  return join(app.getPath('documents'), 'ClipWorld', 'Plugins')
}

/** Folders of plugins loaded where they are (a developer's), from Settings and CW_PLUGIN_DIRS. */
function linkedFolders(): string[] {
  const env = (process.env['CW_PLUGIN_DIRS'] ?? '').split(delimiter).filter(Boolean)
  return [...(loadSettings().pluginFolders ?? []), ...env]
}

function readManifest(dir: string): PluginManifest | string {
  try {
    return parseManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')))
  } catch (err) {
    return `plugin.json could not be read: ${(err as Error).message}`
  }
}

/** Looks for plugins again. Running plugins that are still there keep running. */
function scan(): void {
  broken = []
  const enabled = new Set(loadSettings().enabledPlugins ?? [])
  const dirs: { dir: string; installed: boolean }[] = []
  const root = pluginsFolder()
  try {
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      if (!name.startsWith('.') && existsSync(join(dir, 'plugin.json'))) dirs.push({ dir, installed: true })
    }
  } catch {
    /* no Plugins folder yet */
  }
  for (const dir of linkedFolders()) {
    // A linked folder may hold one plugin, or several in subfolders (like the examples).
    if (existsSync(join(dir, 'plugin.json'))) dirs.push({ dir, installed: false })
    else {
      try {
        for (const name of readdirSync(dir)) if (existsSync(join(dir, name, 'plugin.json'))) dirs.push({ dir: join(dir, name), installed: false })
      } catch {
        broken.push({ dir, error: 'Folder not found' })
      }
    }
  }
  const seen = new Map<string, Entry>()
  for (const { dir, installed } of dirs) {
    const manifest = readManifest(dir)
    if (typeof manifest === 'string') {
      broken.push({ dir, error: manifest })
      continue
    }
    if (seen.has(manifest.id)) {
      broken.push({ dir, error: `Another plugin has the same id "${manifest.id}": ${seen.get(manifest.id)!.info.dir}` })
      continue
    }
    const old = plugins.get(manifest.id)
    const same = old && resolve(old.info.dir) === resolve(dir)
    seen.set(manifest.id, {
      info: { dir, installed, manifest, enabled: enabled.has(manifest.id), state: same ? old.info.state : 'off', ...(same && old.info.error ? { error: old.info.error } : {}) },
      proc: same ? old.proc : null
    })
  }
  for (const [id, old] of plugins) {
    const now = seen.get(id)
    if (!now || resolve(now.info.dir) !== resolve(old.info.dir)) void old.proc?.stop()
  }
  plugins.clear()
  for (const [id, e] of seen) plugins.set(id, e)
  syncEffects()
}

/** The effects of the plugins that are on, known here too, since the export is put together here. */
function syncEffects(): void {
  setPluginEffects(pluginEffectDefs([...plugins.values()].filter((e) => e.info.enabled).map((e) => e.info)))
}

export function listPlugins(): PluginList {
  return { plugins: [...plugins.values()].map((e) => ({ ...e.info })), broken, folder: pluginsFolder() }
}

function changed(): void {
  getWin()?.webContents.send('plugins:changed', listPlugins())
}

/** The Node.js plugins run on: the one inside ClipWorld. */
const node = () => ({ cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })

async function start(id: string): Promise<void> {
  const e = plugins.get(id)
  if (!e || e.proc?.running) return
  const spec = launchSpec(e.info.manifest, e.info.dir, node())
  if ('error' in spec) {
    e.info.state = 'error'
    e.info.error = spec.error
    changed()
    return
  }
  e.info.state = 'starting'
  delete e.info.error
  changed()
  const proc = new PluginProcess(id, e.info.dir, spec, {
    request: (pluginId, method, params) => handleRequest(pluginId, method, params),
    notify: (pluginId, method, params) => {
      if (method === 'postToPanel') getWin()?.webContents.send('plugins:panel', pluginId, params)
      else void handleRequest(pluginId, method, params).catch(() => {})
    },
    exited: (pluginId, message) => {
      const cur = plugins.get(pluginId)
      if (!cur || cur.proc !== proc) return
      cur.info.state = 'error'
      cur.info.error = message
      cur.proc = null
      changed()
    }
  })
  e.proc = proc
  try {
    await proc.start({ version: app.getVersion(), language: loadSettings().language ?? 'system' })
    if (e.proc === proc) e.info.state = 'running'
  } catch (err) {
    if (e.proc === proc) {
      const last = proc.log.slice(-3).join(' · ')
      e.info.state = 'error'
      e.info.error = `${(err as Error).message}${last ? `: ${last}` : ''}`
      e.proc = null
      void proc.stop()
    }
  }
  changed()
}

async function stop(id: string): Promise<void> {
  const e = plugins.get(id)
  if (!e) return
  const proc = e.proc
  e.proc = null
  e.info.state = 'off'
  delete e.info.error
  await proc?.stop()
}

export async function setPluginsEnabled(changes: { id: string; on: boolean }[]): Promise<PluginList> {
  const enabled = new Set(loadSettings().enabledPlugins ?? [])
  for (const { id, on } of changes) {
    if (on) enabled.add(id)
    else enabled.delete(id)
    const e = plugins.get(id)
    if (e) e.info.enabled = on
  }
  // Saved right away: which programs may run is not something to lose.
  saveSettings({ enabledPlugins: [...enabled] })
  flushSettings()
  syncEffects()
  for (const { id, on } of changes) if (!on) await stop(id)
  changed()
  await Promise.all(changes.filter((c) => c.on).map((c) => start(c.id)))
  return listPlugins()
}

/** Asks a running plugin something; fails with a message for the user when it isn't running. */
export function invokePlugin(id: string, method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
  const e = plugins.get(id)
  if (!e?.proc?.running) {
    const name = e ? pluginText(e.info.manifest.name, loadSettings().language) : id
    return Promise.reject(new Error(t('plugins.notRunning', { name })))
  }
  return e.proc.request(method, params, timeoutMs)
}

export function notifyPlugin(id: string, method: string, params: unknown): void {
  plugins.get(id)?.proc?.notify(method, params)
}

/** A running plugin's folder (for its windows' files). */
export function runningPluginFolder(id: string): string | null {
  const e = plugins.get(id)
  return e?.info.enabled ? e.info.dir : null
}

export function pluginLog(id: string): string[] {
  return plugins.get(id)?.proc?.log.slice() ?? []
}

// ---------------------------------------------------------------- requests from plugins

let nextReq = 1
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** What plugins can ask. Questions about the project are answered by the window (state/plugins.ts). */
async function handleRequest(pluginId: string, method: string, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'getAppInfo': {
      const ff = hasFfmpeg() ? getFfmpegPaths() : null
      return {
        name: 'ClipWorld', version: app.getVersion(), language: loadSettings().language ?? 'system', platform: process.platform,
        ffmpeg: ff?.ffmpeg ?? null, ffprobe: ff?.ffprobe ?? null, pluginDir: plugins.get(pluginId)?.info.dir ?? null,
        dataDir: join(app.getPath('userData'), 'plugin-data', pluginId)
      }
    }
    case 'pickFile': {
      const test = pickAnswer(p.save ? 'save' : 'open')
      if (test !== undefined) return (Array.isArray(test) ? test[0] : test) ?? null
      const filters = Array.isArray(p.filters) ? (p.filters as { name: string; extensions: string[] }[]) : undefined
      const win = getWin()!
      if (p.save) {
        const r = await dialog.showSaveDialog(win, { title: p.title as string | undefined, defaultPath: p.defaultName as string | undefined, filters })
        return r.canceled ? null : (r.filePath ?? null)
      }
      const r = await dialog.showOpenDialog(win, { title: p.title as string | undefined, properties: ['openFile'], filters })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    }
    default: {
      const win = getWin()
      if (!win) throw new Error('ClipWorld has no window open')
      const id = nextReq++
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        win.webContents.send('plugins:request', id, pluginId, method, params ?? {})
      })
    }
  }
}

// ---------------------------------------------------------------- export: plugin effects' filters

/**
 * The ffmpeg filter each plugin effect in the project uses for the export, by effect id. Fails, naming
 * the plugin, when an effect's plugin isn't running.
 */
export async function pluginFiltersFor(project: Project, size: { width: number; height: number; fps: number }): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const c of project.clips) {
    for (const e of c.effects) {
      const ref = parsePluginEffectType(e.type)
      if (!e.enabled || !ref) continue
      const def = EFFECT_MAP[e.type]
      const entry = plugins.get(ref.pluginId)
      if (!def || !entry?.proc?.running) {
        throw new Error(t('plugins.effectNeedsPlugin', { name: entry ? pluginText(entry.info.manifest.name, loadSettings().language) : ref.pluginId }))
      }
      const r = (await entry.proc.request('effectFilter', {
        effect: ref.effectId, params: e.params, target: def.target, width: size.width, height: size.height, fps: size.fps,
        scale: size.height / REF_HEIGHT, duration: c.duration, preview: false
      }, 20000)) as { filter?: string } | string | null
      const filter = typeof r === 'string' ? r : r?.filter
      if (filter && filter.trim()) out[e.id] = filter.trim()
    }
  }
  return out
}

/**
 * The preview of a plugin's picture effect: the layer as it is before the effect (a PNG), run through the
 * plugin's filter by ffmpeg, as a PNG of the same size. Null when the plugin gives no filter.
 */
export async function pluginPreviewFrame(req: {
  type: string; params: Record<string, unknown>; png: Uint8Array; width: number; height: number; scale: number; fps: number; duration: number
}): Promise<Uint8Array | null> {
  const ref = parsePluginEffectType(req.type)
  const entry = ref && plugins.get(ref.pluginId)
  if (!ref || !entry?.proc?.running) return null
  const r = (await entry.proc.request('effectFilter', {
    effect: ref.effectId, params: req.params, target: 'video', width: req.width, height: req.height, fps: req.fps, scale: req.scale,
    duration: req.duration, preview: true
  }, 10000)) as { filter?: string } | string | null
  const filter = (typeof r === 'string' ? r : r?.filter)?.trim()
  if (!filter) return null
  const vf = `format=rgba,${filter},scale=${req.width}:${req.height}:flags=bicubic,format=rgba`
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-f', 'png_pipe', '-i', '-', '-vf', vf, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']
    const ff = spawn(getFfmpegPaths().ffmpeg, args, { windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    ff.stdout.on('data', (c: Buffer) => out.push(c))
    ff.stderr.on('data', (c: Buffer) => (err += c.toString()))
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exit ${code}`))))
    ff.stdin.on('error', () => {})
    ff.stdin.end(Buffer.from(req.png))
  })
}

// ---------------------------------------------------------------- install and remove

/** Unpacks a zip into `dest`, keeping its folders but nothing that would land outside `dest`. */
async function unzip(file: string, dest: string): Promise<void> {
  const zip = await openPromise(file, { lazyEntries: true, autoClose: false })
  try {
    const root = resolve(dest) + sep
    for await (const entry of zip.eachEntry()) {
      const target = resolve(dest, entry.fileName)
      if (!target.startsWith(root) && target !== resolve(dest)) continue
      if (entry.fileName.endsWith('/')) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(target))
    }
  } finally {
    zip.close()
  }
}

/** Installs a plugin from a zip (copied into the Plugins folder), or loads one from its folder via its plugin.json. */
export async function installPlugin(file: string): Promise<PluginInstallReply> {
  if (/plugin\.json$/i.test(basename(file))) {
    const dir = dirname(file)
    const manifest = readManifest(dir)
    if (typeof manifest === 'string') return { error: manifest }
    const other = plugins.get(manifest.id)
    if (other && resolve(other.info.dir) !== resolve(dir)) return { error: t('plugins.sameId', { dir: other.info.dir }) }
    const folders = loadSettings().pluginFolders ?? []
    if (!folders.some((f) => resolve(f) === resolve(dir))) saveSettings({ pluginFolders: [...folders, dir] })
    scan()
    changed()
    return { id: manifest.id }
  }
  const root = pluginsFolder()
  mkdirSync(root, { recursive: true })
  const tmp = join(root, `.installing-${Date.now()}`)
  try {
    await unzip(file, tmp)
    // plugin.json at the top, or in the one folder the zip holds.
    let dir = tmp
    if (!existsSync(join(dir, 'plugin.json'))) {
      const inner = readdirSync(tmp).filter((n) => statSync(join(tmp, n)).isDirectory())
      if (inner.length === 1 && existsSync(join(tmp, inner[0], 'plugin.json'))) dir = join(tmp, inner[0])
      else return { error: t('plugins.noManifest') }
    }
    const manifest = readManifest(dir)
    if (typeof manifest === 'string') return { error: manifest }
    const existing = plugins.get(manifest.id)
    if (existing && !existing.info.installed) return { error: t('plugins.sameId', { dir: existing.info.dir }) }
    const target = join(root, manifest.id)
    // Installing a plugin again updates it: the old copy goes to the Recycle Bin / Trash.
    const wasOn = !!existing?.info.enabled
    if (existing) await stop(manifest.id)
    if (existsSync(target)) await shell.trashItem(target).catch(() => rmSync(target, { recursive: true, force: true }))
    renameSync(dir, target)
    scan()
    if (wasOn) await start(manifest.id)
    changed()
    return { id: manifest.id, updated: !!existing }
  } catch (err) {
    return { error: (err as Error).message }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Removes a plugin: an installed one goes to the Recycle Bin / Trash, a loaded folder is only forgotten. */
export async function removePlugin(id: string): Promise<PluginList> {
  const e = plugins.get(id)
  if (!e) return listPlugins()
  await setPluginsEnabled([{ id, on: false }])
  if (e.info.installed) await shell.trashItem(e.info.dir).catch(() => rmSync(e.info.dir, { recursive: true, force: true }))
  else saveSettings({ pluginFolders: (loadSettings().pluginFolders ?? []).filter((f) => resolve(f) !== resolve(e.info.dir)) })
  scan()
  changed()
  return listPlugins()
}

// ---------------------------------------------------------------- set-up

export function registerPluginIpc(win: () => BrowserWindow | null, testDialog: typeof pickAnswer): void {
  getWin = win
  pickAnswer = testDialog
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:rescan', () => {
    scan()
    for (const e of plugins.values()) if (e.info.enabled && !e.proc) void start(e.info.manifest.id)
    return listPlugins()
  })
  ipcMain.handle('plugins:set-enabled', (_e, changes: { id: string; on: boolean }[]) => setPluginsEnabled(changes))
  ipcMain.handle('plugins:restart', async (_e, id: string) => {
    await stop(id)
    scan()
    await start(id)
    return listPlugins()
  })
  ipcMain.handle('plugins:log', (_e, id: string) => pluginLog(id))
  ipcMain.handle('plugins:remove', (_e, id: string) => removePlugin(id))
  ipcMain.handle('plugins:open-folder', () => {
    mkdirSync(pluginsFolder(), { recursive: true })
    return shell.openPath(pluginsFolder())
  })
  ipcMain.handle('plugins:install', async () => {
    const test = pickAnswer('open')
    let file: string | undefined
    if (test !== undefined) file = (Array.isArray(test) ? test[0] : test) ?? undefined
    else {
      const r = await dialog.showOpenDialog(getWin()!, {
        title: t('dialogs.installPlugin'),
        properties: ['openFile'],
        filters: [{ name: t('dialogs.pluginFiles'), extensions: ['zip', 'json'] }]
      })
      file = r.canceled ? undefined : r.filePaths[0]
    }
    if (!file) return { canceled: true }
    return installPlugin(file)
  })
  // The window asks a plugin to do something (run a command, import, export, give a filter…).
  ipcMain.handle('plugins:invoke', async (_e, id: string, method: string, params: unknown, timeoutMs?: number) => {
    try {
      return { result: await invokePlugin(id, method, params, timeoutMs ?? 0) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })
  ipcMain.handle('plugins:preview-frame', async (_e, req: Parameters<typeof pluginPreviewFrame>[0]) => {
    try {
      return { png: await pluginPreviewFrame(req) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })
  ipcMain.on('plugins:notify', (_e, id: string, method: string, params: unknown) => notifyPlugin(id, method, params))
  // The window's answer to a plugin's request.
  ipcMain.on('plugins:reply', (_e, reqId: number, ok: boolean, value: unknown) => {
    const w = waiting.get(reqId)
    if (!w) return
    waiting.delete(reqId)
    if (ok) w.resolve(value)
    else w.reject(new Error(String(value)))
  })
  ipcMain.handle('plugins:save-dialog', async (_e, title: string, defaultName: string, ext: string, label: string) => {
    const test = pickAnswer('save')
    if (test !== undefined) return (test as string | null) ?? null
    const r = await dialog.showSaveDialog(getWin()!, {
      title, defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: label, extensions: [ext] }]
    })
    return r.canceled ? null : (r.filePath ?? null)
  })
  ipcMain.handle('plugins:open-dialog', async (_e, title: string, exts: string[], label: string) => {
    const test = pickAnswer('open')
    if (test !== undefined) return (Array.isArray(test) ? test : test ? [test] : []) as string[]
    const r = await dialog.showOpenDialog(getWin()!, { title, properties: ['openFile', 'multiSelections'], filters: [{ name: label, extensions: exts }] })
    return r.canceled ? [] : r.filePaths
  })
  scan()
}

/** Starts the plugins that are on (after the window has loaded). */
export function startEnabledPlugins(): void {
  for (const e of plugins.values()) if (e.info.enabled) void start(e.info.manifest.id)
}

export async function stopAllPlugins(): Promise<void> {
  for (const w of waiting.values()) w.reject(new Error('ClipWorld is closing'))
  waiting.clear()
  await Promise.all([...plugins.keys()].map((id) => stop(id)))
}

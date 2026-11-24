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

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '@shared/ipc'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  getInfo: () => ipcRenderer.invoke('app:info'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  pickMedia: () => ipcRenderer.invoke('media:pick'),
  importMedia: (paths) => ipcRenderer.invoke('media:import', paths),
  prepareMedia: (items) => ipcRenderer.invoke('media:prepare', items),
  requestProxy: (id) => ipcRenderer.invoke('media:proxy', id),
  proxyFocus: (id, t) => ipcRenderer.send('media:focus', id, t),
  reverseFocus: (id, ranges, t) => ipcRenderer.send('media:reverse', id, ranges, t),
  setFastSeek: (id, on) => ipcRenderer.invoke('media:fast-seek', id, on),
  convertToMp4: (id) => ipcRenderer.invoke('media:convert', id),
  cancelConvert: (id) => ipcRenderer.invoke('media:convert-cancel', id),
  relinkMedia: (item) => ipcRenderer.invoke('media:relink', item),
  onMediaCache: (cb) => on('media:cache', cb),
  pathForFile: (file) => webUtils.getPathForFile(file),

  listFonts: () => ipcRenderer.invoke('fonts:list'),

  listPresets: () => ipcRenderer.invoke('presets:list'),
  savePreset: (preset) => ipcRenderer.invoke('presets:save', preset),
  deletePreset: (id) => ipcRenderer.invoke('presets:delete', id),
  exportPreset: (preset, include) => ipcRenderer.invoke('presets:export', preset, include),
  importPreset: () => ipcRenderer.invoke('presets:import'),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  rescanPlugins: () => ipcRenderer.invoke('plugins:rescan'),
  setPluginsEnabled: (changes) => ipcRenderer.invoke('plugins:set-enabled', changes),
  restartPlugin: (id) => ipcRenderer.invoke('plugins:restart', id),
  pluginLog: (id) => ipcRenderer.invoke('plugins:log', id),
  removePlugin: (id) => ipcRenderer.invoke('plugins:remove', id),
  openPluginsFolder: () => ipcRenderer.invoke('plugins:open-folder'),
  installPlugin: () => ipcRenderer.invoke('plugins:install'),
  invokePlugin: (id, method, params, timeoutMs) => ipcRenderer.invoke('plugins:invoke', id, method, params, timeoutMs),
  notifyPlugin: (id, method, params) => ipcRenderer.send('plugins:notify', id, method, params),
  replyToPlugin: (reqId, ok, value) => ipcRenderer.send('plugins:reply', reqId, ok, value),
  pluginPreviewFrame: (req) => ipcRenderer.invoke('plugins:preview-frame', req),
  pluginSaveDialog: (title, defaultName, ext, label) => ipcRenderer.invoke('plugins:save-dialog', title, defaultName, ext, label),
  pluginOpenDialog: (title, exts, label) => ipcRenderer.invoke('plugins:open-dialog', title, exts, label),
  onPluginsChanged: (cb) => on('plugins:changed', cb),
  onPluginRequest: (cb) => on('plugins:request', cb),
  onPluginPanel: (cb) => on('plugins:panel', cb),
  filesExist: (paths) => ipcRenderer.invoke('files:exist', paths),

  pickSubtitleFiles: () => ipcRenderer.invoke('subtitles:pick'),
  readSubtitleFile: (path, fps) => ipcRenderer.invoke('subtitles:read', path, fps),
  listSubtitleStreams: (path) => ipcRenderer.invoke('subtitles:streams', path),
  extractSubtitleStream: (path, index) => ipcRenderer.invoke('subtitles:extract', path, index),
  saveSubtitleFile: (name, ext, label, content) => ipcRenderer.invoke('subtitles:save', name, ext, label, content),

  openProject: (path) => ipcRenderer.invoke('project:open', path),
  saveProject: (path, project, saveAsFrom) => ipcRenderer.invoke('project:save', path, project, saveAsFrom),
  writeRecovery: (data) => ipcRenderer.invoke('project:recovery', data),
  onOpenPath: (cb) => on('app:open-path', cb),

  pickExportPath: (name, ext, label) => ipcRenderer.invoke('export:pick', name, ext, label),
  startExport: (req) => ipcRenderer.invoke('export:start', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => on('export:progress', cb),
  showInFolder: (path) => ipcRenderer.invoke('shell:show', path),

  voiceoverBegin: (projectPath, rate) => ipcRenderer.invoke('voiceover:begin', projectPath, rate),
  voiceoverWrite: (id, samples) => ipcRenderer.invoke('voiceover:write', id, samples),
  voiceoverEnd: (id, rate) => ipcRenderer.invoke('voiceover:end', id, rate),
  voiceoverDiscard: (id) => ipcRenderer.invoke('voiceover:discard', id),
  voiceoverRemove: (path) => ipcRenderer.invoke('voiceover:remove', path),

  setWindowState: (state) => ipcRenderer.send('window:state', state),
  onCloseRequest: (cb) => on('app:close-request', cb),
  confirmClose: () => ipcRenderer.send('window:confirm-close'),
  toggleDevTools: () => ipcRenderer.send('window:devtools')
}

contextBridge.exposeInMainWorld('cw', api)

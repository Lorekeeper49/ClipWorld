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
  filesExist: (paths) => ipcRenderer.invoke('files:exist', paths),

  pickSubtitleFiles: () => ipcRenderer.invoke('subtitles:pick'),
  readSubtitleFile: (path, fps) => ipcRenderer.invoke('subtitles:read', path, fps),
  listSubtitleStreams: (path) => ipcRenderer.invoke('subtitles:streams', path),
  extractSubtitleStream: (path, index) => ipcRenderer.invoke('subtitles:extract', path, index),
  saveSubtitleFile: (name, ext, label, content) => ipcRenderer.invoke('subtitles:save', name, ext, label, content),

  openProject: (path) => ipcRenderer.invoke('project:open', path),
  saveProject: (path, project) => ipcRenderer.invoke('project:save', path, project),
  writeRecovery: (data) => ipcRenderer.invoke('project:recovery', data),
  onOpenPath: (cb) => on('app:open-path', cb),

  pickExportPath: (name, ext, label) => ipcRenderer.invoke('export:pick', name, ext, label),
  startExport: (req) => ipcRenderer.invoke('export:start', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => on('export:progress', cb),
  showInFolder: (path) => ipcRenderer.invoke('shell:show', path),

  setWindowState: (state) => ipcRenderer.send('window:state', state),
  onCloseRequest: (cb) => on('app:close-request', cb),
  confirmClose: () => ipcRenderer.send('window:confirm-close'),
  toggleDevTools: () => ipcRenderer.send('window:devtools')
}

contextBridge.exposeInMainWorld('cw', api)

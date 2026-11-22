import { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Caps } from '@shared/filtergraph'
import type { AppInfo, ExportRequest, ExportResult, OpenedProject, Recovery } from '@shared/ipc'
import { type MediaItem, PROJECT_EXT, type Project, parseProject } from '@shared/model'
import { runExport } from './export'
import { type FfmpegPaths, findFfmpeg, run, setFfmpegPaths, usableCapabilities, vendorDirs } from './ffmpeg'
import {
  cancelConvert, convertToMp4, initMediaCache, prepareMedia, requestProxy, setChunkEncoders, setFastSeek, setProxyFocus, setReverseWanted,
  stopBackgroundWork
} from './media'
import { probeMedia } from './probe'
import { beginTake, discardTake, endTake, removeTakeFile, voiceoverFolder, writeTake } from './voiceover'
import { extractSubtitleStream, listSubtitleStreams, readSubtitleFile } from './subtitles'
import { SUBTITLE_IMPORT_EXTS } from '@shared/subtitles'
import { allowFile, handleProtocol, registerScheme } from './protocol'
import { addRecent, flushSettings, loadSettings, saveSettings } from './settings'
import { deletePreset, listPresets, savePreset } from './presets'
import { resolveLanguage, setLanguage, t } from '@shared/i18n'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
let win: BrowserWindow | null = null
let dirty = false
let closeConfirmed = false
let ffmpegVersion: string | null = null
let caps: Caps = { encoders: [], filters: [] }
let exportAbort: AbortController | null = null

registerScheme()

// ---------------------------------------------------------------- test hook
// End-to-end tests cannot click native dialogs; they supply answers through a JSON file instead.
function testDialogAnswer(kind: 'open' | 'save'): string[] | string | null | undefined {
  const file = process.env['CW_E2E_DIALOGS']
  if (!file) return undefined
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown[]>
    const answer = (data[kind] ?? []).shift()
    writeFileSync(file, JSON.stringify(data))
    return (answer ?? null) as string[] | string | null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- ffmpeg discovery

async function verify(p: FfmpegPaths): Promise<string | null> {
  try {
    const r = await run(p.ffmpeg, ['-version'])
    const version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1]
    const year = Number(/Copyright \(c\) \d{4}-(\d{4})/.exec(r.stdout)?.[1] ?? 0)
    // Old builds lack filters and options this app relies on.
    if (!version || year < 2023) return null
    return version
  } catch {
    return null
  }
}

async function locateFfmpeg(): Promise<void> {
  const dirs = [
    loadSettings().ffmpegDir ?? '',
    join(process.resourcesPath ?? '', 'ffmpeg'),
    ...vendorDirs(app.getAppPath()),
    ...vendorDirs(process.cwd()),
    // Linux/macOS package managers put ffmpeg on the PATH (also covered below); listed for GUI launches
    // whose PATH lacks them.
    ...(process.platform === 'win32' ? [] : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin']),
    ...(process.env['PATH'] ?? '').split(delimiter)
  ]
  for (const dir of dirs) {
    const found = findFfmpeg([dir])
    if (!found) continue
    const version = await verify(found)
    if (version) {
      setFfmpegPaths(found)
      ffmpegVersion = version
      caps = await usableCapabilities()
      setChunkEncoders(caps.encoders)
      return
    }
  }
  setFfmpegPaths(null)
  ffmpegVersion = null
}

// ---------------------------------------------------------------- project files

const recoveryFile = () => join(app.getPath('userData'), `recovery.${PROJECT_EXT}`)

function readProjectFile(path: string): OpenedProject {
  const project = parseProject(JSON.parse(readFileSync(path, 'utf8')))
  const dir = dirname(path)
  for (const m of project.media) {
    // Projects that were moved together with their media are found through the relative path.
    if (!existsSync(m.path) && m.relPath) {
      const candidate = resolve(dir, m.relPath)
      if (existsSync(candidate)) m.path = candidate
    }
  }
  return { path, project }
}

function writeProjectFile(path: string, project: Project): void {
  const dir = dirname(path)
  const out: Project = {
    ...project,
    media: project.media.map((m) => {
      const rel = relative(dir, m.path)
      return { ...m, relPath: isAbsolute(rel) ? undefined : rel.replace(/\\/g, '/') }
    })
  }
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8')
  renameSync(tmp, path)
}

function projectPathFromArgv(argv: string[]): string | null {
  const p = argv.slice(1).find((a) => a.toLowerCase().endsWith('.' + PROJECT_EXT) && existsSync(a))
  return p ? resolve(p) : null
}

// ---------------------------------------------------------------- fonts

let fontCache: Promise<string[]> | null = null

function listFonts(): Promise<string[]> {
  if (fontCache) return fontCache
  fontCache = new Promise((res) => {
    const done = (out: string) =>
      res([...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
    if (process.platform === 'win32') {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Drawing; [Console]::OutputEncoding=[Text.Encoding]::UTF8; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'],
        { windowsHide: true, maxBuffer: 8 << 20 },
        (err, stdout) => done(err ? '' : stdout)
      )
    } else if (process.platform === 'darwin') {
      execFile('system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 64 << 20 }, (err, stdout) => {
        if (err) return done('')
        try {
          const fams = (JSON.parse(stdout).SPFontsDataType as any[]).flatMap((f) => (f.typefaces ?? []).map((t: any) => t.family))
          done(fams.join('\n'))
        } catch {
          done('')
        }
      })
    } else {
      // fc-list prints "Family,Localized family" and backslash-escapes '-', ',' and ':' inside names.
      execFile('fc-list', [':', 'family'], { maxBuffer: 8 << 20 }, (err, stdout) =>
        done(err ? '' : stdout.split(/\r?\n/).map((l) => (l.split(/(?<!\\),/)[0] ?? '').replace(/\\(.)/g, '$1')).join('\n'))
      )
    }
  })
  return fontCache
}

// ---------------------------------------------------------------- window

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#15171c',
    title: 'ClipWorld',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => {
    win?.maximize()
    win?.show()
  })
  win.on('close', (e) => {
    if (dirty && !closeConfirmed) {
      e.preventDefault()
      win?.webContents.send('app:close-request')
    }
  })
  win.on('closed', () => {
    win = null
  })
  // External links open in the browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDev || !url.startsWith(process.env['ELECTRON_RENDERER_URL']!)) e.preventDefault()
  })
  if (isDev) void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// ---------------------------------------------------------------- IPC

/** Native dialogs and main-process messages follow the language chosen in the app. */
function applyLanguage(): void {
  setLanguage(resolveLanguage(loadSettings().language, app.getPreferredSystemLanguages()))
}

function registerIpc(): void {
  ipcMain.handle('app:info', async (): Promise<AppInfo> => {
    let recovery: Recovery | null = null
    try {
      if (existsSync(recoveryFile())) {
        const raw = JSON.parse(readFileSync(recoveryFile(), 'utf8'))
        recovery = { project: parseProject(raw.project), path: raw.path ?? null }
      }
    } catch {
      recovery = null
    }
    return {
      version: app.getVersion(),
      ffmpegVersion,
      caps,
      settings: loadSettings(),
      openPath: projectPathFromArgv(process.argv),
      recovery,
      isDev,
      systemLanguages: app.getPreferredSystemLanguages()
    }
  })
  ipcMain.handle('settings:save', (_e, patch) => {
    saveSettings(patch)
    if ('language' in patch) applyLanguage()
  })

  ipcMain.handle('media:pick', async () => {
    const test = testDialogAnswer('open')
    if (test !== undefined) return (test as string[] | null) ?? []
    const r = await dialog.showOpenDialog(win!, {
      title: t('dialogs.importMedia'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('dialogs.mediaFiles'), extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'flv', 'wmv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp', 'ogv', 'mxf',
          'mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'ac3',
          'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'tga', 'jfif', 'apng'] },
        { name: t('dialogs.allFiles'), extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('media:import', async (_e, paths: string[]) => {
    const items: MediaItem[] = []
    const errors: string[] = []
    for (const p of paths) {
      try {
        const item = await probeMedia(p)
        items.push(item)
        prepareMedia(item)
      } catch (err) {
        errors.push((err as Error).message.split('\n')[0])
      }
    }
    return { items, errors }
  })
  ipcMain.handle('media:prepare', (_e, items: MediaItem[]) => {
    for (const m of items) prepareMedia(m)
  })
  ipcMain.handle('media:proxy', (_e, id: string) => requestProxy(id))
  ipcMain.on('media:focus', (_e, id: string, t: number) => setProxyFocus(id, t))

  ipcMain.handle('voiceover:begin', (_e, projectPath: string | null, rate: number) =>
    beginTake(voiceoverFolder(projectPath, app.getPath('documents')), rate))
  ipcMain.handle('voiceover:write', (_e, id: string, data: Uint8Array) => writeTake(id, data))
  ipcMain.handle('voiceover:end', (_e, id: string, rate: number) => endTake(id, rate))
  ipcMain.handle('voiceover:discard', (_e, id: string) => discardTake(id))
  ipcMain.handle('voiceover:remove', (_e, path: string) => removeTakeFile(path))
  ipcMain.on('media:reverse', (_e, id: string, ranges: [number, number][], t: number) => setReverseWanted(id, ranges, t))
  ipcMain.handle('media:fast-seek', (_e, id: string, on: boolean) => setFastSeek(id, on))
  ipcMain.handle('media:convert', async (_e, id: string) => {
    const r = await convertToMp4(id, caps.encoders)
    if (r.ok) allowFile(r.path)
    return r
  })
  ipcMain.handle('media:convert-cancel', (_e, id: string) => cancelConvert(id))
  ipcMain.handle('media:relink', async (_e, item: MediaItem) => {
    const r = await dialog.showOpenDialog(win!, {
      title: t('dialogs.locate', { name: item.name }),
      defaultPath: item.path,
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    const fresh = await probeMedia(r.filePaths[0])
    const relinked = { ...fresh, id: item.id }
    prepareMedia(relinked)
    return relinked
  })

  ipcMain.handle('fonts:list', () => listFonts())

  ipcMain.handle('presets:list', () => listPresets())
  ipcMain.handle('presets:save', (_e, preset) => savePreset(preset))
  ipcMain.handle('presets:delete', (_e, id: string) => deletePreset(id))
  ipcMain.handle('files:exist', (_e, paths: string[]) => paths.map((p) => existsSync(p)))

  ipcMain.handle('subtitles:pick', async () => {
    const test = testDialogAnswer('open')
    if (test !== undefined) return (test as string[] | null) ?? []
    const r = await dialog.showOpenDialog(win!, {
      title: t('dialogs.importSubtitles'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('dialogs.subtitleFiles'), extensions: SUBTITLE_IMPORT_EXTS },
        { name: t('dialogs.allFiles'), extensions: ['*'] }
      ]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('subtitles:read', (_e, path: string, fps: number) => readSubtitleFile(path, fps))
  ipcMain.handle('subtitles:streams', (_e, path: string) => listSubtitleStreams(path))
  ipcMain.handle('subtitles:extract', (_e, path: string, index: number) => extractSubtitleStream(path, index))
  ipcMain.handle('subtitles:save', async (_e, name: string, ext: string, label: string, content: string) => {
    let target: string | null
    const test = testDialogAnswer('save')
    if (test !== undefined) target = test as string | null
    else {
      const s = loadSettings()
      const r = await dialog.showSaveDialog(win!, {
        title: t('dialogs.exportSubtitles'),
        defaultPath: join(s.lastExportDir ?? app.getPath('videos'), `${name}.${ext}`),
        filters: [{ name: label, extensions: [ext] }]
      })
      target = r.canceled ? null : (r.filePath ?? null)
      if (target) saveSettings({ lastExportDir: dirname(target) })
    }
    if (!target) return null
    writeFileSync(target, content, 'utf8')
    return target
  })

  ipcMain.handle('project:open', async (_e, path?: string) => {
    let target = path
    if (!target) {
      const test = testDialogAnswer('open')
      if (test !== undefined) target = (test as string | null) ?? undefined
      else {
        const r = await dialog.showOpenDialog(win!, {
          title: t('dialogs.openProject'),
          defaultPath: projectsFolder(),
          properties: ['openFile'],
          filters: [{ name: t('dialogs.projectFiles'), extensions: [PROJECT_EXT] }]
        })
        target = r.canceled ? undefined : r.filePaths[0]
      }
    }
    if (!target) return null
    const opened = readProjectFile(target)
    addRecent(target)
    return opened
  })
  ipcMain.handle('project:save', async (_e, path: string | null, project: Project, saveAsFrom?: string | null) => {
    let target = path
    if (!target) {
      const test = testDialogAnswer('save')
      if (test !== undefined) target = test as string | null
      else {
        const r = await dialog.showSaveDialog(win!, {
          title: t('dialogs.saveProject'),
          // A project that was saved before is saved as next to itself; a new one goes in Documents/ClipWorld/Projects.
          defaultPath: saveAsFrom
            ? join(dirname(saveAsFrom), `${basename(saveAsFrom, extname(saveAsFrom))}.${PROJECT_EXT}`)
            : join(projectsFolder(), `${t('app.untitled')}.${PROJECT_EXT}`),
          filters: [{ name: t('dialogs.projectFiles'), extensions: [PROJECT_EXT] }]
        })
        target = r.canceled ? null : (r.filePath ?? null)
      }
    }
    if (!target) return null
    if (extname(target).toLowerCase() !== '.' + PROJECT_EXT) target += '.' + PROJECT_EXT
    writeProjectFile(target, project)
    addRecent(target)
    return target
  })
  ipcMain.handle('project:recovery', (_e, data: Recovery | null) => {
    try {
      if (data) writeFileSync(recoveryFile(), JSON.stringify(data), 'utf8')
      else rmSync(recoveryFile(), { force: true })
    } catch (err) {
      console.error('recovery write failed', err)
    }
  })

  ipcMain.handle('export:pick', async (_e, name: string, ext: string, label: string) => {
    const test = testDialogAnswer('save')
    if (test !== undefined) return test as string | null
    const s = loadSettings()
    const r = await dialog.showSaveDialog(win!, {
      title: t('dialogs.exportVideo'),
      defaultPath: join(s.lastExportDir ?? app.getPath('videos'), `${name}.${ext}`),
      filters: [{ name: label, extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return null
    saveSettings({ lastExportDir: dirname(r.filePath) })
    return r.filePath
  })
  ipcMain.handle('export:start', async (_e, req: ExportRequest): Promise<ExportResult> => {
    if (exportAbort) return { ok: false, cancelled: false, error: t('errors.exportRunning') }
    exportAbort = new AbortController()
    const tmpDir = join(app.getPath('temp'), `clipworld-export-${Date.now()}`)
    try {
      mkdirSync(tmpDir, { recursive: true })
      const text: Record<string, { path: string; w: number; h: number; k: number }> = {}
      for (const a of req.text) {
        const file = join(tmpDir, `text_${a.id}.png`)
        writeFileSync(file, a.png)
        text[a.id] = { path: file, w: a.w, h: a.h, k: a.k }
      }
      const overlays: Record<string, string> = {}
      for (const a of req.overlays) {
        const file = join(tmpDir, `overlay_${a.id}.png`)
        writeFileSync(file, a.png)
        overlays[a.id] = file
      }
      const subImages: Record<string, string> = {}
      req.subtitleImages.forEach((img, i) => {
        const file = join(tmpDir, `sub_${i}.png`)
        writeFileSync(file, img.png)
        subImages[img.id] = file
      })
      const subtitleClips = req.subtitleClips.map((s) => ({
        ...s,
        gap: subImages[s.gap],
        cues: s.cues.filter((c) => subImages[c.image]).map((c) => ({ ...c, image: subImages[c.image] }))
      }))
      await runExport({
        project: req.project,
        settings: req.settings,
        outPath: req.outPath,
        tmpDir,
        caps,
        assets: { text, overlays },
        subtitleClips,
        signal: exportAbort.signal,
        onProgress: (f) => win?.webContents.send('export:progress', f)
      })
      return { ok: true, outPath: req.outPath }
    } catch (err) {
      const cancelled = !!exportAbort?.signal.aborted
      return { ok: false, cancelled, error: (err as Error).message }
    } finally {
      exportAbort = null
    }
  })
  ipcMain.handle('export:cancel', () => exportAbort?.abort())
  ipcMain.handle('shell:show', (_e, path: string) => shell.showItemInFolder(path))

  ipcMain.on('window:state', (_e, state: { title: string; dirty: boolean }) => {
    dirty = state.dirty
    win?.setTitle(`${state.dirty ? '● ' : ''}${state.title} — ClipWorld`)
  })
  ipcMain.on('window:confirm-close', () => {
    closeConfirmed = true
    win?.close()
  })
  ipcMain.on('window:devtools', () => win?.webContents.toggleDevTools())
}

/** Where projects are saved unless the user picks somewhere else: Documents/ClipWorld/Projects (made when needed). */
function projectsFolder(): string {
  const dir = join(app.getPath('documents'), 'ClipWorld', 'Projects')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return app.getPath('documents')
  }
  return dir
}

// ---------------------------------------------------------------- app lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const p = projectPathFromArgv(argv)
    if (p) win.webContents.send('app:open-path', p)
  })

  void app.whenReady().then(async () => {
    applyLanguage()
    Menu.setApplicationMenu(null)
    handleProtocol()
    initMediaCache(join(app.getPath('userData'), 'cache'), (id, patch) => win?.webContents.send('media:cache', id, patch))
    await locateFfmpeg()
    // The font picker and the media protocol are the only extra capabilities the page needs.
    // The font picker, and the microphone for voiceovers (sound only, never the camera or the screen).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      cb(permission === 'local-fonts' || (permission === 'media' && types.length > 0 && types.every((m) => m === 'audio')))
    })
    registerIpc()
    createWindow()
  })

  app.on('window-all-closed', () => {
    flushSettings()
    stopBackgroundWork()
    app.quit()
  })
}

export { allowFile }

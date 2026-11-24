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

import { useEffect, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MenuBar } from './components/MenuBar'
import { Btn, Modal } from './components/ui'
import { ExportDialog } from './dialogs/ExportDialog'
import { EaseEditor } from './dialogs/EaseEditor'
import { PresetImportDialog } from './dialogs/PresetImportDialog'
import { PresetExportDialog } from './dialogs/PresetExportDialog'
import { loadPresets } from './state/presets'
import { loadPlugins } from './state/plugins'
import { PluginsDialog } from './dialogs/PluginsDialog'
import { PluginFormDialog } from './dialogs/PluginFormDialog'
import { applyClipColors } from './settings/clipColors'
import { SettingsDialog } from './settings/SettingsDialog'
import { applyLanguage, tx, useT } from './i18n'
import { player } from './engine/player'
import { Dock } from './layout/dock'
import { guardUnsaved, initMediaCacheListener, openProjectPath, saveProjectAction } from './state/actions'
import { installShortcuts } from './state/shortcuts'
import { get, loadProject, projectName, set, useStore } from './state/store'

function CloseDialog() {
  const t = useT()
  const pending = useStore((s) => s.pendingAfterClose)
  const name = useStore(projectName)
  const finish = (proceed: boolean) => {
    set({ modal: null, pendingAfterClose: null })
    if (proceed) pending?.()
  }
  return (
    <Modal
      title={t('close.title')}
      width={420}
      onClose={() => finish(false)}
      footer={
        <>
          <Btn onClick={() => finish(false)}>{t('common.cancel')}</Btn>
          <Btn danger onClick={() => { set({ dirty: false }); finish(true) }} testId="discard">{t('close.dontSave')}</Btn>
          <Btn primary onClick={async () => { if (await saveProjectAction()) finish(true) }}>{t('common.save')}</Btn>
        </>
      }
    >
      <p>{t('close.message', { name })}</p>
    </Modal>
  )
}

function AboutDialog() {
  const t = useT()
  const ffmpeg = useStore((s) => s.ffmpegVersion)
  return (
    <Modal title={t('about.title')} width={420} onClose={() => set({ modal: null })} footer={<Btn primary onClick={() => set({ modal: null })}>{t('common.close')}</Btn>}>
      <p>{t('about.tagline')}</p>
      <p className="dim">{ffmpeg ? t('about.ffmpeg', { version: ffmpeg }) : t('app.ffmpegNotFound')}</p>
      <p className="dim">{t('about.projects')}</p>
      {/* The copyright notice stays in English in every language, as the GPL how-to asks. */}
      <p className="small" data-i18n-ignore="" data-testid="about-copyright">Copyright (C) 2026 Lorekeeper49</p>
      <p className="dim small">
        {t('about.license')}{' '}
        <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">{t('about.licenseLink')}</a>
      </p>
      <p className="dim small">
        {t('about.source')}{' '}
        <a href="https://github.com/Lorekeeper49/ClipWorld/releases" target="_blank" rel="noreferrer">{t('about.sourceLink')}</a>
      </p>
    </Modal>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} data-testid="toast">{t.text}</div>)}
    </div>
  )
}

export function App() {
  const [ready, setReady] = useState(false)
  const modal = useStore((s) => s.modal)
  const ffmpeg = useStore((s) => s.ffmpegVersion)
  const t = useT()

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []
    void window.cw.getInfo().then((info) => {
      if (disposed) return
      set({ settings: info.settings, caps: info.caps, ffmpegVersion: info.ffmpegVersion })
      applyLanguage(info.settings.language, info.systemLanguages)
      void loadPresets()
      void loadPlugins()
      // Installed fonts, so new text and subtitles default to one this computer actually has.
      void window.cw.listFonts().then((fonts) => {
        if (fonts.length && !disposed) set({ fonts })
      })
      cleanups.push(initMediaCacheListener(), installShortcuts())
      cleanups.push(window.cw.onCloseRequest(() => guardUnsaved(() => window.cw.confirmClose())))
      cleanups.push(window.cw.onOpenPath((p) => guardUnsaved(() => void openProjectPath(p))))
      setReady(true)
      if (info.openPath) void openProjectPath(info.openPath)
      else if (info.recovery && info.recovery.project.clips.length + info.recovery.project.media.length > 0) {
        // A previous session ended without saving: bring its work back as an unsaved project.
        player.pause()
        loadProject(info.recovery.project, info.recovery.path, true)
        if (info.recovery.project.media.length) void window.cw.prepareMedia(info.recovery.project.media)
        set((s) => ({ toasts: [...s.toasts, { id: -1, kind: 'info', text: t('app.restored') }] }))
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== -1) })), 6000)
      }
    })
    return () => {
      disposed = true
      for (const c of cleanups) c()
    }
  }, [])

  // Clip colors chosen in Settings.
  const settings = useStore((s) => s.settings)
  useEffect(() => applyClipColors(settings), [settings.clipColors]) // eslint-disable-line react-hooks/exhaustive-deps

  // Window title, close guard and crash-recovery autosave follow the project state.
  useEffect(() => {
    if (!ready) return
    const push = () => {
      const s = get()
      window.cw.setWindowState({ title: projectName(s), dirty: s.dirty })
    }
    push()
    let lastSaved = get().project
    const unsub = useStore.subscribe((s, prev) => {
      if (s.dirty !== prev.dirty || s.projectPath !== prev.projectPath) push()
      if (!s.dirty && prev.dirty) void window.cw.writeRecovery(null)
    })
    const timer = setInterval(() => {
      const s = get()
      if (s.dirty && s.project !== lastSaved) {
        lastSaved = s.project
        void window.cw.writeRecovery({ project: s.project, path: s.projectPath })
      }
    }, 15000)
    return () => {
      unsub()
      clearInterval(timer)
    }
  }, [ready])

  if (!ready) return <div className="boot">{t('app.starting')}</div>
  return (
    <div className="app">
      <MenuBar />
      {!ffmpeg && (
        <div className="banner bad">
          {tx('app.noFfmpeg', { command: <code>npm run fetch-ffmpeg</code> })}
        </div>
      )}
      <main className="workspace"><Dock /></main>
      <ErrorBoundary key={modal ?? ''} onReset={() => set({ modal: null })}>
      {modal === 'export' && <ExportDialog />}
      {(modal === 'settings' || modal === 'shortcuts' || modal === 'language') && <SettingsDialog key={modal} />}
      {modal === 'close' && <CloseDialog />}
      {modal === 'about' && <AboutDialog />}
      {modal === 'presetImport' && <PresetImportDialog />}
      {modal === 'presetExport' && <PresetExportDialog />}
      {modal === 'plugins' && <PluginsDialog />}
      {modal === 'pluginForm' && <PluginFormDialog />}
      {modal === 'ease' && <EaseEditor />}
      </ErrorBoundary>
      <Toasts />
    </div>
  )
}

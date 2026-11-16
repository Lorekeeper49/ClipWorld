import { useEffect, useState } from 'react'
import { MenuBar } from './components/MenuBar'
import { Btn, Modal } from './components/ui'
import { ExportDialog } from './dialogs/ExportDialog'
import { ShortcutsDialog } from './dialogs/ShortcutsDialog'
import { player } from './engine/player'
import { Dock } from './layout/dock'
import { guardUnsaved, initMediaCacheListener, openProjectPath, saveProjectAction } from './state/actions'
import { installShortcuts } from './state/shortcuts'
import { get, loadProject, projectName, set, useStore } from './state/store'

function CloseDialog() {
  const pending = useStore((s) => s.pendingAfterClose)
  const name = useStore(projectName)
  const finish = (proceed: boolean) => {
    set({ modal: null, pendingAfterClose: null })
    if (proceed) pending?.()
  }
  return (
    <Modal
      title="Unsaved changes"
      width={420}
      onClose={() => finish(false)}
      footer={
        <>
          <Btn onClick={() => finish(false)}>Cancel</Btn>
          <Btn danger onClick={() => { set({ dirty: false }); finish(true) }} testId="discard">Don't save</Btn>
          <Btn primary onClick={async () => { if (await saveProjectAction()) finish(true) }}>Save</Btn>
        </>
      }
    >
      <p>“{name}” has changes that have not been saved.</p>
    </Modal>
  )
}

function AboutDialog() {
  const ffmpeg = useStore((s) => s.ffmpegVersion)
  return (
    <Modal title="About ClipWorld" width={420} onClose={() => set({ modal: null })} footer={<Btn primary onClick={() => set({ modal: null })}>Close</Btn>}>
      <p>A video editor built on ffmpeg.</p>
      <p className="dim">ffmpeg {ffmpeg ?? 'not found'} does the importing, audio extraction, proxies, thumbnails and exporting.</p>
      <p className="dim">Projects are saved as .vcws files.</p>
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

  useEffect(() => {
    let disposed = false
    const cleanups: (() => void)[] = []
    void window.cw.getInfo().then((info) => {
      if (disposed) return
      set({ settings: info.settings, caps: info.caps, ffmpegVersion: info.ffmpegVersion })
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
        set((s) => ({ toasts: [...s.toasts, { id: -1, kind: 'info', text: 'Restored unsaved work from your last session' }] }))
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== -1) })), 6000)
      }
    })
    return () => {
      disposed = true
      for (const c of cleanups) c()
    }
  }, [])

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

  if (!ready) return <div className="boot">Starting ClipWorld…</div>
  return (
    <div className="app">
      <MenuBar />
      {!ffmpeg && (
        <div className="banner bad">
          ffmpeg was not found, so importing and exporting are unavailable. Run <code>npm run fetch-ffmpeg</code> in the project folder, then restart.
        </div>
      )}
      <main className="workspace"><Dock /></main>
      {modal === 'export' && <ExportDialog />}
      {modal === 'shortcuts' && <ShortcutsDialog />}
      {modal === 'close' && <CloseDialog />}
      {modal === 'about' && <AboutDialog />}
      <Toasts />
    </div>
  )
}

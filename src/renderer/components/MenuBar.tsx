import { useState, useSyncExternalStore } from 'react'
import { PANELS, isPanelOpen, resetLayout, showPanel, subscribePanels, togglePanel } from '../layout/dock'
import {
  addCueAction, addTextAction, copyAction, cutAction, deleteSelectionAction, duplicateAction, importMediaAction,
  importSubtitleFilesAction, newProjectAction, openProjectAction, pasteAction, redo, saveProjectAction, selectAllAction,
  splitAction, undo, unlinkAction
} from '../state/actions'
import { bindingFor } from '../state/shortcuts'
import { guardUnsaved } from '../state/actions'
import { projectName, set, useStore } from '../state/store'
import { useDismiss } from './ui'

interface Item {
  label?: string
  shortcut?: string
  run?: () => void
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  testId?: string
}

function Menu({ label, items, open, onOpen, onClose, onHover }: {
  label: string
  items: Item[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  onHover: () => void
}) {
  return (
    <div className="menu">
      <button type="button" className={`menu-title${open ? ' open' : ''}`} onClick={() => (open ? onClose() : onOpen())} onMouseEnter={onHover}
        data-testid={`menu-${label.toLowerCase()}`}>
        {label}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) =>
            it.separator ? (
              <div className="menu-sep" key={i} />
            ) : (
              <button type="button" key={i} className="menu-item" role="menuitem" disabled={it.disabled} data-testid={it.testId}
                onClick={() => { onClose(); it.run?.() }}>
                <span className="menu-check">{it.checked ? '✓' : ''}</span>
                <span className="menu-label">{it.label}</span>
                <span className="menu-shortcut">{it.shortcut}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useDismiss(open !== null, () => setOpen(null))
  const name = useStore(projectName)
  const dirty = useStore((s) => s.dirty)
  const recent = useStore((s) => s.settings.recent)
  const hasSelection = useStore((s) => s.selection.length > 0)
  const hasClipboard = useStore((s) => !!s.clipboard)
  const canUndo = useStore((s) => s.undo.length > 0)
  const canRedo = useStore((s) => s.redo.length > 0)
  const ffmpeg = useStore((s) => s.ffmpegVersion)
  const hasSubtitles = useStore((s) => s.project.subtitles.some((t) => t.cues.length > 0))
  useStore((s) => s.settings.shortcuts)
  useSyncExternalStore(subscribePanels, () => PANELS.map((p) => (isPanelOpen(p.id) ? '1' : '0')).join(''))
  const k = bindingFor

  const file: Item[] = [
    { label: 'New project', shortcut: k('file.new'), run: newProjectAction },
    { label: 'Open project…', shortcut: k('file.open'), run: () => openProjectAction() },
    ...(recent.length
      ? [{ separator: true } as Item, ...recent.slice(0, 6).map((r): Item => ({ label: r.split(/[\\/]/).pop(), run: () => openProjectAction(r) }))]
      : []),
    { separator: true },
    { label: 'Save', shortcut: k('file.save'), run: () => void saveProjectAction(), testId: 'menu-save' },
    { label: 'Save as…', shortcut: k('file.saveAs'), run: () => void saveProjectAction(true) },
    { separator: true },
    { label: 'Import media…', shortcut: k('file.import'), run: () => void importMediaAction() },
    {
      label: 'Import subtitles…',
      run: () => {
        showPanel('subtitles')
        void importSubtitleFilesAction()
      }
    },
    { separator: true },
    { label: 'Export…', shortcut: k('file.export'), run: () => set({ modal: 'export' }), testId: 'menu-export' },
    {
      label: 'Export subtitles…',
      disabled: !hasSubtitles,
      run: () => {
        showPanel('subtitles')
        set((s) => ({ subtitleExportRequest: s.subtitleExportRequest + 1 }))
      }
    },
    { separator: true },
    { label: 'Exit', run: () => guardUnsaved(() => window.cw.confirmClose()) }
  ]
  const edit: Item[] = [
    { label: 'Undo', shortcut: k('edit.undo'), run: undo, disabled: !canUndo },
    { label: 'Redo', shortcut: k('edit.redo'), run: redo, disabled: !canRedo },
    { separator: true },
    { label: 'Cut', shortcut: k('edit.cut'), run: cutAction, disabled: !hasSelection },
    { label: 'Copy', shortcut: k('edit.copy'), run: () => void copyAction(), disabled: !hasSelection },
    { label: 'Paste at playhead', shortcut: k('edit.paste'), run: pasteAction, disabled: !hasClipboard },
    { label: 'Duplicate', shortcut: k('edit.duplicate'), run: duplicateAction, disabled: !hasSelection },
    { label: 'Delete', shortcut: k('edit.delete'), run: deleteSelectionAction, disabled: !hasSelection },
    { separator: true },
    { label: 'Split at playhead', shortcut: k('timeline.split'), run: splitAction },
    { label: 'Unlink audio from video', shortcut: k('timeline.unlink'), run: unlinkAction, disabled: !hasSelection },
    { label: 'Add text', shortcut: k('timeline.addText'), run: () => addTextAction() },
    {
      label: 'Add subtitle at playhead',
      shortcut: k('subtitles.add'),
      run: () => {
        showPanel('subtitles')
        addCueAction()
      }
    },
    { label: 'Select all clips', shortcut: k('edit.selectAll'), run: selectAllAction },
    { separator: true },
    { label: 'Keyboard shortcuts…', run: () => set({ modal: 'shortcuts' }), testId: 'menu-shortcuts' }
  ]
  const windowMenu: Item[] = [
    ...PANELS.map((p): Item => ({ label: p.title, checked: isPanelOpen(p.id), run: () => togglePanel(p.id) })),
    { separator: true },
    { label: 'Reset layout', run: resetLayout },
    { label: 'Developer tools', shortcut: 'F12', run: () => window.cw.toggleDevTools() }
  ]
  const help: Item[] = [{ label: 'About ClipWorld', run: () => set({ modal: 'about' }) }]
  const menus: [string, Item[]][] = [['File', file], ['Edit', edit], ['Window', windowMenu], ['Help', help]]

  return (
    <header className="menubar" ref={ref}>
      <span className="brand">ClipWorld</span>
      {menus.map(([label, items]) => (
        <Menu key={label} label={label} items={items} open={open === label} onOpen={() => setOpen(label)} onClose={() => setOpen(null)}
          onHover={() => open !== null && setOpen(label)} />
      ))}
      <span className="menubar-title" data-testid="project-title">{name}{dirty ? ' •' : ''}</span>
      <span className={`menubar-status${ffmpeg ? '' : ' bad'}`}>{ffmpeg ? `ffmpeg ${ffmpeg.split('-')[0]}` : 'ffmpeg not found'}</span>
    </header>
  )
}

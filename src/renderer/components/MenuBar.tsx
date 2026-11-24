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

import { useState, useSyncExternalStore } from 'react'
import {
  PANELS, isPanelOpen, isPluginPanelOpen, openPanelsKey, resetLayout, showPanel, subscribePanels, togglePanel, togglePluginPanel
} from '../layout/dock'
import { pluginText } from '@shared/plugins'
import { exportWithPlugin, importWithPlugin, pluginCommandShortcut, pluginName, runPluginCommand, runningPlugins } from '../state/plugins'
import {
  addCueAction, addTextAction, copyAction, cutAction, deleteSelectionAction, duplicateAction, importMediaAction,
  importSubtitleFilesAction, newProjectAction, openProjectAction, pasteAction, redo, saveProjectAction, selectAllAction,
  splitAction, undo, unlinkAction
} from '../state/actions'
import { useT } from '../i18n'
import { bindingFor, shortcutLabel as a } from '../state/shortcuts'
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

function Menu({ id, label, items, open, onOpen, onClose, onHover }: {
  id: string
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
        data-testid={`menu-${id}`}>
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
  useSyncExternalStore(subscribePanels, openPanelsKey)
  const k = bindingFor
  const t = useT()
  const lang = useStore((s) => s.lang)
  const plugins = runningPlugins(useStore((s) => s.plugins))
  const tx = (v: Parameters<typeof pluginText>[0]) => pluginText(v, lang)
  const importers = plugins.flatMap((p) => p.manifest.importers.map((i): Item => ({
    label: t('menu.importWith', { name: tx(i.title) }), run: () => void importWithPlugin(p.manifest.id, i.id), testId: `menu-import-${p.manifest.id}-${i.id}`
  })))
  const exporters = plugins.flatMap((p) => p.manifest.exporters.map((x): Item => ({
    label: t('menu.exportWith', { name: tx(x.title) }), run: () => void exportWithPlugin(p.manifest.id, x.id), testId: `menu-export-${p.manifest.id}-${x.id}`
  })))

  const file: Item[] = [
    { label: a('file.new'), shortcut: k('file.new'), run: newProjectAction },
    { label: a('file.open'), shortcut: k('file.open'), run: () => openProjectAction() },
    ...(recent.length
      ? [{ separator: true } as Item, ...recent.slice(0, 6).map((r): Item => ({ label: r.split(/[\\/]/).pop(), run: () => openProjectAction(r) }))]
      : []),
    { separator: true },
    { label: a('file.save'), shortcut: k('file.save'), run: () => void saveProjectAction(), testId: 'menu-save' },
    { label: a('file.saveAs'), shortcut: k('file.saveAs'), run: () => void saveProjectAction(true) },
    { separator: true },
    { label: a('file.import'), shortcut: k('file.import'), run: () => void importMediaAction() },
    {
      label: t('menu.importSubtitles'),
      run: () => {
        showPanel('subtitles')
        void importSubtitleFilesAction()
      }
    },
    ...importers,
    { separator: true },
    { label: a('file.export'), shortcut: k('file.export'), run: () => set({ modal: 'export' }), testId: 'menu-export' },
    {
      label: t('menu.exportSubtitles'),
      disabled: !hasSubtitles,
      run: () => {
        showPanel('subtitles')
        set((s) => ({ subtitleExportRequest: s.subtitleExportRequest + 1 }))
      }
    },
    ...exporters,
    { separator: true },
    { label: t('menu.exit'), run: () => guardUnsaved(() => window.cw.confirmClose()) }
  ]
  const edit: Item[] = [
    { label: a('edit.undo'), shortcut: k('edit.undo'), run: undo, disabled: !canUndo },
    { label: a('edit.redo'), shortcut: k('edit.redo'), run: redo, disabled: !canRedo },
    { separator: true },
    { label: a('edit.cut'), shortcut: k('edit.cut'), run: cutAction, disabled: !hasSelection },
    { label: a('edit.copy'), shortcut: k('edit.copy'), run: () => void copyAction(), disabled: !hasSelection },
    { label: a('edit.paste'), shortcut: k('edit.paste'), run: pasteAction, disabled: !hasClipboard },
    { label: a('edit.duplicate'), shortcut: k('edit.duplicate'), run: duplicateAction, disabled: !hasSelection },
    { label: a('edit.delete'), shortcut: k('edit.delete'), run: deleteSelectionAction, disabled: !hasSelection },
    { separator: true },
    { label: a('timeline.split'), shortcut: k('timeline.split'), run: splitAction },
    { label: a('timeline.unlink'), shortcut: k('timeline.unlink'), run: unlinkAction, disabled: !hasSelection },
    { label: a('timeline.addText'), shortcut: k('timeline.addText'), run: () => addTextAction() },
    {
      label: a('subtitles.add'),
      shortcut: k('subtitles.add'),
      run: () => {
        showPanel('subtitles')
        addCueAction()
      }
    },
    { label: a('edit.selectAll'), shortcut: k('edit.selectAll'), run: selectAllAction },
    { separator: true },
    { label: t('menu.settings'), shortcut: k('edit.settings'), run: () => set({ modal: 'settings' }), testId: 'menu-settings' },
    { label: t('menu.shortcuts'), run: () => set({ modal: 'shortcuts' }), testId: 'menu-shortcuts' },
    // Always names "Language" in English too, so someone who picked a language they can't read can get back.
    { label: lang.startsWith('en') ? `${t('menu.language')}…` : `${t('menu.language')} (Language)…`, run: () => set({ modal: 'language' }), testId: 'menu-language' }
  ]
  const windowMenu: Item[] = [
    ...PANELS.map((p): Item => ({ label: t(`panels.${p.id}`), checked: isPanelOpen(p.id), run: () => togglePanel(p.id) })),
    { separator: true },
    { label: t('menu.resetLayout'), run: resetLayout },
    { label: t('menu.devTools'), shortcut: 'F12', run: () => window.cw.toggleDevTools() }
  ]
  // Plugins: their commands, then their windows, then the manager.
  const commands = plugins.flatMap((p) => p.manifest.commands.map((c): Item => ({
    label: plugins.length > 1 ? `${pluginName(p)}: ${tx(c.title)}` : tx(c.title),
    shortcut: pluginCommandShortcut(p.manifest.id, c.id),
    run: () => void runPluginCommand(p.manifest.id, c.id),
    testId: `menu-plugin-${p.manifest.id}-${c.id}`
  })))
  const pluginWindows = plugins.flatMap((p) => p.manifest.panels.map((w): Item => ({
    label: tx(w.title), checked: isPluginPanelOpen(p.manifest.id, w.id), run: () => togglePluginPanel(p.manifest.id, w.id, tx(w.title)),
    testId: `menu-panel-${p.manifest.id}-${w.id}`
  })))
  const pluginMenu: Item[] = [
    ...commands,
    ...(commands.length && pluginWindows.length ? [{ separator: true } as Item] : []),
    ...pluginWindows,
    ...(commands.length || pluginWindows.length ? [{ separator: true } as Item] : []),
    { label: t('menu.managePlugins'), run: () => set({ modal: 'plugins' }), testId: 'menu-manage-plugins' }
  ]
  const help: Item[] = [{ label: t('menu.about'), run: () => set({ modal: 'about' }) }]
  const menus: [string, Item[]][] = [['file', file], ['edit', edit], ['window', windowMenu], ['plugins', pluginMenu], ['help', help]]

  return (
    <header className="menubar" ref={ref}>
      <span className="brand">ClipWorld</span>
      {menus.map(([id, items]) => (
        <Menu key={id} id={id} label={t(`menu.${id}`)} items={items} open={open === id} onOpen={() => setOpen(id)} onClose={() => setOpen(null)}
          onHover={() => open !== null && setOpen(id)} />
      ))}
      <span className="menubar-title" data-testid="project-title">{name}{dirty ? ' •' : ''}</span>
      <span className={`menubar-status${ffmpeg ? '' : ' bad'}`}>{ffmpeg ? `ffmpeg ${ffmpeg.split('-')[0]}` : t('app.ffmpegNotFound')}</span>
    </header>
  )
}

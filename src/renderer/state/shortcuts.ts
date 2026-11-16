// Keyboard shortcuts: defaults, user overrides (stored in app settings) and the global key handler.
import { player } from '../engine/player'
import * as a from './actions'
import { get, patchSettings, set } from './store'

export interface ShortcutDef {
  id: string
  label: string
  group: 'File' | 'Edit' | 'Playback' | 'Timeline'
  default: string
  run: () => void
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'file.new', label: 'New project', group: 'File', default: 'Ctrl+N', run: a.newProjectAction },
  { id: 'file.open', label: 'Open project…', group: 'File', default: 'Ctrl+O', run: () => a.openProjectAction() },
  { id: 'file.save', label: 'Save', group: 'File', default: 'Ctrl+S', run: () => void a.saveProjectAction() },
  { id: 'file.saveAs', label: 'Save as…', group: 'File', default: 'Ctrl+Shift+S', run: () => void a.saveProjectAction(true) },
  { id: 'file.import', label: 'Import media…', group: 'File', default: 'Ctrl+I', run: () => void a.importMediaAction() },
  { id: 'file.export', label: 'Export…', group: 'File', default: 'Ctrl+Shift+E', run: () => set({ modal: 'export' }) },

  { id: 'edit.undo', label: 'Undo', group: 'Edit', default: 'Ctrl+Z', run: a.undo },
  { id: 'edit.redo', label: 'Redo', group: 'Edit', default: 'Ctrl+Y', run: a.redo },
  { id: 'edit.cut', label: 'Cut', group: 'Edit', default: 'Ctrl+X', run: a.cutAction },
  { id: 'edit.copy', label: 'Copy', group: 'Edit', default: 'Ctrl+C', run: () => void a.copyAction() },
  { id: 'edit.paste', label: 'Paste at playhead', group: 'Edit', default: 'Ctrl+V', run: a.pasteAction },
  { id: 'edit.duplicate', label: 'Duplicate', group: 'Edit', default: 'Ctrl+D', run: a.duplicateAction },
  { id: 'edit.delete', label: 'Delete', group: 'Edit', default: 'Delete', run: a.deleteSelectionAction },
  { id: 'edit.selectAll', label: 'Select all clips', group: 'Edit', default: 'Ctrl+A', run: a.selectAllAction },
  { id: 'edit.deselect', label: 'Deselect', group: 'Edit', default: 'Escape', run: () => set({ selection: [] }) },

  { id: 'timeline.split', label: 'Split at playhead', group: 'Timeline', default: 'Ctrl+K', run: a.splitAction },
  { id: 'timeline.unlink', label: 'Unlink audio from video', group: 'Timeline', default: 'Ctrl+U', run: a.unlinkAction },
  { id: 'timeline.addText', label: 'Add text', group: 'Timeline', default: 'T', run: () => a.addTextAction() },
  { id: 'timeline.snap', label: 'Toggle snapping', group: 'Timeline', default: 'S', run: () => set((s) => ({ snapping: !s.snapping })) },
  { id: 'timeline.zoomIn', label: 'Zoom in', group: 'Timeline', default: 'Ctrl+=', run: () => a.zoomTimeline(1.4) },
  { id: 'timeline.zoomOut', label: 'Zoom out', group: 'Timeline', default: 'Ctrl+-', run: () => a.zoomTimeline(1 / 1.4) },

  { id: 'play.toggle', label: 'Play / pause', group: 'Playback', default: 'Space', run: () => player.toggle() },
  { id: 'play.prevFrame', label: 'Previous frame', group: 'Playback', default: 'Left', run: () => player.step(-1) },
  { id: 'play.nextFrame', label: 'Next frame', group: 'Playback', default: 'Right', run: () => player.step(1) },
  { id: 'play.back1s', label: 'Back 1 second', group: 'Playback', default: 'Shift+Left', run: () => player.seek(player.time - 1) },
  { id: 'play.fwd1s', label: 'Forward 1 second', group: 'Playback', default: 'Shift+Right', run: () => player.seek(player.time + 1) },
  { id: 'play.start', label: 'Go to start', group: 'Playback', default: 'Home', run: () => player.seek(0) },
  { id: 'play.end', label: 'Go to end', group: 'Playback', default: 'End', run: () => player.seek(Infinity) }
]

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Escape',
  Delete: 'Delete', Backspace: 'Backspace', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', '+': '=', _: '-'
}

/** Normalises a key event to an accelerator string such as "Ctrl+Shift+E". Null for bare modifiers. */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  let key: string
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key
  else key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function bindingFor(id: string): string {
  const def = SHORTCUTS.find((s) => s.id === id)
  const override = get().settings.shortcuts[id]
  return override !== undefined ? override : (def?.default ?? '')
}

export function setBinding(id: string, accelerator: string | null): void {
  const shortcuts = { ...get().settings.shortcuts }
  const def = SHORTCUTS.find((s) => s.id === id)
  if (accelerator === null || accelerator === def?.default) delete shortcuts[id]
  else shortcuts[id] = accelerator
  patchSettings({ shortcuts })
}

export function resetBindings(): void {
  patchSettings({ shortcuts: {} })
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(type)
  }
  return false
}

/** Shortcuts that would hijack normal text editing while a text field has focus. */
const TEXT_EDITING = /^(Ctrl\+(A|C|V|X|Z|Y)|Ctrl\+Shift\+Z|Delete|Backspace|Left|Right|Shift\+Left|Shift\+Right|Home|End|Space|Escape|Enter)$/

/** Actions that make sense to repeat while the key is held. */
const REPEATABLE = /^(play\.(prevFrame|nextFrame|back1s|fwd1s)|timeline\.zoom(In|Out)|edit\.(undo|redo))$/

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'F12') {
      window.cw.toggleDevTools()
      return
    }
    const acc = acceleratorFromEvent(e)
    if (!acc) return
    if (get().modal) return
    const typing = isTyping(e.target)
    if (typing && (TEXT_EDITING.test(acc) || !/(Ctrl|Alt)\+/.test(acc))) return
    for (const def of SHORTCUTS) {
      if (bindingFor(def.id) === acc) {
        e.preventDefault()
        if (e.repeat && !REPEATABLE.test(def.id)) return
        def.run()
        return
      }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

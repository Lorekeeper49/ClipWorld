import { useEffect, useState } from 'react'
import { Btn, Modal } from '../components/ui'
import { SHORTCUTS, acceleratorFromEvent, bindingFor, resetBindings, setBinding } from '../state/shortcuts'
import { set, useStore } from '../state/store'

export function ShortcutsDialog() {
  useStore((s) => s.settings.shortcuts) // re-render when bindings change
  const [capturing, setCapturing] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      const other = SHORTCUTS.find((s) => s.id !== capturing && bindingFor(s.id) === acc)
      if (other) {
        // The key moves to the new action; the old one is left unassigned.
        setBinding(other.id, '')
        setConflict(`${acc} was assigned to “${other.label}”, which now has no shortcut.`)
      } else {
        setConflict(null)
      }
      setBinding(capturing, acc)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing])

  const groups = [...new Set(SHORTCUTS.map((s) => s.group))]
  return (
    <Modal
      title="Keyboard shortcuts"
      width={560}
      onClose={() => !capturing && set({ modal: null })}
      footer={
        <>
          <Btn onClick={() => { resetBindings(); setConflict(null) }}>Reset all to defaults</Btn>
          <Btn primary onClick={() => set({ modal: null })}>Done</Btn>
        </>
      }
    >
      <p className="dim">Click a shortcut, then press the new key combination. Escape cancels.</p>
      {conflict && <p className="notice">{conflict}</p>}
      <div className="shortcut-list">
        {groups.map((g) => (
          <div key={g}>
            <h3>{g}</h3>
            {SHORTCUTS.filter((s) => s.group === g).map((s) => {
              const binding = bindingFor(s.id)
              const changed = binding !== s.default
              return (
                <div className="shortcut-row" key={s.id} data-testid="shortcut-row" data-shortcut-id={s.id}>
                  <span>{s.label}</span>
                  <button type="button" className={`kbd${capturing === s.id ? ' capturing' : ''}`} onClick={() => setCapturing(s.id)}>
                    {capturing === s.id ? 'Press keys…' : binding || 'None'}
                  </button>
                  <Btn small icon="reset" title={`Reset to ${s.default}`} disabled={!changed} onClick={() => setBinding(s.id, null)} />
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { Btn, Modal } from '../components/ui'
import { useT } from '../i18n'
import { SHORTCUTS, acceleratorFromEvent, bindingFor, resetBindings, setBinding, shortcutLabel } from '../state/shortcuts'
import { set, useStore } from '../state/store'

export function ShortcutsDialog() {
  const t = useT()
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
        setConflict(t('shortcuts.conflict', { keys: acc, action: shortcutLabel(other.id) }))
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
      title={t('shortcuts.title')}
      width={560}
      onClose={() => !capturing && set({ modal: null })}
      footer={
        <>
          <Btn onClick={() => { resetBindings(); setConflict(null) }}>{t('shortcuts.resetAll')}</Btn>
          <Btn primary onClick={() => set({ modal: null })}>{t('common.done')}</Btn>
        </>
      }
    >
      <p className="dim">{t('shortcuts.hint')}</p>
      {conflict && <p className="notice">{conflict}</p>}
      <div className="shortcut-list">
        {groups.map((g) => (
          <div key={g}>
            <h3>{t(`shortcuts.groups.${g}`)}</h3>
            {SHORTCUTS.filter((s) => s.group === g).map((s) => {
              const binding = bindingFor(s.id)
              const changed = binding !== s.default
              return (
                <div className="shortcut-row" key={s.id} data-testid="shortcut-row" data-shortcut-id={s.id}>
                  <span>{shortcutLabel(s.id)}</span>
                  <button type="button" className={`kbd${capturing === s.id ? ' capturing' : ''}`} onClick={() => setCapturing(s.id)}>
                    {capturing === s.id ? t('shortcuts.press') : binding || t('shortcuts.none')}
                  </button>
                  <Btn small icon="reset" title={t('shortcuts.resetTo', { keys: s.default })} disabled={!changed} onClick={() => setBinding(s.id, null)} />
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </Modal>
  )
}

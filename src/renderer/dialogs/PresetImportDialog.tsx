import { useState } from 'react'
import { Btn, Icon, Modal } from '../components/ui'
import { useT } from '../i18n'
import { patchSettings, useStore } from '../state/store'

/** Asked before a preset's media is imported into the project. */
export function PresetImportDialog() {
  const t = useT()
  const prompt = useStore((s) => s.presetPrompt)
  const [always, setAlways] = useState(false)
  if (!prompt) return null
  const answer = (yes: boolean) => {
    // "Always" only makes sense together with "Yes": answering No keeps asking next time.
    if (yes && always) patchSettings({ autoImportPresetMedia: true })
    prompt.answer(yes)
  }
  const missing = prompt.files.filter((f) => !f.exists).length
  return (
    <Modal title={t('presets.importTitle', { name: prompt.presetName })} width={520} onClose={() => answer(false)}
      footer={
        <>
          <label className="preset-always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} data-testid="preset-always" />
            <span>{t('presets.autoImport')}</span>
          </label>
          <Btn onClick={() => answer(false)} testId="preset-import-no">{t('presets.no')}</Btn>
          <Btn primary onClick={() => answer(true)} testId="preset-import-yes">{t('presets.yes')}</Btn>
        </>
      }>
      <p>{t('presets.importQuestion')}</p>
      <ul className="preset-files" data-testid="preset-files">
        {prompt.files.map((f) => (
          <li key={f.item.id} className={f.exists ? '' : 'bad'} title={f.item.path}>
            <Icon name={f.exists ? (f.item.kind === 'audio' ? 'music' : f.item.kind === 'image' ? 'image' : 'film') : 'warn'} size={14} />
            <span className="preset-file-name">{f.item.name}</span>
            <span className="dim small preset-file-path">{f.exists ? f.item.path.replace(/[\\/][^\\/]*$/, '') : t('presets.notFound')}</span>
          </li>
        ))}
      </ul>
      {missing > 0 && <p className="dim small">{t('presets.missingHint', { count: missing })}</p>}
    </Modal>
  )
}

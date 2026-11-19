// The Presets section of the Tools window: save the selected clips as a preset, and place saved presets
// on the timeline in any project.
import { useEffect, useState } from 'react'
import { type Preset, presetLength } from '@shared/presets'
import { Btn, Section, Toggle, formatDuration } from '../components/ui'
import { useT } from '../i18n'
import { applyPresetAction, deletePresetAction, presetClipCount, renamePresetAction, savePresetAction } from '../state/presets'
import { patchSettings, useStore } from '../state/store'

function PresetRow({ preset }: { preset: Preset }) {
  const t = useT()
  const [name, setName] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // A second click deletes; the question goes away by itself.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const commit = () => {
    if (name !== null) void renamePresetAction(preset.id, name)
    setName(null)
  }
  const files = preset.media.length
  return (
    <li className="preset-row" data-testid="preset-row" data-preset-id={preset.id}>
      <div className="preset-main">
        <input className="sub-name preset-name" value={name ?? preset.name} spellCheck={false} title={t('presets.rename')}
          data-testid="preset-name"
          onChange={(e) => setName(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') { setName(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
          }} />
        <span className="dim small">
          {[t('presets.clips', { count: preset.clips.length }), formatDuration(presetLength(preset)),
            ...(files ? [t('presets.files', { count: files })] : [])].join(' · ')}
        </span>
      </div>
      <Btn small primary icon="plus" title={t('presets.applyHint')} onClick={() => void applyPresetAction(preset.id)} testId="preset-apply">
        {t('presets.apply')}
      </Btn>
      {confirming ? (
        <Btn small danger onClick={() => void deletePresetAction(preset.id)} testId="preset-delete-confirm">{t('presets.confirmDelete')}</Btn>
      ) : (
        <Btn small icon="trash" title={t('presets.delete')} onClick={() => setConfirming(true)} testId="preset-delete" />
      )}
    </li>
  )
}

export function PresetsTool() {
  const t = useT()
  const presets = useStore((s) => s.presets)
  const auto = useStore((s) => !!s.settings.autoImportPresetMedia)
  const count = useStore(presetClipCount)
  const [name, setName] = useState('')
  const save = async () => {
    if (await savePresetAction(name)) setName('')
  }
  return (
    <Section title={t('presets.title')} icon="layers">
      {count > 0 ? (
        <div className="preset-save">
          <input className="sub-name" value={name} placeholder={t('presets.defaultName', { n: presets.length + 1 })} spellCheck={false}
            data-testid="preset-new-name" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()} />
          <Btn small primary icon="plus" onClick={() => void save()} testId="preset-save">{t('presets.save', { count })}</Btn>
        </div>
      ) : (
        <p className="dim">{t('presets.selectHint')}</p>
      )}
      {presets.length === 0 ? (
        <p className="dim small">{t('presets.empty')}</p>
      ) : (
        <ul className="preset-list">{presets.map((p) => <PresetRow key={p.id} preset={p} />)}</ul>
      )}
      <Toggle label={t('presets.autoImport')} value={auto} onChange={(v) => patchSettings({ autoImportPresetMedia: v })} testId="preset-auto-import" />
    </Section>
  )
}

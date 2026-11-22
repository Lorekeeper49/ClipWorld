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

// The Settings window (Edit ▸ Settings…): every user preference in one place. Changes apply straight away
// and are remembered between sessions.
import { useState } from 'react'
import { Btn, Color, Icon, Modal, Slider, Toggle } from '../components/ui'
import { useT } from '../i18n'
import { resetLayout } from '../layout/dock'
import { patchSettings, set, useStore } from '../state/store'
import { CLIP_KINDS, type ClipKind, DEFAULT_CLIP_COLORS, clipColor } from './clipColors'
import { LanguagePicker } from './LanguagePicker'
import { ShortcutsEditor } from './ShortcutsEditor'
import { VoiceoverSettings } from '../panels/VoiceoverTool'

type Page = 'general' | 'timeline' | 'shortcuts'
const PAGES: { id: Page; icon: string }[] = [
  { id: 'general', icon: 'info' },
  { id: 'timeline', icon: 'film' },
  { id: 'shortcuts', icon: 'keyboard' }
]
/** The page shown last, so reopening Settings goes back to it. */
let lastPage: Page = 'general'

function GeneralPage() {
  const t = useT()
  const volume = useStore((s) => s.settings.previewVolume)
  const autoImport = useStore((s) => !!s.settings.autoImportPresetMedia)
  const [layoutReset, setLayoutReset] = useState(false)
  return (
    <>
      <h3>{t('settings.language')}</h3>
      <LanguagePicker />
      <h3>{t('settings.preview')}</h3>
      <Slider label={t('settings.previewVolume')} value={volume} min={0} max={1} step={0.01} display={100} unit="%" reset={1}
        onChange={(v) => patchSettings({ previewVolume: v })} testId="settings-preview-volume" />
      <p className="dim small">{t('settings.previewVolumeHint')}</p>
      <h3>{t('tools.voiceover.title')}</h3>
      <VoiceoverSettings testPrefix="settings-voiceover" />
      <p className="dim small">{t('settings.voiceoverHint')}</p>
      <h3>{t('presets.title')}</h3>
      <Toggle label={t('presets.autoImport')} value={autoImport} onChange={(v) => patchSettings({ autoImportPresetMedia: v })} testId="settings-auto-import" />
      <p className="dim small">{t('settings.autoImportHint')}</p>
      <h3>{t('settings.layout')}</h3>
      <div className="settings-inline">
        <Btn small icon="reset" onClick={() => { resetLayout(); setLayoutReset(true) }}>{t('menu.resetLayout')}</Btn>
        <span className="dim small">{layoutReset ? t('settings.layoutDone') : t('settings.layoutHint')}</span>
      </div>
    </>
  )
}

function TimelinePage() {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const setColor = (kind: ClipKind, color: string | null) => {
    const next = { ...settings.clipColors }
    if (color === null || color.toLowerCase() === DEFAULT_CLIP_COLORS[kind]) delete next[kind]
    else next[kind] = color
    patchSettings({ clipColors: next })
  }
  const custom = CLIP_KINDS.some((k) => settings.clipColors?.[k])
  return (
    <>
      <div className="settings-row-head">
        <h3>{t('settings.clipColors')}</h3>
        <Btn small icon="reset" disabled={!custom} onClick={() => patchSettings({ clipColors: {} })} testId="clip-colors-reset">
          {t('settings.resetColors')}
        </Btn>
      </div>
      <p className="dim small">{t('settings.clipColorsHint')}</p>
      <div className="clip-color-list">
        {CLIP_KINDS.map((kind) => {
          const color = clipColor(settings, kind)
          const changed = !!settings.clipColors?.[kind]
          return (
            <div className="clip-color-row" key={kind} data-testid="clip-color" data-kind={kind}>
              {/* A small clip drawn the way the timeline draws it. */}
              <div className={`clip-swatch clip-${kind}`}><span className="clip-label"><span className="clip-name">{t(`properties.kinds.${kind}`)}</span></span></div>
              <Color value={color} onChange={(v) => setColor(kind, v)} />
              <Btn small icon="reset" title={t('settings.resetColor')} disabled={!changed} onClick={() => setColor(kind, null)} />
            </div>
          )
        })}
      </div>
    </>
  )
}

export function SettingsDialog() {
  const t = useT()
  const opened = useStore((s) => s.modal)
  // Edit ▸ Keyboard shortcuts… and Edit ▸ Language… open their own page.
  const [page, setPage] = useState<Page>(opened === 'shortcuts' ? 'shortcuts' : opened === 'language' ? 'general' : lastPage)
  const [capturing, setCapturing] = useState(false)
  const go = (p: Page) => {
    lastPage = p
    setPage(p)
  }
  // While a shortcut waits for keys, Escape cancels that rather than closing the window.
  const close = () => !capturing && set({ modal: null })
  return (
    <Modal title={t('settings.title')} width={780} onClose={close} footer={<Btn primary onClick={close} testId="settings-done">{t('common.done')}</Btn>}>
      <div className="settings">
        <nav className="settings-nav">
          {PAGES.map((p) => (
            <button type="button" key={p.id} className={page === p.id ? 'active' : ''} onClick={() => go(p.id)} data-testid={`settings-page-${p.id}`}>
              <Icon name={p.icon} size={15} />
              {t(`settings.pages.${p.id}`)}
            </button>
          ))}
        </nav>
        <div className="settings-page" data-page={page}>
          {page === 'general' && <GeneralPage />}
          {page === 'timeline' && <TimelinePage />}
          {page === 'shortcuts' && <ShortcutsEditor onCapture={setCapturing} />}
        </div>
      </div>
    </Modal>
  )
}

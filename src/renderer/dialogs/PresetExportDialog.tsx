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

// Export preset: choose which of the preset's media files go into the zip, then pick where to save it.
import { useEffect, useState } from 'react'
import { Btn, Icon, Modal } from '../components/ui'
import { useT } from '../i18n'
import { exportPresetAction } from '../state/presets'
import { set, useStore } from '../state/store'

export function PresetExportDialog() {
  const t = useT()
  const preset = useStore((s) => s.presets.find((p) => p.id === s.presetExport) ?? null)
  const [exists, setExists] = useState<boolean[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!preset) return
    let live = true
    void window.cw.filesExist(preset.media.map((m) => m.path)).then((found) => {
      if (!live) return
      setExists(found)
      // Every file that is still there is included unless the user unticks it.
      setChosen(new Set(preset.media.filter((_m, i) => found[i]).map((m) => m.id)))
    })
    return () => {
      live = false
    }
  }, [preset])
  if (!preset) return null
  const close = () => set({ modal: null, presetExport: null })
  const toggle = (id: string, on: boolean) =>
    setChosen((cur) => {
      const next = new Set(cur)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const go = async () => {
    setBusy(true)
    const path = await exportPresetAction(preset.id, [...chosen])
    setBusy(false)
    if (path) close()
  }
  const left = preset.media.length - chosen.size
  return (
    <Modal title={t('presets.exportTitle', { name: preset.name })} width={520} onClose={close}
      footer={
        <>
          <Btn onClick={close} testId="preset-export-cancel">{t('common.cancel')}</Btn>
          <Btn primary icon="export" disabled={busy || !exists} onClick={() => void go()} testId="preset-export-save">
            {busy ? t('presets.exporting') : t('presets.exportButton')}
          </Btn>
        </>
      }>
      <p>{t('presets.exportQuestion')}</p>
      <ul className="preset-files" data-testid="preset-export-files">
        {preset.media.map((m, i) => {
          const there = exists?.[i] ?? true
          return (
            <li key={m.id} className={there ? '' : 'bad'} title={m.path}>
              <input type="checkbox" checked={chosen.has(m.id)} disabled={!there} data-testid="preset-export-file"
                onChange={(e) => toggle(m.id, e.target.checked)} />
              <Icon name={there ? (m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film') : 'warn'} size={14} />
              <span className="preset-file-name">{m.name}</span>
              <span className="dim small preset-file-path">{there ? m.path.replace(/[\\/][^\\/]*$/, '') : t('presets.notFound')}</span>
            </li>
          )
        })}
      </ul>
      <p className="dim small">{left > 0 ? t('presets.exportLeftOut', { count: left }) : t('presets.exportAll')}</p>
    </Modal>
  )
}

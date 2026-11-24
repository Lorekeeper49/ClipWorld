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

// A plugin's question to the user (askUser): a few fields, then OK or Cancel.
import { useState } from 'react'
import { Btn, Color, Field, Modal, Select, Toggle } from '../components/ui'
import { useT } from '../i18n'
import type { PluginFormField } from '../state/plugins'
import { useStore } from '../state/store'

const initial = (f: PluginFormField): unknown => {
  if (f.default !== undefined) return f.default
  if (f.type === 'checkbox') return false
  if (f.type === 'number') return f.min ?? 0
  if (f.type === 'select') return f.options?.[0]?.value ?? ''
  if (f.type === 'color') return '#ffffff'
  return ''
}

export function PluginFormDialog() {
  const t = useT()
  const form = useStore((s) => s.pluginForm)
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries((form?.fields ?? []).map((f) => [f.key, initial(f)])))
  if (!form) return null
  const put = (key: string, v: unknown) => setValues((cur) => ({ ...cur, [key]: v }))
  const ok = () => form.answer(Object.fromEntries(form.fields.map((f) => [f.key, f.type === 'number' ? Number(values[f.key]) : values[f.key]])))
  return (
    <Modal title={form.title} width={460} onClose={() => form.answer(null)}
      footer={
        <>
          <span className="dim small plugin-form-from" data-i18n-ignore="">{form.plugin}</span>
          <Btn onClick={() => form.answer(null)} testId="plugin-form-cancel">{t('common.cancel')}</Btn>
          <Btn primary onClick={ok} testId="plugin-form-ok">{form.okLabel || t('common.ok')}</Btn>
        </>
      }>
      <div className="plugin-form" data-i18n-ignore="" onKeyDown={(e) => e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && ok()}>
        {form.message && <p>{form.message}</p>}
        {form.fields.map((f) => {
          const v = values[f.key]
          if (f.type === 'checkbox') return <Toggle key={f.key} label={f.label} value={!!v} onChange={(x) => put(f.key, x)} testId={`plugin-field-${f.key}`} />
          if (f.type === 'color') return <Color key={f.key} label={f.label} value={String(v)} onChange={(x) => put(f.key, x)} />
          if (f.type === 'select') {
            return (
              <Field key={f.key} label={f.label}>
                <Select value={String(v)} options={f.options ?? []} onChange={(x) => put(f.key, x)} testId={`plugin-field-${f.key}`} />
              </Field>
            )
          }
          return (
            <Field key={f.key} label={f.label}>
              {f.type === 'multiline' ? (
                <textarea className="sub-name" rows={4} value={String(v)} onChange={(e) => put(f.key, e.target.value)} data-testid={`plugin-field-${f.key}`} />
              ) : (
                <input className="sub-name" type={f.type === 'number' ? 'number' : 'text'} value={String(v)} min={f.min} max={f.max} step={f.step}
                  onChange={(e) => put(f.key, e.target.value)} data-testid={`plugin-field-${f.key}`} />
              )}
            </Field>
          )
        })}
      </div>
    </Modal>
  )
}

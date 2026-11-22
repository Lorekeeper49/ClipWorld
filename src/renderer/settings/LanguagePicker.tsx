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

import { PSEUDO_LANGUAGE, completeness, formatNumber, languageName, languages } from '@shared/i18n'
import { chooseLanguage, systemLanguage, useT } from '../i18n'
import { useStore } from '../state/store'

/** The language choice (Settings ▸ General). */
export function LanguagePicker() {
  const t = useT()
  const preference = useStore((s) => s.settings.language ?? 'system')
  const lang = useStore((s) => s.lang)
  const system = systemLanguage()
  const pct = (code: string) => formatNumber(completeness(code), { style: 'percent', maximumFractionDigits: 0 })

  // Language names come from the system (Intl), already in the right language: the UI test skips them.
  const Row = ({ code, label, detail, named }: { code: string; label: string; detail?: string; named?: 'label' | 'detail' }) => (
    <label className={`language-row${preference === code ? ' current' : ''}`} data-testid="language-option" data-language={code}>
      <input type="radio" name="language" checked={preference === code} onChange={() => chooseLanguage(code)} />
      <span className="language-name" data-i18n-ignore={named === 'label' || undefined}>{label}</span>
      {detail && <span className="dim small" data-i18n-ignore={named === 'detail' || undefined}>{detail}</span>}
    </label>
  )

  return (
    <>
      <div className="language-list">
        <Row code="system" label={t('language.system')} detail={languageName(system)} named="detail" />
        {languages().filter((c) => c !== PSEUDO_LANGUAGE).map((code) => {
          const done = completeness(code)
          // The language's own name, plus its name in the current language when that differs ("日本語 — Japanese").
          const own = languageName(code)
          const here = languageName(code, lang)
          return (
            <Row key={code} code={code} named="label" label={own === here ? own : `${own} — ${here}`}
              detail={done < 1 ? t('language.translated', { percent: pct(code) }) : undefined} />
          )
        })}
        <Row code={PSEUDO_LANGUAGE} label={t('language.pseudo')} detail={t('language.pseudoHint')} />
      </div>
      <p className="dim small">{t('language.missingFallback')}</p>
    </>
  )
}

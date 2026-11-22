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

// Searchable picker over every font installed on the computer (virtualised: thousands of fonts are fine).
import { useEffect, useMemo, useRef, useState } from 'react'
import { set, useStore } from '../state/store'
import { useT } from '../i18n'
import { Icon, useDismiss } from './ui'

export function FontPicker({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const fonts = useStore((s) => s.fonts)
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scroll, setScroll] = useState(0)
  const ref = useDismiss(open, () => setOpen(false))
  const listRef = useRef<HTMLDivElement>(null)
  const ROW = 30
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? fonts.filter((f) => f.toLowerCase().includes(q)) : fonts
  }, [fonts, query])

  useEffect(() => {
    if (fonts.length) return
    void window.cw.listFonts().then((list) => set({ fonts: list.length ? list : ['Arial', 'Segoe UI', 'Times New Roman', 'Courier New'] }))
  }, [fonts.length])

  useEffect(() => {
    if (!open) return
    const i = filtered.indexOf(value)
    if (i >= 0 && listRef.current) listRef.current.scrollTop = Math.max(0, i * ROW - 90)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(scroll / ROW) - 4)
  const last = Math.min(filtered.length, first + 24)
  return (
    <div className="font-picker" ref={ref}>
      <button type="button" className="select font-button" style={{ fontFamily: `"${value}"` }} onClick={() => setOpen(!open)} data-testid="font-button">
        <span>{value}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div className="font-pop">
          <input autoFocus className="font-search" placeholder={t('fonts.search', { count: fonts.length })} value={query}
            onChange={(e) => { setQuery(e.target.value); if (listRef.current) listRef.current.scrollTop = 0 }} data-testid="font-search" />
          <div className="font-list" ref={listRef} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
            <div style={{ height: filtered.length * ROW, position: 'relative' }}>
              {filtered.slice(first, last).map((f, i) => (
                <button
                  type="button" key={f} className={`font-row${f === value ? ' current' : ''}`} data-testid="font-row"
                  style={{ top: (first + i) * ROW, height: ROW, fontFamily: `"${f}"` }}
                  onClick={() => { onChange(f); setOpen(false) }}
                >
                  {f}
                </button>
              ))}
            </div>
            {!filtered.length && <div className="dim pad">{t('fonts.none')}</div>}
          </div>
        </div>
      )}
    </div>
  )
}

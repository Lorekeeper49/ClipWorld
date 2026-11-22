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

// The preview's time format, [hh:]mm:ss:ff (ff = frame), and reading times the user types.

export function formatTime(t: number, fps = 30): string {
  const s = Math.max(0, t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const f = Math.floor((s - Math.floor(s)) * Math.round(fps) + 1e-6)
  const pad = (v: number, l = 2) => String(v).padStart(l, '0')
  return `${h ? pad(h) + ':' : ''}${pad(m)}:${pad(sec)}:${pad(f)}`
}

/**
 * Reads a time typed by the user, in seconds, or null when it isn't one:
 * - seconds, with a decimal point or comma: "12.5", "12,5", "90";
 * - the preview's format: "mm:ss:ff" or "hh:mm:ss:ff", where ff counts frames at `fps`;
 * - "mm:ss" (minutes and seconds), which is how most people write a time.
 * Fields may run over ("0:90" is 1:30), the last one may have decimals, and spaces are ignored.
 */
export function parseTime(text: string, fps = 30): number | null {
  const s = text.replace(/\s+/g, '').replace(/[,，]/g, '.').replace(/[：]/g, ':')
  if (!s) return null
  const parts = s.split(':')
  const isNum = (p: string, decimals: boolean) => (decimals ? /^(\d+\.?\d*|\.\d+)$/ : /^\d+$/).test(p)
  if (parts.length > 4 || !parts.every((p, i) => isNum(p, i === parts.length - 1))) return null
  const v = parts.map(Number)
  let t: number
  if (parts.length === 1) t = v[0]
  else if (parts.length === 2) t = v[0] * 60 + v[1]
  else {
    const [h, m, sec, f] = parts.length === 4 ? v : [0, ...v]
    t = h * 3600 + m * 60 + sec + f / Math.max(1, Math.round(fps))
  }
  return Number.isFinite(t) ? t : null
}

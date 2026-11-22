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

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/ipc'

const file = () => join(app.getPath('userData'), 'settings.json')

const defaults: AppSettings = { shortcuts: {}, previewVolume: 1, recent: [] }
let current: AppSettings | null = null
let timer: NodeJS.Timeout | null = null

export function loadSettings(): AppSettings {
  if (current) return current
  try {
    current = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    current = { ...defaults }
  }
  return current!
}

function flush(): void {
  if (!current) return
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch (err) {
    console.error('Could not save settings', err)
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  current = { ...loadSettings(), ...patch }
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 300)
}

export function flushSettings(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    flush()
  }
}

export function addRecent(path: string): void {
  const s = loadSettings()
  saveSettings({ recent: [path, ...s.recent.filter((r) => r !== path)].filter((r) => existsSync(r)).slice(0, 10) })
}

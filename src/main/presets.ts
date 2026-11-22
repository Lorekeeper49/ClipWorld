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

// Preset storage: one JSON file per preset in <userData>/presets, so they are shared by every project and
// a damaged file only loses that one preset.
import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Preset, parsePreset } from '@shared/presets'

const dir = () => join(app.getPath('userData'), 'presets')
/** Ids become file names, so only safe characters are kept. */
const fileOf = (id: string) => join(dir(), `${id.replace(/[^\w-]/g, '_')}.json`)

export function listPresets(): Preset[] {
  let names: string[] = []
  try {
    names = readdirSync(dir()).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: Preset[] = []
  for (const n of names) {
    try {
      const preset = parsePreset(JSON.parse(readFileSync(join(dir(), n), 'utf8')))
      if (preset) out.push(preset)
    } catch (err) {
      console.warn(`[presets] skipping ${n}:`, (err as Error).message)
    }
  }
  return out.sort((a, b) => a.created - b.created)
}

export function savePreset(preset: Preset): void {
  mkdirSync(dir(), { recursive: true })
  const file = fileOf(preset.id)
  writeFileSync(file + '.tmp', JSON.stringify(preset, null, 2), 'utf8')
  renameSync(file + '.tmp', file)
}

export function deletePreset(id: string): void {
  rmSync(fileOf(id), { force: true })
}

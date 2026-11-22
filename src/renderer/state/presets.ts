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

// Preset commands: save the selected clips as a preset, rename and delete presets, and place one on the
// timeline, importing the media it needs first (after asking, unless the user chose to always import).
import { t } from '@shared/i18n'
import { type MediaItem, uid } from '@shared/model'
import { type Preset, applyPreset, makePreset, matchPresetMedia } from '@shared/presets'
import { withLinked } from '@shared/timeline-ops'
import { player } from '../engine/player'
import { importPaths } from './actions'
import { type State, edit, get, set, toast } from './store'

export interface PresetFile {
  item: MediaItem
  /** The file is still on disk. Missing ones are added as missing media, to be located later. */
  exists: boolean
}

export async function loadPresets(): Promise<void> {
  set({ presets: await window.cw.listPresets() })
}

/** Clips that saving now would include (the selection plus clips linked to it). */
export const presetClipCount = (s: State): number => (s.selection.length ? withLinked(s.project, s.selection).length : 0)

export async function savePresetAction(name: string): Promise<Preset | null> {
  const s = get()
  const preset = makePreset(s.project, s.selection, name || t('presets.defaultName', { n: s.presets.length + 1 }))
  if (!preset) return null
  await window.cw.savePreset(preset)
  set((cur) => ({ presets: [...cur.presets, preset] }))
  toast(t('presets.saved', { name: preset.name }))
  return preset
}

export async function renamePresetAction(id: string, name: string): Promise<void> {
  const preset = get().presets.find((p) => p.id === id)
  if (!preset || !name.trim() || name === preset.name) return
  const renamed = { ...preset, name: name.trim() }
  await window.cw.savePreset(renamed)
  set((s) => ({ presets: s.presets.map((p) => (p.id === id ? renamed : p)) }))
}

export async function deletePresetAction(id: string): Promise<void> {
  await window.cw.deletePreset(id)
  set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }))
}

/** Shows "The following files need to be imported…" and resolves with the answer. */
function askToImport(preset: Preset, files: PresetFile[]): Promise<boolean> {
  return new Promise((resolve) => {
    set({
      modal: 'presetImport',
      presetPrompt: {
        presetName: preset.name,
        files,
        answer: (yes) => {
          set({ modal: null, presetPrompt: null })
          resolve(yes)
        }
      }
    })
  })
}

/** Adds the files to the project: found ones are imported, missing ones are added as missing media. */
async function importPresetFiles(files: PresetFile[]): Promise<void> {
  const present = files.filter((f) => f.exists).map((f) => f.item.path)
  if (present.length) await importPaths(present)
  const missing = files.filter((f) => !f.exists).map((f): MediaItem => ({ ...f.item, id: uid('m') }))
  if (missing.length) {
    edit((p) => { p.media.push(...missing) })
    void window.cw.prepareMedia(missing)
  }
}

/** Places a preset at the playhead. Returns the new clips' ids (empty if cancelled). */
export async function applyPresetAction(id: string): Promise<string[]> {
  const preset = get().presets.find((p) => p.id === id)
  if (!preset) return []
  const time = player.time
  const { needed } = matchPresetMedia(get().project, preset)
  if (needed.length) {
    const exists = await window.cw.filesExist(needed.map((m) => m.path))
    const files = needed.map((item, i) => ({ item, exists: exists[i] }))
    if (!get().settings.autoImportPresetMedia && !(await askToImport(preset, files))) return []
    await importPresetFiles(files)
  }
  // Match again: the project now has the imported files (unless an import failed).
  const { found, needed: still } = matchPresetMedia(get().project, preset)
  let created: string[] = []
  edit((p) => { created = applyPreset(p, preset, time, found) })
  if (created.length) set({ selection: created })
  if (still.length) toast(t('presets.partly', { name: preset.name, count: still.length }), 'error')
  else if (created.length) toast(t('presets.applied', { name: preset.name }))
  return created
}

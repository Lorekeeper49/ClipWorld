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

// Exporting and importing presets as files. An export is a zip with preset.json and the media files the
// user chose to include, side by side; preset.json names each file without a folder. Importing takes the
// zip, or preset.json from an unzipped export (its files are then used where they are).
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { type Entry, openPromise } from 'yauzl'
import { t } from '@shared/i18n'
import { PRESET_JSON, type Preset, fileName, presetFileNames, presetJsonFor, readPresetFile, safeFileName } from '@shared/presets'

export interface PresetExportResult {
  /** Media that were chosen but could not be put in, because the file is gone (by media name). */
  skipped: string[]
}

/** Writes `preset` to the zip `target`, with the media whose ids are in `include` (when their files exist). */
export async function exportPresetZip(preset: Preset, include: Iterable<string>, target: string): Promise<PresetExportResult> {
  const names = presetFileNames(preset.media)
  const wanted = new Set(include)
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from(JSON.stringify(presetJsonFor(preset, names), null, 2) + '\n', 'utf8'), PRESET_JSON)
  const skipped: string[] = []
  for (const m of preset.media) {
    if (!wanted.has(m.id)) continue
    if (!existsSync(m.path)) {
      skipped.push(m.name)
      continue
    }
    // Videos, sound and pictures are compressed already: storing them as they are is as small and much faster.
    zip.addFile(m.path, names.get(m.id)!, { compress: false })
  }
  const tmp = `${target}.part`
  const written = pipeline(zip.outputStream, createWriteStream(tmp))
  zip.end()
  try {
    await written
    rmSync(target, { force: true })
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return { skipped }
}

/** A folder under `parent` named after the preset that is free to unpack into ("Intro", "Intro (2)"…). */
function freeFolder(parent: string, name: string): string {
  const base = safeFileName(name, 'Preset')
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? base : `${base} (${n})`)
    let empty = !existsSync(dir)
    if (!empty) {
      try {
        empty = readdirSync(dir).length === 0
      } catch {
        empty = false
      }
    }
    if (empty) return dir
  }
}

/** Thrown with a message meant for the user. */
class PresetFileError extends Error {}

/**
 * Reads an exported preset: a zip, or preset.json (or any preset JSON) from an unzipped one. A zip's media
 * are unpacked into a new folder under `unpackTo`, named after the preset; preset.json's are used where
 * they are, next to it. The preset gets a new id. Throws an error with a message for the user.
 */
export async function importPresetFile(file: string, unpackTo: string): Promise<Preset> {
  if (/\.zip$/i.test(file)) return importZip(file, unpackTo)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
  }
  const preset = readPresetFile(raw, dirname(file), sep)
  if (!preset) throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
  return preset
}

async function importZip(file: string, unpackTo: string): Promise<Preset> {
  let zip
  try {
    zip = await openPromise(file, { lazyEntries: true, autoClose: false })
  } catch {
    throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
  }
  try {
    const entries: Entry[] = []
    for await (const entry of zip.eachEntry()) entries.push(entry)
    // preset.json, at the top or in a folder (a zipped-up folder); otherwise the only JSON file there is.
    const jsons = entries.filter((e) => /\.json$/i.test(e.fileName) && !e.fileName.endsWith('/'))
    const named = jsons.filter((e) => fileName(e.fileName).toLowerCase() === PRESET_JSON)
    const json = (named.length ? named : jsons.length === 1 ? jsons : []).sort((a, b) => a.fileName.length - b.fileName.length)[0]
    if (!json) throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
    const folder = json.fileName.includes('/') ? json.fileName.slice(0, json.fileName.lastIndexOf('/') + 1) : ''
    const text = await readEntry(zip, json)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
    }
    const target = freeFolder(unpackTo, (raw as { preset?: { name?: string } })?.preset?.name ?? fileName(file).replace(/\.zip$/i, ''))
    const preset = readPresetFile(raw, target, sep)
    if (!preset) throw new PresetFileError(t('presets.notPreset', { name: fileName(file) }))
    // Unpack the files the preset names (and nothing else): only plain names, so nothing lands outside the folder.
    const byName = new Map(entries.map((e) => [e.fileName, e]))
    for (const m of preset.media) {
      if (dirname(m.path) !== target) continue
      const name = fileName(m.path)
      if (name !== safeFileName(name)) continue
      const entry = byName.get(folder + name)
      if (!entry) continue
      mkdirSync(target, { recursive: true })
      const out = join(target, name)
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(out))
    }
    return preset
  } finally {
    zip.close()
  }
}

async function readEntry(zip: Awaited<ReturnType<typeof openPromise>>, entry: Entry): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The message to show for an import that failed. */
export const importErrorMessage = (err: unknown, file: string): string =>
  err instanceof PresetFileError ? err.message : t('presets.importFailed', { name: fileName(file), error: (err as Error)?.message ?? String(err) })

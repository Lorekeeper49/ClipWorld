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

// Exporting and importing presets: the zip's preset.json names files without folders, the chosen media go
// in the zip, and a preset imports from the zip or from an unzipped preset.json.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { beforeEach, describe, expect, test } from 'vitest'
import { openPromise } from 'yauzl'
import { ZipFile } from 'yazl'
import { exportPresetZip, importPresetFile } from '../src/main/presetFiles'
import { type MediaItem, newProject, uid } from '@shared/model'
import { PRESET_JSON, type Preset, makePreset, presetFileNames, presetJsonFor, safeFileName } from '@shared/presets'
import { addTextClip, placeMedia } from '@shared/timeline-ops'
import { TMP } from './helpers'

const DIR = join(TMP, 'preset-files')

function media(path: string, kind: MediaItem['kind'] = 'video'): MediaItem {
  return {
    id: uid('m'), kind, name: path.split(/[\\/]/).pop()!, path, size: 0, mtimeMs: 0, duration: kind === 'image' ? 0 : 10,
    width: 1920, height: 1080, fps: 30, animated: false, hasAlpha: false, audioStreams: []
  }
}

/** A preset using three real files: two named take.mp4 in different folders, and a picture. */
function preset(): { preset: Preset; files: Record<string, string> } {
  const files = {
    a: join(DIR, 'shoot A', 'take.mp4'),
    b: join(DIR, 'shoot B', 'take.mp4'),
    logo: join(DIR, 'art', 'logo.png')
  }
  for (const [key, path] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `contents of ${key}`)
  }
  const p = newProject()
  const items = [media(files.a), media(files.b), media(files.logo, 'image')]
  p.media.push(...items)
  const ids = [...placeMedia(p, items[0], 0), ...placeMedia(p, items[1], 10), ...placeMedia(p, items[2], 20), addTextClip(p, 2, { content: 'Hi' })]
  return { preset: makePreset(p, ids, 'My intro')!, files }
}

async function zipEntries(file: string): Promise<Map<string, string>> {
  const zip = await openPromise(file, { lazyEntries: true })
  const out = new Map<string, string>()
  for await (const entry of zip.eachEntry()) {
    const chunks: Buffer[] = []
    for await (const c of await zip.openReadStreamPromise(entry)) chunks.push(c as Buffer)
    out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'))
  }
  zip.close()
  return out
}

async function writeZip(file: string, entries: Record<string, string>): Promise<void> {
  const zip = new ZipFile()
  for (const [name, text] of Object.entries(entries)) zip.addBuffer(Buffer.from(text), name)
  const done = pipeline(zip.outputStream, createWriteStream(file))
  zip.end()
  await done
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})

describe('file names', () => {
  test('each file keeps its own name; names that clash are numbered', () => {
    const names = presetFileNames([media('C:\\a\\take.mp4'), media('/b/Take.MP4'), media('C:\\c\\take.mp4'), media('D:\\x\\preset.json')])
    expect([...names.values()]).toEqual(['take.mp4', 'Take (2).MP4', 'take (3).mp4', 'preset (2).json'])
  })

  test('names are made safe for every system', () => {
    expect(safeFileName('a:b?.mp4')).toBe('a_b_.mp4')
    expect(safeFileName('con.mp4')).toBe('file')
    expect(safeFileName('ends with dot. ')).toBe('ends with dot')
  })

  test('preset.json names files without folders', () => {
    const { preset: pr } = preset()
    const json = presetJsonFor(pr, presetFileNames(pr.media))
    expect(json.format).toBe('ClipWorld preset')
    expect(json.preset.media.map((m) => m.path)).toEqual(['take.mp4', 'take (2).mp4', 'logo.png'])
    expect(JSON.stringify(json)).not.toContain(DIR.replace(/\\/g, '\\\\'))
    expect(json.preset.media.every((m) => !('relPath' in m))).toBe(true)
  })
})

describe('export', () => {
  test('the zip holds preset.json and the chosen files, side by side', async () => {
    const { preset: pr } = preset()
    const out = join(DIR, 'out', 'intro.zip')
    mkdirSync(dirname(out), { recursive: true })
    const r = await exportPresetZip(pr, [pr.media[0].id, pr.media[2].id], out)
    expect(r.skipped).toEqual([])
    const entries = await zipEntries(out)
    expect([...entries.keys()].sort()).toEqual(['logo.png', PRESET_JSON, 'take.mp4'])
    expect(entries.get('take.mp4')).toBe('contents of a')
    // The file left out is still named, so the preset can find it if the person importing has it.
    expect(JSON.parse(entries.get(PRESET_JSON)!).preset.media.map((m: MediaItem) => m.path)).toEqual(['take.mp4', 'take (2).mp4', 'logo.png'])
    expect(existsSync(out + '.part')).toBe(false)
  })

  test('chosen files that are gone are left out and reported', async () => {
    const { preset: pr, files } = preset()
    rmSync(files.logo)
    const out = join(DIR, 'intro.zip')
    const r = await exportPresetZip(pr, pr.media.map((m) => m.id), out)
    expect(r.skipped).toEqual(['logo.png'])
    expect([...(await zipEntries(out)).keys()].sort()).toEqual([PRESET_JSON, 'take (2).mp4', 'take.mp4'])
  })
})

describe('import', () => {
  test('from the zip: files are unpacked into a folder named after the preset', async () => {
    const { preset: pr } = preset()
    const out = join(DIR, 'intro.zip')
    await exportPresetZip(pr, pr.media.map((m) => m.id), out)
    const unpack = join(DIR, 'Presets')
    const imported = await importPresetFile(out, unpack)
    expect(imported.id).not.toBe(pr.id)
    expect(imported.name).toBe('My intro')
    expect(imported.clips.length).toBe(pr.clips.length)
    const folder = join(unpack, 'My intro')
    expect(imported.media.map((m) => m.path)).toEqual([join(folder, 'take.mp4'), join(folder, 'take (2).mp4'), join(folder, 'logo.png')])
    expect(readFileSync(join(folder, 'take (2).mp4'), 'utf8')).toBe('contents of b')
    // Importing again unpacks next to the first copy instead of over it.
    const again = await importPresetFile(out, unpack)
    expect(again.media[0].path).toBe(join(unpack, 'My intro (2)', 'take.mp4'))
  })

  test('from preset.json of an unzipped export: files are used where they are', async () => {
    const { preset: pr } = preset()
    const unzipped = join(DIR, 'unzipped')
    mkdirSync(unzipped)
    const names = presetFileNames(pr.media)
    writeFileSync(join(unzipped, PRESET_JSON), JSON.stringify(presetJsonFor(pr, names)))
    writeFileSync(join(unzipped, 'take.mp4'), 'x')
    const imported = await importPresetFile(join(unzipped, PRESET_JSON), join(DIR, 'Presets'))
    expect(imported.media.map((m) => m.path)).toEqual(['take.mp4', 'take (2).mp4', 'logo.png'].map((n) => unzipped + sep + n))
    expect(existsSync(join(DIR, 'Presets'))).toBe(false)
  })

  test('a zipped-up folder works too', async () => {
    const { preset: pr } = preset()
    const json = JSON.stringify(presetJsonFor(pr, presetFileNames(pr.media)))
    const out = join(DIR, 'folder.zip')
    await writeZip(out, { 'My intro/preset.json': json, 'My intro/logo.png': 'logo' })
    const imported = await importPresetFile(out, join(DIR, 'Presets'))
    expect(readFileSync(imported.media[2].path, 'utf8')).toBe('logo')
    expect(existsSync(imported.media[0].path)).toBe(false)
  })

  test('nothing is unpacked outside the folder', async () => {
    const { preset: pr } = preset()
    const json = presetJsonFor(pr, presetFileNames(pr.media))
    json.preset.media[0].path = '../escaped.mp4'
    const out = join(DIR, 'bad.zip')
    await writeZip(out, { 'preset.json': JSON.stringify(json), 'escaped.mp4': 'x' })
    const unpack = join(DIR, 'Presets')
    await importPresetFile(out, unpack)
    expect(existsSync(join(unpack, 'escaped.mp4'))).toBe(false)
    expect(readdirSync(DIR)).not.toContain('escaped.mp4')
  })

  test('files that are not presets are refused', async () => {
    const json = join(DIR, 'other.json')
    writeFileSync(json, '{"hello": 1}')
    await expect(importPresetFile(json, DIR)).rejects.toThrow(/other\.json/)
    const zip = join(DIR, 'other.zip')
    await writeZip(zip, { 'readme.txt': 'hi' })
    await expect(importPresetFile(zip, DIR)).rejects.toThrow(/other\.zip/)
    const broken = join(DIR, 'broken.zip')
    writeFileSync(broken, 'not a zip')
    await expect(importPresetFile(broken, DIR)).rejects.toThrow(/broken\.zip/)
  })
})

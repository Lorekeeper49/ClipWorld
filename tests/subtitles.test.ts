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

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type SubtitleClipAsset, runExport, writeSubtitleList } from '../src/main/export'
import { ffmpeg, getFfmpegPaths, usableCapabilities } from '../src/main/ffmpeg'
import { extractSubtitleStream, listSubtitleStreams, readSubtitleFile } from '../src/main/subtitles'
import { makeEffect } from '../src/shared/effects'
import type { Caps } from '../src/shared/filtergraph'
import { defaultExportSettings, normalizeExportSettings } from '../src/shared/formats'
import { type Clip, type Project, type SubtitleCue, makeSubtitleTrack, newProject, parseProject } from '../src/shared/model'
import {
  SUBTITLE_FORMATS, clipCues, cueAt, formatTimecode, parseSbv, parseSrt, parseTimecode, timelineCues, writeSubtitles
} from '../src/shared/subtitles'
import { addSubtitleClip, deleteSubtitleTrack, moveClips, splitAt, stretchClip } from '../src/shared/timeline-ops'
import { TMP, frameColor, setupFfmpeg } from './helpers'

const cue = (start: number, end: number, text: string): SubtitleCue => ({ id: `q${start}`, start, end, text })

function subtitleProject(): Project {
  const p = newProject()
  p.settings = { width: 640, height: 360, fps: 30 }
  const t = makeSubtitleTrack('English')
  t.cues = [cue(1, 2, 'Hello there'), cue(3, 4.5, 'Second line\nwith a break')]
  p.subtitles.push(t)
  return p
}
const subClip = (p: Project): Clip => p.clips.find((c) => c.type === 'subtitles')!

describe('subtitle timing', () => {
  it('finds the cue at a time', () => {
    const t = subtitleProject().subtitles[0]
    expect(cueAt(t, 0.5)).toBeUndefined()
    expect(cueAt(t, 1.5)?.text).toBe('Hello there')
    expect(cueAt(t, 2)).toBeUndefined()
    expect(cueAt(t, 4.49)?.start).toBe(3)
  })

  it('maps cues through a clip that is moved, split and stretched', () => {
    const p = subtitleProject()
    const id = addSubtitleClip(p, p.subtitles[0].id)!
    const c = subClip(p)
    expect([c.start, c.duration, c.srcIn]).toEqual([1, 3.5, 1])
    expect(clipCues(c, p.subtitles[0]).map((x) => [x.start, x.end])).toEqual([[1, 2], [3, 4.5]])

    moveClips(p, { [id]: { start: c.start, trackId: c.trackId } }, 2)
    expect(clipCues(subClip(p), p.subtitles[0]).map((x) => [x.start, x.end])).toEqual([[3, 4], [5, 6.5]])

    stretchClip(p, id, 'end', 3 + 7) // twice as long: half speed
    const placed = clipCues(subClip(p), p.subtitles[0])
    expect(placed.map((x) => [x.start, x.end].map((v) => +v.toFixed(6)))).toEqual([[3, 5], [7, 10]])

    splitAt(p, 4)
    const all = timelineCues(p.clips, p.subtitles[0]).map((x) => [x.start, x.end].map((v) => +v.toFixed(6)))
    expect(all).toEqual([[3, 4], [4, 5], [7, 10]])
  })

  it('deleting a subtitle track removes its clips; old projects load without subtitles', () => {
    const p = subtitleProject()
    addSubtitleClip(p, p.subtitles[0].id)
    deleteSubtitleTrack(p, p.subtitles[0].id)
    expect(p.subtitles).toHaveLength(0)
    expect(p.clips).toHaveLength(0)
    const legacy = { ...newProject() } as Partial<Project>
    delete legacy.subtitles
    expect(parseProject(JSON.parse(JSON.stringify(legacy))).subtitles).toEqual([])
  })

  it('parses and formats timecodes', () => {
    expect(formatTimecode(3723.4567, ',')).toBe('01:02:03,457')
    expect(formatTimecode(59.9996)).toBe('00:01:00.000')
    expect(parseTimecode('1:02:03,5')).toBeCloseTo(3723.5)
    expect(parseTimecode('2:03.25')).toBeCloseTo(123.25)
    expect(parseTimecode('7.5')).toBe(7.5)
    expect(parseTimecode('abc')).toBeNull()
  })
})

describe('subtitle files', () => {
  const p = subtitleProject()
  const track = p.subtitles[0]
  const opts = { fps: 30, width: 1920, height: 1080 }

  it('writes SRT that reads back identically', () => {
    const srt = writeSubtitles('srt', track, track.cues, opts)
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,500\nSecond line\nwith a break\n')
    expect(parseSrt(srt).map((c) => [c.start, c.end, c.text])).toEqual(track.cues.map((c) => [c.start, c.end, c.text]))
  })

  it('writes SBV that reads back identically', () => {
    const sbv = writeSubtitles('sbv', track, track.cues, opts)
    expect(sbv.startsWith('0:00:01.000,0:00:02.000\nHello there\n')).toBe(true)
    expect(parseSbv(sbv).map((c) => [c.start, c.end, c.text])).toEqual(track.cues.map((c) => [c.start, c.end, c.text]))
  })

  it('writes the other formats', () => {
    expect(writeSubtitles('vtt', track, track.cues, opts)).toContain('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello there')
    expect(writeSubtitles('ass', track, track.cues, opts)).toContain('Dialogue: 0,0:00:03.00,0:00:04.50,Default,,0,0,0,,Second line\\Nwith a break')
    expect(writeSubtitles('sub', track, track.cues, opts)).toBe('{30}{60}Hello there\n{90}{135}Second line|with a break\n')
    expect(writeSubtitles('ttml', track, track.cues, opts)).toContain('<p begin="00:00:03.000" end="00:00:04.500">Second line<br/>with a break</p>')
    expect(writeSubtitles('lrc', track, track.cues, opts)).toContain('[00:01.00]Hello there\n[00:02.00]\n[00:03.00]Second line with a break')
    expect(writeSubtitles('txt', track, track.cues, opts)).toBe('[00:00:01] Hello there\n[00:00:03] Second line with a break\n')
    expect(SUBTITLE_FORMATS.length).toBeGreaterThanOrEqual(10)
  })

  it('reads SRT with missing indexes, dot decimals and tags', () => {
    const cues = parseSrt('\uFEFF00:00:01.5 --> 00:00:02,25\n<i>Hi</i>\n\n\n7\n00:00:03,000 --> 00:00:04,000\nBye\n')
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([[1.5, 2.25, 'Hi'], [3, 4, 'Bye']])
  })
})

describe('ffmpeg reads the files we write', () => {
  beforeAll(() => setupFfmpeg())
  const p = subtitleProject()
  const track = p.subtitles[0]
  for (const [format, ext] of [['srt', 'srt'], ['vtt', 'vtt'], ['ass', 'ass'], ['ssa', 'ssa'], ['smi', 'smi'], ['sub', 'sub'], ['lrc', 'lrc']]) {
    it(format, async () => {
      const file = join(TMP, `subs_check.${ext}`)
      writeFileSync(file, writeSubtitles(format, track, track.cues, { fps: 30, width: 1920, height: 1080 }), 'utf8')
      // `.sub` is also the DVD bitmap format's extension, so MicroDVD has to be named explicitly.
      const args = ['-hide_banner', '-loglevel', 'error', ...(format === 'sub' ? ['-f', 'microdvd', '-subfps', '30'] : []), '-i', file, '-f', 'srt', '-']
      const srt = execFileSync(getFfmpegPaths().ffmpeg, args).toString()
      // LRC end markers come back as empty lines; the importer drops those too.
      const back = parseSrt(srt).filter((c) => c.text)
      expect(back.map((c) => c.text.replace(/\n/g, ' '))).toEqual(['Hello there', 'Second line with a break'])
      expect(back[0].start).toBeCloseTo(1, 1)
      // LRC has no end times: each line lasts until the next timestamp.
      if (format !== 'lrc') expect(back[1].end).toBeCloseTo(4.5, 1)
    })
  }
})

describe('importing subtitle files and streams', () => {
  beforeAll(() => setupFfmpeg())
  const p = subtitleProject()
  const track = p.subtitles[0]
  const expected = [[1, 2, 'Hello there'], [3, 4.5, 'Second line\nwith a break']]
  for (const ext of ['srt', 'vtt', 'ass', 'ssa', 'sbv', 'ttml', 'smi', 'sub', 'lrc']) {
    it(ext, async () => {
      const file = join(TMP, `import_check.de.${ext}`)
      writeFileSync(file, writeSubtitles(ext, track, track.cues, { fps: 30, width: 1920, height: 1080 }), 'utf8')
      const r = await readSubtitleFile(file, 30)
      expect(r.name).toBe('import_check')
      expect(r.language).toBe('deu')
      const got = r.cues.map((c) => [+c.start.toFixed(2), +c.end.toFixed(2), c.text])
      if (ext === 'lrc') {
        // No end times or line breaks in LRC: each line lasts until the next timestamp.
        expect(got.map((g) => g[2])).toEqual(['Hello there', 'Second line with a break'])
      } else if (ext === 'sub' || ext === 'ssa' || ext === 'smi') {
        expect(got.map((g) => [g[0], g[1]])).toEqual(expected.map((e) => [e[0], e[1]]))
      } else {
        expect(got).toEqual(expected)
      }
    })
  }

  it('reads UTF-16 and Windows-1252 files', async () => {
    const file16 = join(TMP, 'enc16.srt')
    writeFileSync(file16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCafé ☕\n', 'utf16le')]))
    expect((await readSubtitleFile(file16)).cues[0].text).toBe('Café ☕')
    const file1252 = join(TMP, 'enc1252.srt')
    writeFileSync(file1252, Buffer.from([...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf'), 0xe9, 0x0a]))
    expect((await readSubtitleFile(file1252)).cues[0].text).toBe('Café')
  })

  it('lists and extracts subtitle streams inside a video', async () => {
    const srt = join(TMP, 'embed.srt')
    writeFileSync(srt, writeSubtitles('srt', track, track.cues, { fps: 30, width: 1920, height: 1080 }))
    const mkv = join(TMP, 'with_subs.mkv')
    await ffmpeg(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=5', '-i', srt,
      '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s', 'srt', '-metadata:s:s:0', 'language=spa',
      '-metadata:s:s:0', 'title=Spanish', mkv])
    const streams = await listSubtitleStreams(mkv)
    expect(streams).toEqual([{ index: 0, codec: 'subrip', title: 'Spanish', language: 'spa', text: true }])
    const cues = await extractSubtitleStream(mkv, 0)
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual(expected)
  })
})

describe('burning subtitle clips into the video', () => {
  let caps: Caps
  let white = ''
  let yellow = ''
  let gap = ''
  const region = '200:40:220:290'
  beforeAll(async () => {
    setupFfmpeg()
    caps = await usableCapabilities()
    // Full-frame transparent images with an opaque box where a subtitle would be.
    const make = async (name: string, r: number, g: number, b: number, on: boolean) => {
      const file = join(TMP, name)
      const a = on ? `if(between(X,220,419)*between(Y,290,329),255,0)` : '0'
      await ffmpeg(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360,format=rgba',
        '-vf', `geq=r=${r}:g=${g}:b=${b}:a='${a}'`, '-frames:v', '1', file])
      return file
    }
    ;[white, yellow, gap] = await Promise.all([make('sub_w.png', 255, 255, 255, true), make('sub_y.png', 255, 255, 0, true), make('sub_gap.png', 0, 0, 0, false)])
  })

  let seq = 0
  async function exportProject(p: Project): Promise<string> {
    const subtitleClips: SubtitleClipAsset[] = p.clips
      .filter((c) => c.type === 'subtitles')
      .map((c) => ({
        clipId: c.id, w: 640, h: 360, k: 1, duration: c.duration, gap,
        cues: clipCues(c, p.subtitles[0]).map((x) => ({ image: x.cue.start === 1 ? white : yellow, start: x.start - c.start, end: x.end - c.start }))
      }))
    const out = join(TMP, `subs_${++seq}.mp4`)
    const settings = normalizeExportSettings({ ...defaultExportSettings(), quality: 40 }, caps.encoders)
    await runExport({ project: p, settings, outPath: out, tmpDir: join(TMP, `subjob_${seq}`), caps, subtitleClips })
    return out
  }
  const at = async (file: string, t: number) => {
    const [r, g, b] = await frameColor(file, t, region)
    return r > 200 && g > 200 && b > 200 ? 'white' : r > 200 && g > 200 && b < 60 ? 'yellow' : r < 30 && g < 30 && b < 30 ? 'none' : `rgb(${r},${g},${b})`
  }

  it('shows each cue exactly in its time range', async () => {
    const p = subtitleProject()
    addSubtitleClip(p, p.subtitles[0].id)
    const out = await exportProject(p)
    expect(await Promise.all([0.5, 1.05, 1.95, 2.5, 3.05, 4.4].map((t) => at(out, t)))).toEqual(['none', 'white', 'white', 'none', 'yellow', 'yellow'])
  })

  it('follows the clip when it is moved, stretched and split', async () => {
    const p = subtitleProject()
    const id = addSubtitleClip(p, p.subtitles[0].id)!
    const c = subClip(p)
    moveClips(p, { [id]: { start: c.start, trackId: c.trackId } }, 1) // cues at 2-3 and 4-5.5
    stretchClip(p, id, 'end', 2 + 7) // half speed: 2-4 and 6-9
    splitAt(p, 3)
    const out = await exportProject(p)
    expect(await Promise.all([1.5, 2.2, 3.5, 4.5, 6.2, 8.8].map((t) => at(out, t)))).toEqual(['none', 'white', 'white', 'none', 'yellow', 'yellow'])
  })

  it('applies effects on the subtitle clip', async () => {
    const p = subtitleProject()
    addSubtitleClip(p, p.subtitles[0].id)
    subClip(p).effects.push({ ...makeEffect('fadeIn'), params: { duration: 1 } })
    const out = await exportProject(p)
    const early = (await frameColor(out, 1.1, region))[0]
    const late = (await frameColor(out, 1.9, region))[0]
    expect(early).toBeLessThan(80)
    expect(late).toBeGreaterThan(200)
  })

  it('writes a concat list that covers the clip exactly', () => {
    const file = join(TMP, 'list_check.ffconcat')
    writeSubtitleList(file, { clipId: 'x', w: 1, h: 1, k: 1, duration: 5, gap: 'C:\\g.png', cues: [{ image: "it's.png", start: 1, end: 3 }, { image: 'b.png', start: 2, end: 4 }] })
    const text = readFileSync(file, 'utf8')
    const durations = [...text.matchAll(/duration ([\d.]+)/g)].map((m) => Number(m[1]))
    expect(durations).toEqual([1, 1, 2, 1])
    expect(text).toContain("file 'C:/g.png'")
    expect(text).toContain("file 'it'\\''s.png'")
  })
})

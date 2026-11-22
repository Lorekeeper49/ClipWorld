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

// Reading subtitle files and subtitle streams inside videos. SRT and SBV are read directly; most other
// text formats are converted to SRT by ffmpeg first. No Electron imports, so tests can use it.
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { SubtitleCue } from '@shared/model'
import { uid } from '@shared/model'
import { parseSbv, parseSrt, parseTimecode, sortCues } from '@shared/subtitles'
import { FfmpegError, getFfmpegPaths, run, tail } from './ffmpeg'
import { t } from '@shared/i18n'

export interface ReadSubtitles {
  name: string
  language: string
  cues: SubtitleCue[]
}

/** Decodes a text file, honouring UTF-8/UTF-16 byte-order marks and falling back to Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8
}

/** TTML / DFXP times: clock time (hh:mm:ss.fff or hh:mm:ss:ff) or offset (12.5s, 300ms, 90f). */
function ttmlTime(v: string | undefined, fps: number): number | null {
  if (!v) return null
  const off = /^([\d.]+)(h|m|s|ms|f)$/.exec(v.trim())
  if (off) {
    const n = Number(off[1])
    return off[2] === 'h' ? n * 3600 : off[2] === 'm' ? n * 60 : off[2] === 'ms' ? n / 1000 : off[2] === 'f' ? n / fps : n
  }
  const frames = /^(\d+):(\d{2}):(\d{2}):(\d+)$/.exec(v.trim())
  if (frames) return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) + Number(frames[4]) / fps
  return parseTimecode(v)
}

/** Minimal TTML/DFXP reader: <p begin end|dur> elements, <br/> as line breaks, tags stripped. */
export function parseTtml(xml: string, fps = 30): SubtitleCue[] {
  const out: SubtitleCue[] = []
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
  const entities = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&')
  for (const m of xml.matchAll(/<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/g)) {
    const start = ttmlTime(attr(m[1], 'begin'), fps)
    let end = ttmlTime(attr(m[1], 'end'), fps)
    const dur = ttmlTime(attr(m[1], 'dur'), fps)
    if (start === null) continue
    if (end === null && dur !== null) end = start + dur
    if (end === null) continue
    const text = entities(m[2].replace(/<(?:\w+:)?br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim()
    if (text) out.push({ id: uid('q'), start, end: Math.max(start, end), text })
  }
  sortCues(out)
  return out
}

/** Converts whatever ffmpeg can read (a subtitle file or a video's subtitle stream) to SRT text. */
async function ffmpegToSrt(args: string[]): Promise<string> {
  const r = await run(getFfmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args, '-f', 'srt', '-'])
  if (r.code !== 0 || !r.stdout.trim()) throw new FfmpegError(`${t('errors.subtitlesUnreadable')}\n${tail(r.stderr)}`, r.stderr)
  return r.stdout
}

const nonEmpty = (cues: SubtitleCue[]) => cues.filter((c) => c.text.trim() && c.end > c.start)

/** Reads a subtitle file of any supported format. `fps` is used by frame-based formats (MicroDVD, TTML frames). */
export async function readSubtitleFile(path: string, fps = 30): Promise<ReadSubtitles> {
  const ext = extname(path).slice(1).toLowerCase()
  const name = basename(path, extname(path))
  // "Movie.en.srt" style names carry the language.
  const langHint = /\.([a-z]{2,3})$/i.exec(name)?.[1]?.toLowerCase()
  const language = langHint && LANG_2_TO_3[langHint] ? LANG_2_TO_3[langHint] : langHint?.length === 3 ? langHint : 'eng'
  let cues: SubtitleCue[]
  if (ext === 'srt') cues = parseSrt(decodeText(readFileSync(path)))
  else if (ext === 'sbv') cues = parseSbv(decodeText(readFileSync(path)))
  else if (ext === 'ttml' || ext === 'dfxp' || ext === 'xml') cues = parseTtml(decodeText(readFileSync(path)), fps)
  else if (ext === 'sub') cues = parseSrt(await ffmpegToSrt(['-f', 'microdvd', '-subfps', String(fps || 25), '-i', path]))
  else cues = parseSrt(await ffmpegToSrt(['-i', path]))
  cues = nonEmpty(cues)
  if (!cues.length) throw new Error(t('errors.noSubtitlesIn', { name: basename(path) }))
  return { name: name.replace(/\.([a-z]{2,3})$/i, '') || t('subtitles.defaultTrackName'), language, cues }
}

export interface SubtitleStreamInfo {
  /** Index among the file's subtitle streams (ffmpeg `0:s:N`). */
  index: number
  codec: string
  title: string
  language: string
  /** Text-based streams can be imported; picture-based ones (DVD, Blu-ray) cannot. */
  text: boolean
}

const BITMAP_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext'])

export async function listSubtitleStreams(path: string): Promise<SubtitleStreamInfo[]> {
  const r = await run(getFfmpegPaths().ffprobe, ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=codec_name:stream_tags=language,title', '-of', 'json', path])
  if (r.code !== 0) return []
  const streams: any[] = JSON.parse(r.stdout).streams ?? []
  return streams.map((s, i) => ({
    index: i,
    codec: s.codec_name ?? 'unknown',
    title: s.tags?.title ?? '',
    language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : 'und',
    text: !BITMAP_CODECS.has(s.codec_name)
  }))
}

export async function extractSubtitleStream(path: string, index: number): Promise<SubtitleCue[]> {
  const cues = nonEmpty(parseSrt(await ffmpegToSrt(['-i', path, '-map', `0:s:${index}`])))
  if (!cues.length) throw new Error(t('errors.subtitleTrackEmpty'))
  return cues
}

const LANG_2_TO_3: Record<string, string> = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', ar: 'ara',
  hi: 'hin', nl: 'nld', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', tr: 'tur', uk: 'ukr', cs: 'ces', el: 'ell',
  he: 'heb', hu: 'hun', id: 'ind', th: 'tha', vi: 'vie', ro: 'ron'
}

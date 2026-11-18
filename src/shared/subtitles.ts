// Subtitle logic shared by the renderer, the main process and tests: lookup, mapping through
// timeline clips, and reading/writing subtitle file formats. Pure — no DOM, no Node.
import { type Clip, type SubtitleCue, type SubtitleStyle, type SubtitleTrack, clipEnd, uid } from './model'

const EPS = 1e-6

/** The cue showing at `t` (track time), if any. Cues are sorted by start; a later cue wins an overlap. */
export function cueAt(track: SubtitleTrack, t: number): SubtitleCue | undefined {
  const cues = track.cues
  // Binary search for the last cue starting at or before t.
  let lo = 0
  let hi = cues.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t + EPS) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  for (let i = found; i >= 0 && i >= found - 8; i--) {
    if (t >= cues[i].start - EPS && t < cues[i].end - EPS) return cues[i]
  }
  return undefined
}

/** Track time shown by a subtitle clip at timeline time `t`. */
export const clipTrackTime = (c: Clip, t: number): number => c.srcIn + (t - c.start) * c.speed

/** A cue as it appears on the timeline through a clip: clipped to the clip and in timeline seconds. */
export interface PlacedCue {
  cue: SubtitleCue
  start: number
  end: number
}

/** Cues a subtitle clip shows, in timeline time, clipped to the clip's range. */
export function clipCues(c: Clip, track: SubtitleTrack): PlacedCue[] {
  const from = c.srcIn
  const to = c.srcIn + c.duration * c.speed
  const out: PlacedCue[] = []
  for (const cue of track.cues) {
    if (cue.end <= from + EPS || cue.start >= to - EPS) continue
    const s = c.start + (Math.max(cue.start, from) - from) / c.speed
    const e = Math.min(clipEnd(c), c.start + (Math.min(cue.end, to) - from) / c.speed)
    if (e - s > EPS) out.push({ cue, start: s, end: e })
  }
  return out
}

/**
 * Cues of a track as they play in the edited video: through every subtitle clip of that track, in
 * timeline order. A track that is not on the timeline yields its cues unchanged.
 */
export function timelineCues(clips: Clip[], track: SubtitleTrack): SubtitleCue[] {
  const own = clips.filter((c) => c.type === 'subtitles' && c.subtitleTrackId === track.id).sort((a, b) => a.start - b.start)
  if (!own.length) return track.cues
  const out: SubtitleCue[] = []
  for (const c of own) for (const p of clipCues(c, track)) out.push({ ...p.cue, start: p.start, end: p.end })
  return out.sort((a, b) => a.start - b.start)
}

export function sortCues(cues: SubtitleCue[]): void {
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

// ---------------------------------------------------------------- timecodes

const pad = (v: number | string, n = 2) => String(v).padStart(n, '0')

/** Splits seconds into whole h/m/s and milliseconds (rounded, carrying correctly). */
function parts(t: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.max(0, Math.round(t * 1000))
  return { h: Math.floor(total / 3600000), m: Math.floor(total / 60000) % 60, s: Math.floor(total / 1000) % 60, ms: total % 1000 }
}

/** 00:01:02,345 (SRT) or 00:01:02.345 (VTT, display). */
export function formatTimecode(t: number, sep = '.'): string {
  const { h, m, s, ms } = parts(t)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`
}

/** Accepts h:mm:ss.mmm, mm:ss.mmm, ss.mmm (comma or dot), and plain seconds. Null when invalid. */
export function parseTimecode(text: string): number | null {
  const s = text.trim().replace(',', '.')
  if (!s) return null
  const pieces = s.split(':')
  if (pieces.length > 3 || pieces.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  let t = 0
  for (const p of pieces) t = t * 60 + Number(p)
  return Number.isFinite(t) ? t : null
}

// ---------------------------------------------------------------- formats

export interface SubtitleFormat {
  id: string
  ext: string
}

export const SUBTITLE_FORMATS: SubtitleFormat[] = [
  { id: 'srt', ext: 'srt' },
  { id: 'vtt', ext: 'vtt' },
  { id: 'ass', ext: 'ass' },
  { id: 'ssa', ext: 'ssa' },
  { id: 'sbv', ext: 'sbv' },
  { id: 'ttml', ext: 'ttml' },
  { id: 'smi', ext: 'smi' },
  { id: 'sub', ext: 'sub' },
  { id: 'lrc', ext: 'lrc' },
  { id: 'txt', ext: 'txt' }
]

/** Extensions the app can import (others are converted by ffmpeg where it can read them). */
export const SUBTITLE_IMPORT_EXTS = ['srt', 'vtt', 'ass', 'ssa', 'sbv', 'sub', 'smi', 'sami', 'lrc', 'ttml', 'dfxp', 'xml']
export const isSubtitleFile = (path: string): boolean =>
  SUBTITLE_IMPORT_EXTS.filter((e) => e !== 'xml').includes(path.split('.').pop()?.toLowerCase() ?? '')

const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n')
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** ASS colour: &HAABBGGRR with alpha 0 = opaque. */
function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) ?? ['', 'ff', 'ff', 'ff']
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
  return `&H${pad(a.toString(16).toUpperCase())}${m[3].toUpperCase()}${m[2].toUpperCase()}${m[1].toUpperCase()}`
}

/** ASS/SSA timestamps: h:mm:ss.cc */
function assTime(t: number): string {
  const total = Math.max(0, Math.round(t * 100))
  const cs = total % 100
  const s = Math.floor(total / 100) % 60
  const m = Math.floor(total / 6000) % 60
  const h = Math.floor(total / 360000)
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

/** Numpad alignment used by ASS (1-3 bottom, 4-6 middle, 7-9 top; left/centre/right). */
function assAlignment(st: SubtitleStyle, legacy: boolean): number {
  const col = st.align === 'left' ? 1 : st.align === 'right' ? 3 : 2
  if (legacy) return st.position === 'top' ? col + 4 : st.position === 'middle' ? col + 8 : col // SSA numbering
  return (st.position === 'top' ? 6 : st.position === 'middle' ? 3 : 0) + col
}

export interface WriteOptions {
  /** Frame rate for frame-based formats (MicroDVD). */
  fps: number
  /** Frame size the styling refers to (ASS/SSA PlayRes). */
  width: number
  height: number
  title?: string
}

export function writeSubtitles(format: string, track: SubtitleTrack, cues: SubtitleCue[], o: WriteOptions): string {
  const st = track.style
  const list = cues.filter((c) => c.end > c.start).slice().sort((a, b) => a.start - b.start)
  switch (format) {
    case 'srt':
      return list.map((c, i) => `${i + 1}\n${formatTimecode(c.start, ',')} --> ${formatTimecode(c.end, ',')}\n${c.text.trim()}\n`).join('\n')
    case 'vtt': {
      const line = st.position === 'top' ? ' line:5%' : st.position === 'middle' ? ' line:50%' : ''
      const align = st.align === 'center' ? '' : ` align:${st.align === 'left' ? 'start' : 'end'}`
      const body = list
        .map((c) => `${formatTimecode(c.start)} --> ${formatTimecode(c.end)}${line}${align}\n${c.text.trim().replace(/-->/g, '->')}\n`)
        .join('\n')
      return `WEBVTT${o.title ? ` - ${o.title}` : ''}\n\n${body}`
    }
    case 'ass':
    case 'ssa': {
      const legacy = format === 'ssa'
      // PlayRes is the project frame; font size is converted from reference pixels to it.
      const size = Math.round((st.fontSize * o.height) / 1080)
      const outline = Math.round(((st.outlineWidth * o.height) / 1080) * 10) / 10
      const marginV = Math.round(st.margin * o.height)
      const marginH = Math.round(((1 - st.maxWidth) / 2) * o.width)
      const header = [
        '[Script Info]',
        `Title: ${o.title ?? track.name}`,
        `ScriptType: ${legacy ? 'v4.00' : 'v4.00+'}`,
        `PlayResX: ${o.width}`,
        `PlayResY: ${o.height}`,
        'WrapStyle: 0',
        ''
      ]
      const text = (c: SubtitleCue) => c.text.trim().replace(/\n/g, '\\N').replace(/[{}]/g, '')
      if (legacy) {
        return [
          ...header,
          '[V4 Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding',
          `Style: Default,${st.fontFamily},${size},${ssaColor(st.fill)},${ssaColor(st.fill)},${ssaColor(st.outline)},${ssaColor(st.boxColor)},${st.bold ? -1 : 0},${st.italic ? -1 : 0},${st.box ? 3 : 1},${outline},0,${assAlignment(st, true)},${marginH},${marginH},${marginV},0,1`,
          '',
          '[Events]',
          'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          ...list.map((c) => `Dialogue: Marked=0,${assTime(c.start)},${assTime(c.end)},Default,,0000,0000,0000,,${text(c)}`),
          ''
        ].join('\n')
      }
      return [
        ...header,
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Default,${st.fontFamily},${size},${assColor(st.fill)},${assColor(st.fill)},${assColor(st.box ? st.boxColor : st.outline, st.box ? st.boxOpacity : 1)},${assColor(st.boxColor, st.box ? st.boxOpacity : 0)},${st.bold ? -1 : 0},${st.italic ? -1 : 0},0,0,100,100,0,0,${st.box ? 3 : 1},${st.box ? Math.max(outline, 4) : outline},0,${assAlignment(st, false)},${marginH},${marginH},${marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...list.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${text(c)}`),
        ''
      ].join('\n')
    }
    case 'sbv':
      return list.map((c) => `${sbvTime(c.start)},${sbvTime(c.end)}\n${c.text.trim()}\n`).join('\n')
    case 'ttml': {
      const lang = isoToBcp47(track.language)
      const origin = st.position === 'top' ? '10% 5%' : st.position === 'middle' ? '10% 40%' : '10% 70%'
      const body = list
        .map((c) => `      <p begin="${formatTimecode(c.start)}" end="${formatTimecode(c.end)}">${escXml(c.text.trim()).replace(/\n/g, '<br/>')}</p>`)
        .join('\n')
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="${lang}">`,
        '  <head>',
        '    <styling>',
        `      <style xml:id="s1" tts:fontFamily="${escXml(st.fontFamily)}" tts:color="${st.fill}" tts:fontWeight="${st.bold ? 'bold' : 'normal'}" tts:fontStyle="${st.italic ? 'italic' : 'normal'}" tts:textAlign="${st.align}"${st.box ? ` tts:backgroundColor="${st.boxColor}${pad(Math.round(st.boxOpacity * 255).toString(16))}"` : ''}/>`,
        '    </styling>',
        '    <layout>',
        `      <region xml:id="r1" tts:origin="${origin}" tts:extent="80% 25%" tts:displayAlign="${st.position === 'top' ? 'before' : st.position === 'middle' ? 'center' : 'after'}"/>`,
        '    </layout>',
        '  </head>',
        '  <body style="s1" region="r1">',
        '    <div>',
        body,
        '    </div>',
        '  </body>',
        '</tt>',
        ''
      ].join('\n')
    }
    case 'smi': {
      const lang = isoToBcp47(track.language)
      const cls = `${lang.replace(/-/g, '').toUpperCase()}CC`
      const rows: string[] = []
      list.forEach((c, i) => {
        rows.push(`<SYNC Start=${Math.round(c.start * 1000)}><P Class=${cls}>${escXml(c.text.trim()).replace(/\n/g, '<br>')}`)
        const next = list[i + 1]
        if (!next || next.start > c.end + 0.001) rows.push(`<SYNC Start=${Math.round(c.end * 1000)}><P Class=${cls}>&nbsp;`)
      })
      return [
        '<SAMI>',
        '<HEAD>',
        `<TITLE>${escXml(o.title ?? track.name)}</TITLE>`,
        '<STYLE TYPE="text/css">',
        '<!--',
        `P { font-family: ${st.fontFamily}; color: ${st.fill}; text-align: ${st.align}; }`,
        `.${cls} { Name: ${escXml(track.name)}; lang: ${lang}; }`,
        '-->',
        '</STYLE>',
        '</HEAD>',
        '<BODY>',
        ...rows,
        '</BODY>',
        '</SAMI>',
        ''
      ].join('\n')
    }
    case 'sub': {
      const fps = o.fps > 0 ? o.fps : 25
      return list.map((c) => `{${Math.round(c.start * fps)}}{${Math.round(c.end * fps)}}${c.text.trim().replace(/\n/g, '|')}`).join('\n') + '\n'
    }
    case 'lrc': {
      const t = (v: number) => {
        const cs = Math.max(0, Math.round(v * 100))
        return `[${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}]`
      }
      const rows: string[] = [`[ti:${o.title ?? track.name}]`]
      list.forEach((c, i) => {
        rows.push(`${t(c.start)}${c.text.trim().replace(/\n/g, ' ')}`)
        const next = list[i + 1]
        if (!next || next.start > c.end + 0.01) rows.push(t(c.end))
      })
      return rows.join('\n') + '\n'
    }
    case 'txt':
      return list.map((c) => `[${formatTimecode(c.start).slice(0, 8)}] ${c.text.trim().replace(/\n/g, ' ')}`).join('\n') + '\n'
    default:
      throw new Error(`Unknown subtitle format: ${format}`)
  }
}

/** SSA colours are decimal BGR integers. */
function ssaColor(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return 16777215
  return parseInt(m[3], 16) * 65536 + parseInt(m[2], 16) * 256 + parseInt(m[1], 16)
}

function sbvTime(t: number): string {
  const { h, m, s, ms } = parts(t)
  return `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

const ISO_TO_BCP: Record<string, string> = {
  eng: 'en', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko',
  zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi', nld: 'nl', dut: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl',
  tur: 'tr', ukr: 'uk', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', heb: 'he', hun: 'hu', ind: 'id', tha: 'th', vie: 'vi',
  ron: 'ro', rum: 'ro', und: 'und'
}
export const isoToBcp47 = (iso: string): string => ISO_TO_BCP[iso] ?? (iso.length === 2 ? iso : 'und')

/** Subtitle languages offered in the Subtitles window (ISO 639-2). Their names come from the system, in the app's language. */
export const LANGUAGES: string[] = [
  'eng', 'spa', 'fra', 'deu', 'ita', 'por', 'rus', 'jpn', 'kor', 'zho', 'ara', 'hin', 'nld', 'swe', 'nor', 'dan', 'fin', 'pol',
  'tur', 'ukr', 'ces', 'ell', 'heb', 'hun', 'ind', 'tha', 'vie', 'ron', 'und'
]

// ---------------------------------------------------------------- readers

/** Reads SubRip text. Tolerates missing indexes, dot decimals, extra blank lines and basic tags. */
export function parseSrt(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = []
  const rows = lines(text.replace(/^\uFEFF/, ''))
  const arrow = /^\s*(\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3}|\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3}|\d{1,2}:\d{1,2}[,.]\d{1,3})/
  for (let i = 0; i < rows.length; i++) {
    const m = arrow.exec(rows[i])
    if (!m) continue
    const start = parseTimecode(m[1])
    const end = parseTimecode(m[2])
    const body: string[] = []
    let j = i + 1
    while (j < rows.length && rows[j].trim() !== '' && !arrow.exec(rows[j])) {
      body.push(rows[j])
      j++
    }
    // A bare number right before the next timing line is that cue's index, not text.
    if (j < rows.length && arrow.exec(rows[j]) && /^\d+$/.test(body[body.length - 1] ?? '')) body.pop()
    i = j - 1
    if (start === null || end === null) continue
    const textOut = body.join('\n').replace(/<\/?(b|i|u|font)[^>]*>/gi, '').replace(/\{\\[^}]*\}/g, '').trim()
    out.push({ id: uid('q'), start, end: Math.max(end, start), text: textOut })
  }
  sortCues(out)
  return out
}

/** Reads YouTube SubViewer (.sbv): "h:mm:ss.mmm,h:mm:ss.mmm" followed by text lines. */
export function parseSbv(text: string): SubtitleCue[] {
  const out: SubtitleCue[] = []
  const rows = lines(text.replace(/^\uFEFF/, ''))
  const timing = /^\s*(\d+:\d{1,2}:\d{1,2}\.\d{1,3}),(\d+:\d{1,2}:\d{1,2}\.\d{1,3})\s*$/
  for (let i = 0; i < rows.length; i++) {
    const m = timing.exec(rows[i])
    if (!m) continue
    const body: string[] = []
    let j = i + 1
    while (j < rows.length && rows[j].trim() !== '') body.push(rows[j++])
    i = j
    const start = parseTimecode(m[1])
    const end = parseTimecode(m[2])
    if (start !== null && end !== null) out.push({ id: uid('q'), start, end: Math.max(start, end), text: body.join('\n').trim() })
  }
  sortCues(out)
  return out
}

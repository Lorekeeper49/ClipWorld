// Turns a project into an ffmpeg invocation: input arguments, a filter_complex script and output
// arguments. Pure — the caller writes the script to disk and spawns ffmpeg.
import { animExpr, clamp, num, transformAt } from './easing'
import {
  EFFECT_MAP, SAMPLE_RATE, atempoChain, audioEffectFfmpeg, b, cssEffectFfmpeg, n, parseColor, s
} from './effects'
import {
  type ExportSettings, AUDIO_CODECS, CONTAINER_MAP, audioEncoderArgs, pixelFormatFor, videoEncoderArgs
} from './formats'
import {
  type Clip, type MediaItem, type Project, type ProjectSettings, REF_HEIGHT, fitSize, isTimed, projectDuration
} from './model'

export interface TextAsset {
  path: string
  /** Layer size in project pixels. */
  w: number
  h: number
  /** Raster scale: the PNG is (w*k) x (h*k) pixels. */
  k: number
}

export interface ExportAssets {
  /** Rasterised text, by clip id. */
  text: Record<string, TextAsset>
  /** Rasterised overlay effects (gradient, vignette), by effect id. */
  overlays: Record<string, string>
  /** Reverb impulse responses (WAV), by effect id. */
  irs: Record<string, string>
  /**
   * Subtitle clips, by clip id: `path` is an ffconcat list of full-frame transparent PNGs (one per
   * cue, plus gaps) timed in clip-local seconds; w/h is the frame size and k the raster scale.
   */
  subtitles: Record<string, TextAsset>
}

export interface Caps {
  encoders: string[]
  filters: string[]
}

export interface BuiltExport {
  inputArgs: string[]
  filter: string
  outputArgs: string[]
  duration: number
  hasVideo: boolean
  hasAudio: boolean
}

export interface LayerInfo {
  /** Layer size in project pixels before any transform. */
  bw: number
  bh: number
  /** Working-resolution factor: the layer is processed at (bw*q) x (bh*q) so scaling up stays sharp. */
  q: number
  w: number
  h: number
}

/** Geometry of a visual clip's layer. Shared with the renderer so overlay assets match. */
export function layerInfo(c: Clip, media: MediaItem | undefined, st: ProjectSettings, text?: { w: number; h: number; k: number }): LayerInfo | null {
  let bw: number
  let bh: number
  let srcLimit: number
  if (c.type === 'text' || c.type === 'subtitles') {
    // Subtitles are full-frame layers: `text` carries the frame size and raster scale for them.
    if (!text) return null
    bw = text.w
    bh = text.h
    srcLimit = text.k
  } else {
    if (!media) return null
    const f = fitSize(media.width, media.height, st.width, st.height)
    bw = f.w
    bh = f.h
    srcLimit = media.width / bw
  }
  const sMax = c.transform.animate ? Math.max(c.transform.start.scale, c.transform.end.scale) : c.transform.start.scale
  const zMax = c.zoom.enabled ? Math.max(c.zoom.start, c.zoom.end, 1) : 1
  const areaLimit = Math.sqrt(33_000_000 / Math.max(1, bw * bh))
  const q = clamp(sMax * zMax, 1, Math.max(1, Math.min(4, srcLimit, areaLimit)))
  return { bw, bh, q, w: Math.max(2, Math.round(bw * q)), h: Math.max(2, Math.round(bh * q)) }
}

const hasEffect = (c: Clip, type: string) => c.effects.some((e) => e.enabled && e.type === type)

function colorMatrixFor(media: MediaItem): string {
  if (media.kind !== 'video') return ''
  const cs = (media.colorSpace ?? '').toLowerCase()
  if (cs && cs !== 'unknown' && cs !== 'unspecified') return ':in_color_matrix=auto'
  return media.height >= 720 ? ':in_color_matrix=bt709' : ':in_color_matrix=bt601'
}

class Graph {
  inputs: string[][] = []
  chains: string[] = []
  private counter = 0
  addInput(args: string[]): number {
    this.inputs.push(args)
    return this.inputs.length - 1
  }
  label(prefix = 'x'): string {
    return `[${prefix}${this.counter++}]`
  }
}

/** A linear run of filters that can be flushed into the graph to obtain a label. */
class Chain {
  private pending: string[] = []
  constructor(private g: Graph, public cur: string) {}
  add(...filters: string[]): this {
    this.pending.push(...filters.filter(Boolean))
    return this
  }
  flush(): string {
    if (this.pending.length) {
      const out = this.g.label()
      this.g.chains.push(`${this.cur}${this.pending.join(',')}${out}`)
      this.cur = out
      this.pending = []
    }
    return this.cur
  }
}

function buildVisualLayer(g: Graph, c: Clip, p: Project, assets: ExportAssets): { label: string; animatedSize: boolean } | null {
  const st = p.settings
  const fps = st.fps
  const media = c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined
  const textAsset = c.type === 'text' ? assets.text[c.id] : c.type === 'subtitles' ? assets.subtitles?.[c.id] : undefined
  const info = layerInfo(c, media, st, textAsset)
  if (!info) return null
  const D = c.duration
  const kRef = (st.height / REF_HEIGHT) * info.q
  const { w: W0, h: H0 } = info

  // ---- input
  let chain: Chain
  if (c.type === 'text') {
    const i = g.addInput(['-loop', '1', '-framerate', num(fps), '-t', num(D), '-i', textAsset!.path])
    chain = new Chain(g, `[${i}:v]`).add(`scale=${W0}:${H0}:flags=bicubic`, 'format=rgba', 'setsar=1')
  } else if (c.type === 'subtitles') {
    // One input per clip however many cues it has: the list already holds clip-local timing (speed included).
    const i = g.addInput(['-f', 'concat', '-safe', '0', '-i', textAsset!.path])
    chain = new Chain(g, `[${i}:v]`).add(
      'setpts=PTS-STARTPTS', `fps=${num(fps)}`, `scale=${W0}:${H0}:flags=bicubic`, 'format=rgba', 'setsar=1', `trim=duration=${num(D)}`
    )
  } else if (!isTimed(c, media)) {
    const i = g.addInput(['-loop', '1', '-framerate', num(fps), '-t', num(D), '-i', media!.path])
    chain = new Chain(g, `[${i}:v]`).add(`scale=${W0}:${H0}:flags=bicubic`, 'format=rgba', 'setsar=1')
  } else {
    const i = g.addInput(['-ss', num(c.srcIn), '-t', num(D * c.speed), '-an', '-i', media!.path])
    chain = new Chain(g, `[${i}:v]`).add(
      Math.abs(c.speed - 1) > 1e-9 ? `setpts=(PTS-STARTPTS)/${num(c.speed)}` : 'setpts=PTS-STARTPTS',
      `fps=${num(fps)}`,
      `scale=${W0}:${H0}:flags=bicubic${colorMatrixFor(media!)}`,
      'format=rgba',
      'setsar=1',
      `trim=duration=${num(D)}`
    )
  }
  let alpha = c.type === 'text' || c.type === 'subtitles' || !!media?.hasAlpha

  // ---- effects, in stack order (drop shadow and fades are applied after zoom)
  for (const e of c.effects) {
    if (!e.enabled) continue
    const def = EFFECT_MAP[e.type]
    if (!def || def.target !== 'video') continue
    if (def.kind === 'css') {
      chain.add(...cssEffectFfmpeg(e, kRef))
      continue
    }
    if (def.kind === 'overlay') {
      const path = assets.overlays[e.id]
      if (!path) continue
      const i = g.addInput(['-i', path])
      const ov = g.label('ov')
      g.chains.push(`[${i}:v]scale=${W0}:${H0}:flags=bilinear,format=rgba${ov}`)
      const cur = chain.flush()
      if (alpha) {
        const a = g.label()
        const bl = g.label()
        const o = g.label()
        const m = g.label()
        const out = g.label()
        g.chains.push(`${cur}split${a}${bl}`)
        g.chains.push(`${a}${ov}overlay=format=auto:eof_action=repeat${o}`)
        g.chains.push(`${bl}alphaextract${m}`)
        g.chains.push(`${o}${m}alphamerge${out}`)
        chain = new Chain(g, out)
      } else {
        const out = g.label()
        g.chains.push(`${cur}${ov}overlay=format=auto:eof_action=repeat${out}`)
        chain = new Chain(g, out)
      }
      continue
    }
    switch (e.type) {
      case 'tint': {
        const [r, gr, bl] = parseColor(s(e, 'color'))
        const a = clamp(n(e, 'amount'), 0, 1)
        const f = (c0: number) => `clip(val*${num(1 - a, 4)}+${num(c0 * a, 3)},0,255)`
        chain.add(`lutrgb=r='${f(r)}':g='${f(gr)}':b='${f(bl)}'`)
        break
      }
      case 'flip':
        if (b(e, 'horizontal')) chain.add('hflip')
        if (b(e, 'vertical')) chain.add('vflip')
        break
      case 'pixelate': {
        const block = Math.max(2, Math.round(n(e, 'size') * kRef))
        chain.add(
          `scale=${Math.max(1, Math.round(W0 / block))}:${Math.max(1, Math.round(H0 / block))}:flags=area`,
          `scale=${W0}:${H0}:flags=neighbor`
        )
        break
      }
      case 'sharpen': {
        const a = Math.round(clamp(n(e, 'amount'), 0, 2) * 100)
        if (a > 0) {
          const kern = `0 -${a} 0 -${a} ${100 + 4 * a} -${a} 0 -${a} 0`
          chain.add(
            'format=gbrap',
            `convolution=0m='${kern}':1m='${kern}':2m='${kern}':3m='0 0 0 0 1 0 0 0 0':0rdiv=0.01:1rdiv=0.01:2rdiv=0.01:3rdiv=1`,
            'format=rgba'
          )
        }
        break
      }
      case 'noise': {
        const amt = Math.round(clamp(n(e, 'amount'), 0, 1) * 60)
        if (amt > 0) {
          chain.add('format=gbrap', `noise=c0s=${amt}:c1s=${amt}:c2s=${amt}:c0f=t+u:c1f=t+u:c2f=t+u`, 'format=rgba')
        }
        break
      }
      case 'chromaKey': {
        const [r, gr, bl] = parseColor(s(e, 'color'))
        const hex = [r, gr, bl].map((v) => v.toString(16).padStart(2, '0')).join('')
        chain.add(
          'format=yuva444p',
          `chromakey=color=0x${hex}:similarity=${num(clamp(n(e, 'similarity'), 0.01, 1), 4)}:blend=${num(clamp(n(e, 'smoothness'), 0, 1), 4)}`,
          'format=rgba'
        )
        alpha = true
        break
      }
    }
  }

  // ---- zoom: scale the content about a focal point inside the clip's own frame
  const z = c.zoom
  if (z.enabled && (z.start !== 1 || z.end !== 1)) {
    const Z = animExpr(z.start, z.end, z.ease, 't', 0, D)
    const animated = z.start !== z.end
    const cur = chain.flush()
    const zb = g.label('zb')
    const zs = g.label('zs')
    const out = g.label()
    g.chains.push(`color=c=black@0:s=${W0}x${H0}:r=${num(fps)}:d=${num(D)},format=rgba${zb}`)
    g.chains.push(`${cur}scale=w='max(2,iw*${Z})':h='max(2,ih*${Z})':flags=bilinear:eval=${animated ? 'frame' : 'init'}${zs}`)
    g.chains.push(
      `${zb}${zs}overlay=x='(W-w)*${num(z.focusX, 4)}':y='(H-h)*${num(z.focusY, 4)}':eval=${animated ? 'frame' : 'init'}:eof_action=pass:format=auto,trim=duration=${num(D)}${out}`
    )
    chain = new Chain(g, out)
    if (Math.min(z.start, z.end) < 1) alpha = true
  }

  // ---- drop shadow
  const shadow = c.effects.find((e) => e.enabled && e.type === 'dropShadow')
  if (shadow) {
    const sigma = n(shadow, 'blur') * kRef
    const dist = n(shadow, 'distance') * kRef
    const ang = (n(shadow, 'angle') * Math.PI) / 180
    const dx = Math.round(Math.cos(ang) * dist)
    const dy = Math.round(Math.sin(ang) * dist)
    const m = Math.ceil(3 * sigma + dist) + 2
    const [r, gr, bl] = parseColor(s(shadow, 'color'))
    const op = clamp(n(shadow, 'opacity'), 0, 1)
    const cur = chain.flush()
    const o = g.label()
    const sh = g.label()
    const sh2 = g.label()
    const o2 = g.label()
    const out = g.label()
    g.chains.push(`${cur}split${o}${sh}`)
    g.chains.push(
      `${sh}pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m + dx}:y=${m + dy}:color=black@0,` +
        `lutrgb=r=${r}:g=${gr}:b=${bl}:a='val*${num(op, 4)}'` +
        (sigma > 0.05 ? `,gblur=sigma=${num(sigma, 3)}:steps=2` : '') +
        sh2
    )
    g.chains.push(`${o}pad=w=iw+${2 * m}:h=ih+${2 * m}:x=${m}:y=${m}:color=black@0${o2}`)
    g.chains.push(`${sh2}${o2}overlay=format=auto${out}`)
    chain = new Chain(g, out)
    alpha = true
  }

  // ---- fades
  for (const e of c.effects) {
    if (!e.enabled) continue
    const d = Math.min(n(e, 'duration'), D)
    if (d <= 0) continue
    if (e.type === 'fadeIn') chain.add(`fade=t=in:st=0:d=${num(d, 4)}:alpha=1`)
    else if (e.type === 'fadeOut') chain.add(`fade=t=out:st=${num(Math.max(0, D - d), 4)}:d=${num(d, 4)}:alpha=1`)
  }

  // ---- transform: rotate, scale, opacity (position is applied by the compositing overlay)
  const tr = c.transform
  const a0 = tr.start
  const a1 = tr.animate ? tr.end : tr.start
  if (a0.rotation !== 0 || a1.rotation !== 0) {
    const A = animExpr((a0.rotation * Math.PI) / 180, (a1.rotation * Math.PI) / 180, tr.ease, 't', 0, D)
    chain.add(`rotate=a='${A}':ow='hypot(iw,ih)':oh=ow:c=black@0`)
  }
  const animatedSize = a0.scale !== a1.scale
  const S = animExpr(a0.scale / info.q, a1.scale / info.q, tr.ease, 't', 0, D)
  if (animatedSize) {
    chain.add(`scale=w='max(2,iw*${S})':h='max(2,ih*${S})':flags=bilinear:eval=frame`)
  } else if (Math.abs(a0.scale / info.q - 1) > 1e-6) {
    chain.add(`scale=w='max(2,iw*${S})':h='max(2,ih*${S})':flags=bicubic`)
  }
  if (a0.opacity !== a1.opacity) {
    const id = `colorchannelmixer@op${g.label('').replace(/\W/g, '')}`
    const frames = Math.max(1, Math.ceil(D * fps))
    const step = Math.max(1, Math.ceil(frames / 20000))
    const cmds: string[] = []
    for (let f = 0; f <= frames; f += step) {
      const t = f / fps
      cmds.push(`${num(t, 5)} ${id} aa ${num(clamp(transformAt(tr, t, D).opacity, 0, 1), 4)}`)
    }
    chain.add(`sendcmd=c='${cmds.join(';')}'`, `${id}=aa=${num(clamp(a0.opacity, 0, 1), 4)}`)
  } else if (a0.opacity < 1) {
    chain.add(`colorchannelmixer=aa=${num(clamp(a0.opacity, 0, 1), 4)}`)
  }
  chain.add(`setpts=PTS+${num(c.start)}/TB`)
  return { label: chain.flush(), animatedSize }
}

function buildAudioClip(g: Graph, c: Clip, p: Project, assets: ExportAssets, caps: Caps): string | null {
  const media = p.media.find((m) => m.id === c.mediaId)
  if (!media || c.muted || c.volume <= 0) return null
  if (!media.audioStreams.some((a) => a.index === c.audioStream)) return null
  const D = c.duration
  const i = g.addInput(['-ss', num(c.srcIn), '-t', num(D * c.speed), '-vn', '-i', media.path])
  let chain = new Chain(g, `[${i}:a:${c.audioStream}]`).add(
    `aresample=${SAMPLE_RATE}`,
    'aformat=sample_fmts=fltp:channel_layouts=stereo'
  )
  if (Math.abs(c.speed - 1) > 1e-9) {
    if (c.preservePitch) chain.add(...atempoChain(c.speed))
    else chain.add(`asetrate=${num(SAMPLE_RATE * c.speed, 2)}`, `aresample=${SAMPLE_RATE}`)
  }
  const rubberband = caps.filters.includes('rubberband')
  for (const e of c.effects) {
    if (!e.enabled || EFFECT_MAP[e.type]?.target !== 'audio') continue
    if (e.type === 'reverb') {
      const path = assets.irs[e.id]
      if (!path) continue
      const ir = g.addInput(['-i', path])
      const cur = chain.flush()
      const out = g.label()
      g.chains.push(`${cur}[${ir}:a]afir=dry=1:wet=1:gtype=none:irnorm=-1:irgain=1${out}`)
      chain = new Chain(g, out)
      continue
    }
    chain.add(...audioEffectFfmpeg(e, D, rubberband))
  }
  if (Math.abs(c.volume - 1) > 1e-6) chain.add(`volume=${num(c.volume, 4)}`)
  chain.add(`atrim=end=${num(D)}`, 'asetpts=PTS-STARTPTS')
  const delay = Math.round(c.start * SAMPLE_RATE)
  if (delay > 0) chain.add(`adelay=${delay}S:all=1`)
  return chain.flush()
}

function mixAudio(g: Graph, labels: string[], total: number, out: string): void {
  const tail = `apad=whole_dur=${num(total)},atrim=end=${num(total)}${out}`
  if (labels.length === 1) g.chains.push(`${labels[0]}${tail}`)
  else g.chains.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0:duration=longest,${tail}`)
}

export function buildExport(p: Project, settings: ExportSettings, assets: ExportAssets, caps: Caps): BuiltExport {
  const container = CONTAINER_MAP[settings.container]
  if (!container) throw new Error(`Unknown format: ${settings.container}`)
  const st = p.settings
  const W = Math.max(2, Math.round(st.width / 2) * 2)
  const H = Math.max(2, Math.round(st.height / 2) * 2)
  const total = projectDuration(p)
  if (total <= 0) throw new Error('The timeline is empty')
  const g = new Graph()
  const outputArgs: string[] = []
  const wantVideo = container.video.length > 0
  const order = new Map(p.tracks.map((t, i) => [t.id, i]))

  // ---- video
  if (wantVideo) {
    const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id))
    const visual = p.clips
      .filter((c) => c.type !== 'audio' && !hidden.has(c.trackId))
      .sort((a, b2) => (order.get(b2.trackId) ?? 0) - (order.get(a.trackId) ?? 0) || a.start - b2.start)
    let bg = g.label('bg')
    g.chains.push(`color=c=black:s=${W}x${H}:r=${num(st.fps)}:d=${num(total)},format=rgba${bg}`)
    for (const c of visual) {
      const layer = buildVisualLayer(g, c, { ...p, settings: { ...st, width: W, height: H } }, assets)
      if (!layer) continue
      const tr = c.transform
      const a0 = tr.start
      const a1 = tr.animate ? tr.end : tr.start
      const X = animExpr(a0.x, a1.x, tr.ease, 't', c.start, c.duration)
      const Y = animExpr(a0.y, a1.y, tr.ease, 't', c.start, c.duration)
      const moving = layer.animatedSize || a0.x !== a1.x || a0.y !== a1.y
      const next = g.label('bg')
      g.chains.push(
        `${bg}${layer.label}overlay=x='(W-w)/2+W*${X}':y='(H-h)/2+H*${Y}':eval=${moving ? 'frame' : 'init'}:eof_action=pass:format=auto${next}`
      )
      bg = next
    }
    const enc = settings.videoEncoder
    if (enc === 'gif') {
      const gfps = Math.min(st.fps, 25)
      g.chains.push(`${bg}fps=${num(gfps)},split[gifa][gifb]`)
      g.chains.push('[gifa]palettegen=stats_mode=diff[gifp]')
      g.chains.push('[gifb][gifp]paletteuse=dither=bayer:bayer_scale=3[vout]')
    } else {
      g.chains.push(`${bg}scale=out_color_matrix=bt709:out_range=tv,format=${pixelFormatFor(enc)}[vout]`)
    }
    outputArgs.push('-map', '[vout]', ...videoEncoderArgs(enc, settings.quality, container.id))
    if (enc !== 'gif') {
      outputArgs.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv')
    }
    if (container.id === 'mp4' || container.id === 'mov') outputArgs.push('-movflags', '+faststart')
  }

  // ---- audio
  let hasAudio = false
  if (container.audio.length > 0) {
    const mutedTracks = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id))
    const audioClips = p.clips.filter((c) => c.type === 'audio' && !mutedTracks.has(c.trackId))
    const byTrack = new Map<string, string[]>()
    for (const c of audioClips) {
      const label = buildAudioClip(g, c, p, assets, caps)
      if (!label) continue
      const list = byTrack.get(c.trackId) ?? []
      list.push(label)
      byTrack.set(c.trackId, list)
    }
    const separate = settings.audioMode === 'separate' && wantVideo && container.id !== 'gif'
    if (byTrack.size > 0) {
      hasAudio = true
      if (separate) {
        const tracks = p.tracks.filter((t) => byTrack.has(t.id))
        tracks.forEach((t, i) => {
          mixAudio(g, byTrack.get(t.id)!, total, `[aout${i}]`)
          outputArgs.push('-map', `[aout${i}]`, `-metadata:s:a:${i}`, `title=${t.name}`)
        })
      } else {
        mixAudio(g, [...byTrack.values()].flat(), total, '[aout]')
        outputArgs.push('-map', '[aout]')
      }
      outputArgs.push(...audioEncoderArgs(settings.audioCodec, settings.audioBitrate), '-ar', String(SAMPLE_RATE))
    } else if (!wantVideo) {
      throw new Error('There is no audio on the timeline to export')
    }
  }
  if (AUDIO_CODECS[settings.audioCodec]?.encoder === 'libopus' && hasAudio) outputArgs.push('-ac', '2')

  outputArgs.push('-t', num(total))
  return {
    inputArgs: g.inputs.flat(),
    filter: g.chains.join(';\n'),
    outputArgs,
    duration: total,
    hasVideo: wantVideo,
    hasAudio
  }
}

/** Whether a clip needs a rasterised overlay asset for any of its effects. */
export function overlayEffects(c: Clip): string[] {
  return c.effects.filter((e) => e.enabled && EFFECT_MAP[e.type]?.kind === 'overlay').map((e) => e.id)
}

export { hasEffect }

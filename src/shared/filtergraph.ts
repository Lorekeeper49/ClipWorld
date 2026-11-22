// Turns a project into an ffmpeg invocation: input arguments, a filter_complex script and output
// arguments. Pure — the caller writes the script to disk and spawns ffmpeg.
import { CROP_SIDES, animExpr, clamp, cropBox, hasCrop, num, transformAt } from './easing'
import {
  EFFECT_MAP, SAMPLE_RATE, atempoChain, audioEffectFfmpeg, b, cssEffectFfmpeg, n, parseColor, s
} from './effects'
import {
  type ExportSettings, type GifTransparency, AUDIO_CODECS, CONTAINER_MAP, audioEncoderArgs, pixelFormatFor, videoEncoderArgs
} from './formats'
import {
  type Clip, type EffectInstance, type MediaItem, type Project, type ProjectSettings, REF_HEIGHT, fitSize, isTimed, projectDuration
} from './model'
import { type ReversePiece, clipSegments, reversePieces } from './loop'

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
  /** Reversed clips, by clip id: ffconcat lists of their pieces, already reversed (see reversedSource). */
  reversed?: Record<string, { v?: string; a?: string }>
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

/**
 * A looped clip's source as one stream on its virtual timeline (starting at 0, before speed): each pass is
 * its own exactly-trimmed input, a crossfade blends two, and the pieces are joined. Piece lengths are cut
 * on one frame (or sample) grid for the whole clip, so many passes never drift from the audio.
 */
function loopedSource(g: Graph, c: Clip, media: MediaItem, kind: 'v' | 'a'): string {
  const segs = clipSegments(c, media.duration)
  const rate = kind === 'v' ? (media.fps > 0 ? media.fps : 30) : SAMPLE_RATE
  const grid = (v: number) => Math.round((v - c.srcIn) * rate)
  // Many passes mean many decoders: keep each one's threads few.
  const threads = kind === 'v' && segs.length > 4 ? ['-threads', '2'] : []
  const piece = (src: number, len: number, count: number): string => {
    const i = g.addInput([...threads, '-ss', num(src), '-t', num(len + 1), kind === 'v' ? '-an' : '-vn', '-i', media.path])
    const out = g.label()
    g.chains.push(
      kind === 'v'
        ? `[${i}:v]setpts=PTS-STARTPTS,fps=${num(rate)},trim=end_frame=${count},setpts=PTS-STARTPTS,setsar=1${out}`
        : `[${i}:a:${c.audioStream}]asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `atrim=end_sample=${count},asetpts=PTS-STARTPTS${out}`
    )
    return out
  }
  const parts: string[] = []
  for (const sg of segs) {
    const count = grid(sg.v1) - grid(sg.v0)
    if (count <= 0) continue
    const len = sg.v1 - sg.v0
    const a = piece(sg.src, len, count)
    if (!sg.mix) {
      parts.push(a)
      continue
    }
    // Crossfade: the weight of the incoming source rises from p0 to p1 over the piece.
    const b = piece(sg.mix.src, len, count)
    const out = g.label()
    const w = (t: string) => `(${num(sg.mix!.p0, 6)}+${num(sg.mix!.p1 - sg.mix!.p0, 6)}*${t}/${num(len, 6)})`
    if (kind === 'v') {
      g.chains.push(`${a}${b}blend=all_expr='A*(1-${w('T')})+B*${w('T')}'${out}`)
    } else {
      const fa = g.label()
      const fb = g.label()
      g.chains.push(`${a}volume='cos(${w('t')}*PI/2)':eval=frame${fa}`)
      g.chains.push(`${b}volume='sin(${w('t')}*PI/2)':eval=frame${fb}`)
      g.chains.push(`${fa}${fb}amix=inputs=2:normalize=0:duration=first:dropout_transition=0${out}`)
    }
    parts.push(out)
  }
  if (parts.length === 1) return parts[0]
  const out = g.label()
  g.chains.push(`${parts.join('')}concat=n=${parts.length}:v=${kind === 'v' ? 1 : 0}:a=${kind === 'a' ? 1 : 0}${out}`)
  return out
}

// ---------------------------------------------------------------- reversed clips
//
// ffmpeg's reverse filters keep everything they reverse in memory, so a reversed clip is cut into short
// pieces (reversePieces) that are reversed one at a time. Before an export the main process renders each
// piece to a file of its own, one small ffmpeg run after another, and the export reads them back as one
// stream (assets.reversed). Without those files (tests, previews of the graph) the pieces go straight into
// the graph, which is only sensible for short clips: every piece is then held in memory at once.

/** Frames (or samples) in one reversed piece: at most about 300 MB of decoded picture, or 20 s of sound. */
export function reversePieceSize(media: MediaItem, kind: 'v' | 'a'): number {
  if (kind === 'a') return SAMPLE_RATE * 20
  const frame = Math.max(1, (media.width || 1920) * (media.height || 1080) * 1.5)
  return Math.max(8, Math.min(240, Math.floor(300e6 / frame)))
}

/** The grid a reversed clip is cut on: the file's frame rate, or the export's sample rate. */
export const reverseRate = (media: MediaItem, kind: 'v' | 'a'): number => (kind === 'v' ? (media.fps > 0 ? media.fps : 30) : SAMPLE_RATE)

/**
 * The filters that play one reversed piece. `a` (and `b` for a crossfade) is the file from the piece's
 * source time onward; `out` receives the piece backwards. Pictures come out as RGB so the pieces, wherever
 * they are stored, need no further color-matrix guesswork.
 */
export function reversePieceChains(
  kind: 'v' | 'a', media: MediaItem, piece: ReversePiece, a: string, b: string | null, out: string, label: () => string
): string[] {
  const rate = reverseRate(media, kind)
  const len = piece.count / rate
  const one = (input: string, o: string) =>
    kind === 'v'
      ? `${input}setpts=PTS-STARTPTS,fps=${num(rate)},trim=end_frame=${piece.count},reverse,setpts=PTS-STARTPTS,` +
        `scale=iw:ih:flags=bicubic${colorMatrixFor(media)},format=${media.hasAlpha ? 'rgba' : 'rgb24'},setsar=1${o}`
      : `${input}asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=end_sample=${piece.count},areverse,asetpts=PTS-STARTPTS${o}`
  if (!piece.mix || !b) return [one(a, out)]
  const ra = label()
  const rb = label()
  // Played backwards, the piece starts at its last frame in file order, where the incoming weight is p1.
  const { p0, p1 } = piece.mix
  const w = (t: string) => `(${num(p1, 6)}+${num(p0 - p1, 6)}*${t}/${num(len, 6)})`
  const chains = [one(a, ra), one(b, rb)]
  if (kind === 'v') {
    chains.push(`${ra}${rb}blend=all_expr='A*(1-${w('T')})+B*${w('T')}'${out}`)
  } else {
    const fa = label()
    const fb = label()
    chains.push(`${ra}volume='cos(${w('t')}*PI/2)':eval=frame${fa}`)
    chains.push(`${rb}volume='sin(${w('t')}*PI/2)':eval=frame${fb}`)
    chains.push(`${fa}${fb}amix=inputs=2:normalize=0:duration=first:dropout_transition=0${out}`)
  }
  return chains
}

/** Input options that read a reversed piece's file from its source time (one extra second for the decoder). */
export const reversePieceInput = (kind: 'v' | 'a', media: MediaItem, src: number, count: number): string[] =>
  ['-ss', num(src), '-t', num(count / reverseRate(media, kind) + 1), kind === 'v' ? '-an' : '-vn', '-sn', '-dn', '-i', media.path]

/** A reversed clip's source as one stream (starting at 0, before speed): the rendered pieces, or the pieces themselves. */
function reversedSource(g: Graph, c: Clip, media: MediaItem, kind: 'v' | 'a', assets: ExportAssets): string {
  const list = assets.reversed?.[c.id]?.[kind]
  if (list) {
    const i = g.addInput(['-f', 'concat', '-safe', '0', '-i', list])
    const out = g.label()
    g.chains.push(
      kind === 'v'
        ? `[${i}:v]setpts=PTS-STARTPTS${out}`
        : `[${i}:a]asetpts=PTS-STARTPTS,aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo${out}`
    )
    return out
  }
  const pieces = reversePieces(c, media.duration, reverseRate(media, kind), reversePieceSize(media, kind))
  const threads = kind === 'v' && pieces.length > 2 ? ['-threads', '2'] : []
  const stream = (i: number) => (kind === 'v' ? `[${i}:v]` : `[${i}:a:${c.audioStream}]`)
  const parts: string[] = []
  for (const pc of pieces) {
    const a = stream(g.addInput([...threads, ...reversePieceInput(kind, media, pc.src, pc.count)]))
    const b = pc.mix ? stream(g.addInput([...threads, ...reversePieceInput(kind, media, pc.mix.src, pc.count)])) : null
    const out = g.label()
    g.chains.push(...reversePieceChains(kind, media, pc, a, b, out, () => g.label()))
    parts.push(out)
  }
  if (parts.length === 1) return parts[0]
  const out = g.label()
  g.chains.push(`${parts.join('')}concat=n=${parts.length}:v=${kind === 'v' ? 1 : 0}:a=${kind === 'a' ? 1 : 0}${out}`)
  return out
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

/**
 * Multiplies a layer's alpha by a gray mask stream of the same size (255 shows, 0 hides), after the
 * mask's optional invert and feather. Returns the label of the masked layer.
 */
function applyMask(g: Graph, layer: string, mask: string, e: EffectInstance, pxScale: number): string {
  let m = mask
  const post: string[] = []
  if (b(e, 'invert')) post.push('negate')
  const sigma = n(e, 'feather') * pxScale
  if (sigma > 0.05) post.push(`gblur=sigma=${num(sigma, 3)}:steps=2`)
  if (post.length) {
    const o = g.label('m')
    g.chains.push(`${m}${post.join(',')}${o}`)
    m = o
  }
  const l1 = g.label()
  const l2 = g.label()
  const al = g.label('a')
  const mm = g.label('m')
  const out = g.label()
  g.chains.push(`${layer}split${l1}${l2}`)
  g.chains.push(`${l2}alphaextract${al}`)
  g.chains.push(`${al}${m}blend=all_mode=multiply${mm}`)
  g.chains.push(`${l1}${mm}alphamerge${out}`)
  return out
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
    const back = !!c.reverse && c.type === 'video'
    const source = back
      ? reversedSource(g, c, media!, 'v', assets)
      : c.loop
        ? loopedSource(g, c, media!, 'v')
        : `[${g.addInput(['-ss', num(c.srcIn), '-t', num(D * c.speed), '-an', '-i', media!.path])}:v]`
    chain = new Chain(g, source).add(
      Math.abs(c.speed - 1) > 1e-9 ? `setpts=(PTS-STARTPTS)/${num(c.speed)}` : 'setpts=PTS-STARTPTS',
      `fps=${num(fps)}`,
      // Reversed pieces are RGB already.
      `scale=${W0}:${H0}:flags=bicubic${back ? '' : colorMatrixFor(media!)}`,
      'format=rgba',
      'setsar=1',
      `trim=duration=${num(D)}`
    )
  }
  let alpha = c.type === 'text' || c.type === 'subtitles' || !!media?.hasAlpha

  // ---- color and image masks: hide parts of the clip before any other effect
  for (const e of c.effects) {
    if (!e.enabled) continue
    if (e.type === 'colorMask') {
      const [r, gr, bl] = parseColor(s(e, 'color'))
      const hex = [r, gr, bl].map((v) => v.toString(16).padStart(2, '0')).join('')
      const cur = chain.flush()
      const keep = g.label()
      const probe = g.label()
      const m = g.label('m')
      g.chains.push(`${cur}split${keep}${probe}`)
      // colorkey compares RGB distance; the copy is made opaque first so only the color decides.
      g.chains.push(
        `${probe}format=rgb24,format=rgba,colorkey=color=0x${hex}:similarity=${num(clamp(n(e, 'tolerance'), 0.00001, 1), 5)}:blend=${num(clamp(n(e, 'softness'), 0, 1), 5)},alphaextract${m}`
      )
      chain = new Chain(g, applyMask(g, keep, m, e, kRef))
      alpha = true
    } else if (e.type === 'imageMask') {
      const img = p.media.find((x) => x.id === s(e, 'image') && x.kind === 'image' && !x.animated)
      if (!img) continue
      const i = g.addInput(['-loop', '1', '-framerate', num(fps), '-t', num(D), '-i', img.path])
      const m = g.label('m')
      // Brightness uses the same weights as the preview (0.299/0.587/0.114), computed in full range.
      const mix = s(e, 'mode') === 'alpha' ? 'aa=1' : 'ar=0.299:ag=0.587:ab=0.114:aa=0'
      g.chains.push(`[${i}:v]scale=${W0}:${H0}:flags=bicubic,format=rgba,colorchannelmixer=${mix},alphaextract,setsar=1${m}`)
      chain = new Chain(g, applyMask(g, chain.flush(), m, e, kRef))
      alpha = true
    }
  }

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

  // ---- crop: transparent edges, after zoom and before the shadow (as in the preview)
  if (hasCrop(c.transform)) {
    const tr = c.transform
    const s0 = tr.start
    const s1 = tr.animate ? tr.end : tr.start
    // drawbox reads a width or height of 0 as "the whole frame", so an empty side sits off-frame instead.
    const geom = (side: (typeof CROP_SIDES)[number], v: number) => cropBox(side, v, W0, H0) ?? { x: -W0 - 10, y: 0, w: 1, h: 1 }
    const opts = (b: { x: number; y: number; w: number; h: number }) => `x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}`
    for (const side of CROP_SIDES) {
      if (s0[side] <= 0 && s1[side] <= 0) continue
      if (s0[side] === s1[side]) {
        chain.add(`drawbox=${opts(geom(side, s0[side]))}:color=black@0:replace=1:t=fill`)
        continue
      }
      // Animated: send the box's new geometry on every frame where it changes.
      const id = `drawbox@${side}${g.label('').replace(/\W/g, '')}`
      const frames = Math.max(1, Math.ceil(D * fps))
      const cmds: string[] = []
      let last = ''
      for (let f = 0; f <= frames; f++) {
        const b = geom(side, transformAt(tr, f / fps, D)[side])
        const key = opts(b)
        if (key === last) continue
        last = key
        cmds.push(`${num(f / fps, 5)} ${id} x ${b.x}, ${id} y ${b.y}, ${id} w ${b.w}, ${id} h ${b.h}`)
      }
      chain.add(`sendcmd=c='${cmds.join(';')}'`, `${id}=${opts(geom(side, s0[side]))}:color=black@0:replace=1:t=fill`)
    }
    alpha = true
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
  let chain = c.reverse
    ? new Chain(g, reversedSource(g, c, media, 'a', assets))
    : c.loop
    ? new Chain(g, loopedSource(g, c, media, 'a'))
    : new Chain(g, `[${g.addInput(['-ss', num(c.srcIn), '-t', num(D * c.speed), '-vn', '-i', media.path])}:a:${c.audioStream}]`).add(
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

/** A transparent GIF's chosen color made see-through, the way the Color mask does it to a clip. */
function gifColorKey(g: Graph, frame: string, t: GifTransparency, pxScale: number): string {
  const [r, gr, bl] = parseColor(t.color)
  const hex = [r, gr, bl].map((v) => v.toString(16).padStart(2, '0')).join('')
  const keep = g.label()
  const probe = g.label()
  const solid = g.label()
  const key = g.label('m')
  const a = g.label('a')
  const m = g.label('m')
  g.chains.push(`${frame}split=3${keep}${probe}${solid}`)
  g.chains.push(
    `${probe}format=rgb24,format=rgba,colorkey=color=0x${hex}:similarity=${num(clamp(t.tolerance, 0.00001, 1), 5)}:blend=${num(clamp(t.softness, 0, 1), 5)},alphaextract${key}`
  )
  // What is already see-through counts as hidden too, so feathering never brings back a clip's edge next to
  // empty parts of the frame.
  g.chains.push(`${solid}alphaextract${a}`)
  g.chains.push(`${key}${a}blend=all_mode=multiply${m}`)
  const e: EffectInstance = { id: 'gif', type: 'colorMask', enabled: true, params: { feather: t.feather, invert: false } }
  return applyMask(g, keep, m, e, pxScale)
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
    const enc = settings.videoEncoder
    // A transparent GIF starts from a see-through frame instead of black.
    const gifAlpha = enc === 'gif' && settings.gif?.transparent
    let bg = g.label('bg')
    g.chains.push(`color=c=${gifAlpha ? 'black@0' : 'black'}:s=${W}x${H}:r=${num(st.fps)}:d=${num(total)},format=rgba${bg}`)
    for (const c of visual) {
      const layer = buildVisualLayer(g, c, { ...p, settings: { ...st, width: W, height: H } }, assets)
      if (!layer) continue
      const tr = c.transform
      const a0 = tr.start
      const a1 = tr.animate ? tr.end : tr.start
      const X = animExpr(a0.x, a1.x, tr.ease, 't', c.start, c.duration)
      const Y = animExpr(a0.y, a1.y, tr.ease, 't', c.start, c.duration)
      const moving = layer.animatedSize || a0.x !== a1.x || a0.y !== a1.y
      const place = `x='(W-w)/2+W*${X}':y='(H-h)/2+H*${Y}':eval=${moving ? 'frame' : 'init'}`
      let diff = c.effects.find((e) => e.enabled && e.type === 'differenceMask')
      // A clean background that is missing (deleted media) leaves the clip unmasked.
      const plate = diff && s(diff, 'reference') === 'plate'
        ? p.media.find((x) => x.id === s(diff!, 'plate') && (x.kind === 'video' || (x.kind === 'image' && !x.animated)))
        : undefined
      if (diff && s(diff, 'reference') === 'plate' && !plate) diff = undefined
      const next = g.label('bg')
      if (!diff) {
        g.chains.push(`${bg}${layer.label}overlay=${place}:eof_action=pass:format=auto${next}`)
      } else {
        // Difference mask: the clip, as placed in the frame, is compared with a reference picture (what is
        // underneath it, or a clean background) and becomes transparent where they match. Everything runs
        // on the timeline clock from 0 (the clip sits on a transparent full-length frame), so the
        // comparison streams frame by frame instead of buffering everything before the clip starts.
        const base = g.label('cb')
        const pos = g.label('pos')
        const keep = g.label('bg')
        const ref = g.label('ref')
        const p1 = g.label('p')
        const p2 = g.label('p')
        const ga = g.label()
        const gb = g.label()
        const m = g.label('m')
        g.chains.push(`color=c=black@0:s=${W}x${H}:r=${num(st.fps)}:d=${num(total)},format=rgba${base}`)
        g.chains.push(`${base}${layer.label}overlay=${place}:eof_action=pass:format=auto${pos}`)
        if (plate) {
          // One frame of the clean background, fitted into the frame like an untransformed clip, held
          // for the whole timeline.
          const at = plate.kind === 'video' ? clamp(n(diff, 'plateTime'), 0, Math.max(0, plate.duration - 0.05)) : 0
          const i = g.addInput(plate.kind === 'video' ? ['-ss', num(at), '-an', '-i', plate.path] : ['-i', plate.path])
          const f = fitSize(plate.width, plate.height, W, H)
          g.chains.push(
            `[${i}:v]trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/(${num(st.fps)}*TB),` +
              `scale=${f.w}:${f.h}:flags=bicubic${colorMatrixFor(plate)},format=rgba,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
              `trim=duration=${num(total)}${ref}`
          )
          g.chains.push(`${bg}null${keep}`)
        } else {
          g.chains.push(`${bg}split${keep}${ref}`)
        }
        g.chains.push(`${pos}split${p1}${p2}`)
        g.chains.push(`${p1}format=gbrap${ga}`)
        g.chains.push(`${ref}format=gbrap${gb}`)
        g.chains.push(
          `${ga}${gb}blend=all_mode=difference,format=rgb24,format=rgba,colorkey=color=0x000000:similarity=${num(clamp(n(diff, 'tolerance'), 0.00001, 1), 5)}:blend=${num(clamp(n(diff, 'softness'), 0, 1), 5)},alphaextract${m}`
        )
        const masked = applyMask(g, p2, m, diff, H / REF_HEIGHT)
        g.chains.push(`${keep}${masked}overlay=0:0:format=auto${next}`)
      }
      bg = next
    }
    if (enc === 'gif') {
      const gfps = Math.min(st.fps, 25)
      if (gifAlpha && settings.gif.key) bg = gifColorKey(g, bg, settings.gif, H / REF_HEIGHT)
      g.chains.push(`${bg}fps=${num(gfps)},split[gifa][gifb]`)
      g.chains.push(`[gifa]palettegen=stats_mode=diff${gifAlpha ? ':reserve_transparent=1' : ''}[gifp]`)
      // GIF pixels are see-through or solid: anything under half opaque becomes see-through.
      g.chains.push(`[gifb][gifp]paletteuse=dither=bayer:bayer_scale=3${gifAlpha ? ':alpha_threshold=128' : ''}[vout]`)
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

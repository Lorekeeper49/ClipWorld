// Effect registry. Each effect is defined once here: its parameters, the CSS-filter form the
// preview uses, and the ffmpeg filter form the export uses. Colour filters follow the CSS filter
// spec maths on both sides so the preview and the export agree.
import { num } from './easing'
import type { EffectInstance, ParamValue } from './model'
import { uid } from './model'

/** Names shown in the app are messages: effects.<type>.name, effects.<type>.params.<key>, effects.<type>.options.<key>.<value>. */
export interface ParamDef {
  key: string
  /** 'media': the id of a still image in the project's Media (image masks). */
  type: 'number' | 'color' | 'boolean' | 'select' | 'media'
  default: ParamValue
  min?: number
  max?: number
  step?: number
  unit?: string
  /** Display multiplier (e.g. 100 to show 0..1 as a percentage). */
  display?: number
  options?: { value: string }[]
  /** 'media' params: which kinds of media can be picked (default: still images). */
  accept?: ('image' | 'video')[]
  /** Only shown (and used) when another parameter has this value. */
  showIf?: { key: string; value: ParamValue }
  /**
   * What can be typed in the box, when that's not the default (see fieldLimits). min/max are only the
   * slider's comfortable range.
   */
  limit?: [number, number]
}

/**
 * Limits for typing a setting's value. Proportions (0–100%) stay between 0 and 100%. Anything else can go
 * past the slider's maximum, and below its minimum only where that minimum is negative (angles, gains).
 * Settings with a real limit (in ffmpeg or the preview) say so with `limit`.
 */
export function fieldLimits(p: ParamDef): { min?: number; max?: number } {
  if (p.limit) return { min: p.limit[0], max: p.limit[1] }
  if (p.max === 1 && p.display === 100 && (p.min ?? 0) >= 0) return { min: p.min, max: p.max }
  return { min: (p.min ?? 0) >= 0 ? p.min : undefined }
}

/**
 * How the effect is rendered:
 *  css      – expressible as a CSS filter function (preview) and a simple ffmpeg filter (export)
 *  overlay  – a raster image (gradient, vignette) drawn over the clip, rasterised identically for both
 *  special  – needs dedicated handling on each side
 *  mask     – hides parts of the clip; applied before other effects (the difference mask after
 *             placement, since it compares the clip with what is underneath it)
 */
export type EffectKind = 'css' | 'overlay' | 'special' | 'mask'

export interface EffectDef {
  type: string
  target: 'video' | 'audio'
  group: string
  kind: EffectKind
  params: ParamDef[]
}

const pct = { min: 0, max: 1, step: 0.01, display: 100, unit: '%' } as const

export const EFFECTS: EffectDef[] = [
  // ---- colour
  { type: 'brightness', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1.2, min: 0, max: 3, step: 0.01, display: 100, unit: '%' }] },
  { type: 'contrast', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1.2, min: 0, max: 3, step: 0.01, display: 100, unit: '%' }] },
  { type: 'saturation', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1.4, min: 0, max: 2, step: 0.01, display: 100, unit: '%' }] },
  { type: 'hue', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'degrees', type: 'number', default: 90, min: -180, max: 180, step: 1, unit: '°' }] },
  { type: 'grayscale', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1, ...pct }] },
  { type: 'sepia', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1, ...pct }] },
  { type: 'invert', target: 'video', group: 'Color', kind: 'css',
    params: [{ key: 'amount', type: 'number', default: 1, ...pct }] },
  { type: 'tint', target: 'video', group: 'Color', kind: 'special',
    params: [
      { key: 'color', type: 'color', default: '#ff8800' },
      { key: 'amount', type: 'number', default: 0.3, ...pct }
    ] },
  { type: 'gradient', target: 'video', group: 'Color', kind: 'overlay',
    params: [
      { key: 'color1', type: 'color', default: '#ff2d95' },
      { key: 'color2', type: 'color', default: '#2d6bff' },
      { key: 'angle', type: 'number', default: 90, min: 0, max: 360, step: 1, unit: '°' },
      { key: 'opacity', type: 'number', default: 0.5, ...pct }
    ] },
  // ---- stylise
  { type: 'blur', target: 'video', group: 'Stylize', kind: 'css',
    params: [{ key: 'radius', type: 'number', default: 8, min: 0, max: 100, step: 0.5, unit: 'px' }] },
  { type: 'sharpen', target: 'video', group: 'Stylize', kind: 'special',
    params: [{ key: 'amount', type: 'number', default: 0.5, min: 0, max: 2, step: 0.01, display: 100, unit: '%', limit: [0, 2] }] },
  { type: 'pixelate', target: 'video', group: 'Stylize', kind: 'special',
    params: [{ key: 'size', type: 'number', default: 16, min: 2, max: 128, step: 1, unit: 'px' }] },
  { type: 'vignette', target: 'video', group: 'Stylize', kind: 'overlay',
    params: [
      { key: 'amount', type: 'number', default: 0.6, ...pct },
      { key: 'size', type: 'number', default: 0.5, ...pct }
    ] },
  { type: 'noise', target: 'video', group: 'Stylize', kind: 'special',
    params: [{ key: 'amount', type: 'number', default: 0.2, ...pct }] },
  { type: 'dropShadow', target: 'video', group: 'Stylize', kind: 'special',
    params: [
      { key: 'color', type: 'color', default: '#000000' },
      { key: 'opacity', type: 'number', default: 0.7, ...pct },
      { key: 'blur', type: 'number', default: 12, min: 0, max: 100, step: 0.5, unit: 'px' },
      { key: 'distance', type: 'number', default: 12, min: 0, max: 200, step: 1, unit: 'px' },
      { key: 'angle', type: 'number', default: 45, min: 0, max: 360, step: 1, unit: '°' }
    ] },
  { type: 'chromaKey', target: 'video', group: 'Stylize', kind: 'special',
    params: [
      { key: 'color', type: 'color', default: '#00ff00' },
      { key: 'similarity', type: 'number', default: 0.3, min: 0.01, max: 1, step: 0.01, display: 100, unit: '%' },
      { key: 'smoothness', type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, display: 100, unit: '%' }
    ] },
  { type: 'flip', target: 'video', group: 'Stylize', kind: 'special',
    params: [
      { key: 'horizontal', type: 'boolean', default: true },
      { key: 'vertical', type: 'boolean', default: false }
    ] },
  // ---- masks
  { type: 'colorMask', target: 'video', group: 'Mask', kind: 'mask',
    params: [
      { key: 'color', type: 'color', default: '#00ff00' },
      { key: 'tolerance', type: 'number', default: 0.15, min: 0.01, max: 1, step: 0.005, display: 100, unit: '%' },
      { key: 'softness', type: 'number', default: 0.05, ...pct },
      { key: 'feather', type: 'number', default: 0, min: 0, max: 50, step: 0.5, unit: 'px' },
      { key: 'invert', type: 'boolean', default: false }
    ] },
  { type: 'imageMask', target: 'video', group: 'Mask', kind: 'mask',
    params: [
      { key: 'image', type: 'media', default: '' },
      { key: 'mode', type: 'select', default: 'luma', options: [
        { value: 'luma' },
        { value: 'alpha' }
      ] },
      { key: 'feather', type: 'number', default: 0, min: 0, max: 50, step: 0.5, unit: 'px' },
      { key: 'invert', type: 'boolean', default: false }
    ] },
  { type: 'differenceMask', target: 'video', group: 'Mask', kind: 'mask',
    params: [
      { key: 'reference', type: 'select', default: 'below', options: [
        { value: 'below' },
        { value: 'plate' }
      ] },
      { key: 'plate', type: 'media', default: '', accept: ['image', 'video'], showIf: { key: 'reference', value: 'plate' } },
      { key: 'plateTime', type: 'number', default: 0, min: 0, max: 86400, step: 0.1, unit: 's', showIf: { key: 'reference', value: 'plate' } },
      { key: 'tolerance', type: 'number', default: 0.08, min: 0.01, max: 1, step: 0.005, display: 100, unit: '%' },
      { key: 'softness', type: 'number', default: 0.06, ...pct },
      { key: 'feather', type: 'number', default: 1, min: 0, max: 50, step: 0.5, unit: 'px' },
      { key: 'invert', type: 'boolean', default: false }
    ] },
  { type: 'fadeIn', target: 'video', group: 'Transition', kind: 'special',
    params: [{ key: 'duration', type: 'number', default: 0.5, min: 0, max: 10, step: 0.05, unit: 's' }] },
  { type: 'fadeOut', target: 'video', group: 'Transition', kind: 'special',
    params: [{ key: 'duration', type: 'number', default: 0.5, min: 0, max: 10, step: 0.05, unit: 's' }] },

  // ---- audio
  { type: 'pitch', target: 'audio', group: 'Audio', kind: 'special',
    // The preview's pitch shifter goes at most two octaves either way.
    params: [{ key: 'semitones', type: 'number', default: 4, min: -12, max: 12, step: 0.1, unit: 'st', limit: [-24, 24] }] },
  { type: 'distortion', target: 'audio', group: 'Audio', kind: 'special',
    params: [
      { key: 'drive', type: 'number', default: 8, min: 1, max: 50, step: 0.5, unit: '×' },
      { key: 'level', type: 'number', default: 0.6, ...pct }
    ] },
  { type: 'bitcrush', target: 'audio', group: 'Audio', kind: 'special',
    params: [
      { key: 'bits', type: 'number', default: 6, min: 1, max: 16, step: 1, unit: 'bit', limit: [1, 32] },
      { key: 'downsample', type: 'number', default: 6, min: 1, max: 50, step: 1, unit: '×', limit: [1, 250] }
    ] },
  { type: 'echo', target: 'audio', group: 'Audio', kind: 'special',
    params: [
      // The preview's echo can delay at most 4 s, and the repeats reach twice the delay; 100% feedback never dies away.
      { key: 'delay', type: 'number', default: 300, min: 20, max: 2000, step: 10, unit: 'ms', limit: [1, 2000] },
      { key: 'feedback', type: 'number', default: 0.4, min: 0, max: 0.9, step: 0.01, display: 100, unit: '%', limit: [0, 0.95] }
    ] },
  { type: 'reverb', target: 'audio', group: 'Audio', kind: 'special',
    params: [
      { key: 'size', type: 'number', default: 1.5, min: 0.2, max: 6, step: 0.1, unit: 's', limit: [0.05, 30] },
      { key: 'mix', type: 'number', default: 0.35, ...pct }
    ] },
  { type: 'lowpass', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'frequency', type: 'number', default: 1200, min: 60, max: 20000, step: 10, unit: 'Hz', limit: [10, 23000] }] },
  { type: 'highpass', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'frequency', type: 'number', default: 800, min: 20, max: 12000, step: 10, unit: 'Hz', limit: [10, 23000] }] },
  { type: 'bass', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'gain', type: 'number', default: 8, min: -20, max: 20, step: 0.5, unit: 'dB', limit: [-40, 40] }] },
  { type: 'treble', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'gain', type: 'number', default: 6, min: -20, max: 20, step: 0.5, unit: 'dB', limit: [-40, 40] }] },
  { type: 'tremolo', target: 'audio', group: 'Audio', kind: 'special',
    params: [
      { key: 'rate', type: 'number', default: 6, min: 0.1, max: 20, step: 0.1, unit: 'Hz', limit: [0.1, 1000] },
      { key: 'depth', type: 'number', default: 0.7, ...pct }
    ] },
  { type: 'audioFadeIn', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'duration', type: 'number', default: 0.5, min: 0, max: 10, step: 0.05, unit: 's' }] },
  { type: 'audioFadeOut', target: 'audio', group: 'Audio', kind: 'special',
    params: [{ key: 'duration', type: 'number', default: 0.5, min: 0, max: 10, step: 0.05, unit: 's' }] }
]

export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECTS.map((e) => [e.type, e]))

export function makeEffect(type: string): EffectInstance {
  const def = EFFECT_MAP[type]
  if (!def) throw new Error(`Unknown effect: ${type}`)
  const params: Record<string, ParamValue> = {}
  for (const p of def.params) params[p.key] = p.default
  return { id: uid('e'), type, enabled: true, params }
}

export const n = (e: EffectInstance, key: string): number => {
  const v = e.params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const d = EFFECT_MAP[e.type]?.params.find((p) => p.key === key)?.default
  return typeof d === 'number' ? d : 0
}
export const s = (e: EffectInstance, key: string): string => String(e.params[key] ?? '')
export const b = (e: EffectInstance, key: string): boolean => !!e.params[key]

export function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** Total opacity multiplier contributed by fade effects at local clip time. */
export function fadeFactor(effects: EffectInstance[], local: number, duration: number, audio = false): number {
  let f = 1
  for (const e of effects) {
    if (!e.enabled) continue
    const d = n(e, 'duration')
    if (d <= 0) continue
    if (e.type === (audio ? 'audioFadeIn' : 'fadeIn')) f *= Math.min(1, Math.max(0, local / d))
    else if (e.type === (audio ? 'audioFadeOut' : 'fadeOut')) f *= Math.min(1, Math.max(0, (duration - local) / d))
  }
  return f
}

// ---------------------------------------------------------------- colour maths (CSS filter spec)

type M3 = [number, number, number, number, number, number, number, number, number]

function saturateMatrix(v: number): M3 {
  return [
    0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v,
    0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v,
    0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v
  ]
}
function hueMatrix(deg: number): M3 {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const sn = Math.sin(a)
  return [
    0.213 + c * 0.787 - sn * 0.213, 0.715 - c * 0.715 - sn * 0.715, 0.072 - c * 0.072 + sn * 0.928,
    0.213 - c * 0.213 + sn * 0.143, 0.715 + c * 0.285 + sn * 0.14, 0.072 - c * 0.072 - sn * 0.283,
    0.213 - c * 0.213 - sn * 0.787, 0.715 - c * 0.715 + sn * 0.715, 0.072 + c * 0.928 + sn * 0.072
  ]
}
function grayscaleMatrix(amount: number): M3 {
  const g = 1 - Math.min(1, Math.max(0, amount))
  return [
    0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g,
    0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g,
    0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g
  ]
}
function sepiaMatrix(amount: number): M3 {
  const g = 1 - Math.min(1, Math.max(0, amount))
  return [
    0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g,
    0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g,
    0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g
  ]
}
function ccm(m: M3): string {
  const c = (v: number) => num(Math.min(2, Math.max(-2, v)), 5)
  return `colorchannelmixer=rr=${c(m[0])}:rg=${c(m[1])}:rb=${c(m[2])}:gr=${c(m[3])}:gg=${c(m[4])}:gb=${c(m[5])}:br=${c(m[6])}:bg=${c(m[7])}:bb=${c(m[8])}`
}
function lutAll(expr: string): string {
  return `lutrgb=r='${expr}':g='${expr}':b='${expr}'`
}

/** CSS filter function for `css` effects. `px` converts reference pixels to canvas pixels. */
export function cssFilter(e: EffectInstance, px: number): string | null {
  switch (e.type) {
    case 'brightness': return `brightness(${num(n(e, 'amount'), 4)})`
    case 'contrast': return `contrast(${num(n(e, 'amount'), 4)})`
    case 'saturation': return `saturate(${num(n(e, 'amount'), 4)})`
    case 'hue': return `hue-rotate(${num(n(e, 'degrees'), 3)}deg)`
    case 'grayscale': return `grayscale(${num(n(e, 'amount'), 4)})`
    case 'sepia': return `sepia(${num(n(e, 'amount'), 4)})`
    case 'invert': return `invert(${num(n(e, 'amount'), 4)})`
    case 'blur': return n(e, 'radius') > 0 ? `blur(${num(n(e, 'radius') * px, 3)}px)` : null
    default: return null
  }
}

/** ffmpeg filters for `css` effects, operating on an RGBA stream. `k` is frame height / REF_HEIGHT. */
export function cssEffectFfmpeg(e: EffectInstance, k: number): string[] {
  switch (e.type) {
    case 'brightness': return [lutAll(`clip(val*${num(n(e, 'amount'), 4)},0,255)`)]
    case 'contrast': return [lutAll(`clip((val-127.5)*${num(n(e, 'amount'), 4)}+127.5,0,255)`)]
    case 'saturation': return [ccm(saturateMatrix(n(e, 'amount')))]
    case 'hue': return [ccm(hueMatrix(n(e, 'degrees')))]
    case 'grayscale': return [ccm(grayscaleMatrix(n(e, 'amount')))]
    case 'sepia': return [ccm(sepiaMatrix(n(e, 'amount')))]
    case 'invert': {
      const a = Math.min(1, Math.max(0, n(e, 'amount')))
      return [lutAll(`clip(val*${num(1 - 2 * a, 4)}+${num(255 * a, 3)},0,255)`)]
    }
    case 'blur': {
      const sigma = n(e, 'radius') * k
      return sigma > 0.05 ? [`gblur=sigma=${num(sigma, 3)}:steps=2`] : []
    }
    default: return []
  }
}

// ---------------------------------------------------------------- audio

export const SAMPLE_RATE = 48000

export function semitoneRatio(st: number): number {
  return 2 ** (st / 12)
}

/** atempo accepts 0.5..100; chain several for values below 0.5. */
export function atempoChain(tempo: number): string[] {
  const out: string[] = []
  let t = tempo
  while (t < 0.5) {
    out.push('atempo=0.5')
    t /= 0.5
  }
  while (t > 100) {
    out.push('atempo=100')
    t /= 100
  }
  if (Math.abs(t - 1) > 1e-6) out.push(`atempo=${num(t, 6)}`)
  return out
}

/** Echo taps equivalent to a feedback delay line, truncated once inaudible. */
export function echoTaps(delayMs: number, feedback: number): { delays: number[]; decays: number[] } {
  const delays: number[] = []
  const decays: number[] = []
  let g = feedback
  for (let i = 1; i <= 24 && g > 0.02 && delayMs * i <= 90000; i++) {
    delays.push(delayMs * i)
    decays.push(g)
    g *= feedback
  }
  if (!delays.length) {
    delays.push(delayMs)
    decays.push(Math.max(0.001, feedback))
  }
  return { delays, decays }
}

/**
 * ffmpeg filters for audio effects that need no extra input. Reverb is handled by the caller
 * because it convolves with an impulse-response input.
 */
export function audioEffectFfmpeg(e: EffectInstance, duration: number, hasRubberband: boolean): string[] {
  switch (e.type) {
    case 'pitch': {
      const r = semitoneRatio(n(e, 'semitones'))
      if (Math.abs(r - 1) < 1e-4) return []
      if (hasRubberband) return [`rubberband=pitch=${num(r, 6)}`]
      return [`asetrate=${num(SAMPLE_RATE * r, 2)}`, `aresample=${SAMPLE_RATE}`, ...atempoChain(1 / r)]
    }
    case 'distortion':
      return [`volume=${num(n(e, 'drive'), 3)}:precision=float`, 'asoftclip=type=tanh', `volume=${num(n(e, 'level'), 4)}`]
    case 'bitcrush':
      return [`acrusher=level_in=1:level_out=1:bits=${num(n(e, 'bits'), 0)}:mix=1:mode=lin:aa=0:samples=${num(n(e, 'downsample'), 0)}`]
    case 'echo': {
      const { delays, decays } = echoTaps(n(e, 'delay'), n(e, 'feedback'))
      return [`aecho=in_gain=1:out_gain=1:delays=${delays.map((d) => num(d, 1)).join('|')}:decays=${decays.map((d) => num(d, 4)).join('|')}`]
    }
    case 'lowpass': return [`lowpass=f=${num(n(e, 'frequency'), 1)}`]
    case 'highpass': return [`highpass=f=${num(n(e, 'frequency'), 1)}`]
    case 'bass': return [`bass=g=${num(n(e, 'gain'), 2)}:f=100`]
    case 'treble': return [`treble=g=${num(n(e, 'gain'), 2)}:f=3000`]
    case 'tremolo': return [`tremolo=f=${num(n(e, 'rate'), 3)}:d=${num(n(e, 'depth'), 3)}`]
    case 'audioFadeIn': {
      const d = Math.min(n(e, 'duration'), duration)
      return d > 0 ? [`afade=t=in:st=0:d=${num(d, 4)}`] : []
    }
    case 'audioFadeOut': {
      const d = Math.min(n(e, 'duration'), duration)
      return d > 0 ? [`afade=t=out:st=${num(Math.max(0, duration - d), 4)}:d=${num(d, 4)}`] : []
    }
    default: return []
  }
}

/**
 * Deterministic stereo reverb impulse response: a direct impulse of (1 - mix) followed by an
 * exponentially decaying noise tail carrying `mix` of the energy. The dry/wet balance is baked into
 * the response so the preview convolver and ffmpeg's afir (written to a WAV) do exactly the same thing.
 */
export function reverbImpulse(seconds: number, mix: number, sampleRate = SAMPLE_RATE): [Float32Array, Float32Array] {
  const wet = Math.min(1, Math.max(0, mix))
  const len = Math.max(64, Math.floor(seconds * sampleRate))
  const out: [Float32Array, Float32Array] = [new Float32Array(len), new Float32Array(len)]
  let seed = 0x2f6e2b1
  const rand = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) / 4294967296) * 2 - 1
  }
  const decay = Math.log(1000) / len // -60 dB at the tail
  for (let ch = 0; ch < 2; ch++) {
    let energy = 0
    for (let i = 0; i < len; i++) {
      const v = rand() * Math.exp(-decay * i)
      out[ch][i] = v
      energy += v * v
    }
    const g = wet / Math.sqrt(energy)
    for (let i = 0; i < len; i++) out[ch][i] *= g
    out[ch][0] += 1 - wet
  }
  return out
}

/** Encodes float channels as a 32-bit float WAV. */
export function encodeWav(channels: Float32Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const frames = channels[0].length
  const nch = channels.length
  const dataLen = frames * nch * 4
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nch, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 4, true)
  v.setUint16(32, nch * 4, true); v.setUint16(34, 32, true); str(36, 'data'); v.setUint32(40, dataLen, true)
  let o = 44
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) { v.setFloat32(o, channels[c][i], true); o += 4 }
  return new Uint8Array(buf)
}

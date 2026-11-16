// Easing curves, defined once as both a JS function (preview) and an ffmpeg expression (export).
import type { EaseName, TransformAnim, TransformState, ZoomAnim } from './model'

interface EaseDef {
  label: string
  fn: (p: number) => number
  /** Builds an ffmpeg expression from an expression `P` that evaluates to progress 0..1. */
  expr: (P: string) => string
}

export const EASES: Record<EaseName, EaseDef> = {
  linear: { label: 'Linear', fn: (p) => p, expr: (P) => P },
  easeIn: { label: 'Ease in', fn: (p) => p * p, expr: (P) => `pow(${P},2)` },
  easeOut: { label: 'Ease out', fn: (p) => 1 - (1 - p) ** 2, expr: (P) => `(1-pow(1-${P},2))` },
  easeInOut: {
    label: 'Ease in-out',
    fn: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
    expr: (P) => `if(lt(${P},0.5),2*pow(${P},2),1-pow(2-2*${P},2)/2)`
  },
  easeInCubic: { label: 'Ease in (strong)', fn: (p) => p ** 3, expr: (P) => `pow(${P},3)` },
  easeOutCubic: { label: 'Ease out (strong)', fn: (p) => 1 - (1 - p) ** 3, expr: (P) => `(1-pow(1-${P},3))` },
  easeInOutCubic: {
    label: 'Ease in-out (strong)',
    fn: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
    expr: (P) => `if(lt(${P},0.5),4*pow(${P},3),1-pow(2-2*${P},3)/2)`
  }
}

export const EASE_NAMES = Object.keys(EASES) as EaseName[]

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p

/** Formats a number for an ffmpeg expression/option: plain decimal, no exponent. */
export function num(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return '0'
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** Eased progress for local clip time. */
export function progress(ease: EaseName, local: number, duration: number): number {
  const p = duration > 0 ? clamp(local / duration, 0, 1) : 1
  return EASES[ease].fn(p)
}

export function transformAt(t: TransformAnim, local: number, duration: number): TransformState {
  if (!t.animate) return t.start
  const p = progress(t.ease, local, duration)
  return {
    x: lerp(t.start.x, t.end.x, p),
    y: lerp(t.start.y, t.end.y, p),
    scale: lerp(t.start.scale, t.end.scale, p),
    rotation: lerp(t.start.rotation, t.end.rotation, p),
    opacity: lerp(t.start.opacity, t.end.opacity, p)
  }
}

export function zoomAt(z: ZoomAnim, local: number, duration: number): number {
  if (!z.enabled) return 1
  return lerp(z.start, z.end, progress(z.ease, local, duration))
}

/**
 * ffmpeg expression for a value animated from `a` to `b`.
 * `timeVar` is the filter's time variable, `t0` the animation start in that timebase, `d` its length.
 */
export function animExpr(a: number, b: number, ease: EaseName, timeVar: string, t0: number, d: number): string {
  if (a === b || d <= 0) return num(a)
  const P = `clip((${timeVar}-${num(t0)})/${num(d)},0,1)`
  return `(${num(a)}+(${num(b - a)})*${EASES[ease].expr(P)})`
}

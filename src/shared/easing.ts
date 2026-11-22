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

// Easing curves. A clip's ease is either a built-in (Linear and every curve from easings.net, defined
// once as a JS function for the preview and an ffmpeg expression for the export) or a custom curve the
// user drew in the easing graph: points joined by cubic Bézier segments.
import type { Ease, EaseCurve, EaseName, CurvePoint, TransformAnim, TransformState, ZoomAnim } from './model'

interface EaseDef {
  fn: (p: number) => number
  /** Builds an ffmpeg expression from an expression `P` that evaluates to progress 0..1. */
  expr: (P: string) => string
  /** The CSS cubic-bezier(x1, y1, x2, y2) easings.net gives for it, if any: the starting point for editing. */
  bezier?: [number, number, number, number]
}

const PI = Math.PI
const c1 = 1.70158
const c2 = c1 * 1.525
const c3 = c1 + 1
const c4 = (2 * PI) / 3
const c5 = (2 * PI) / 4.5
const n1 = 7.5625
const d1 = 2.75

function outBounce(x: number): number {
  if (x < 1 / d1) return n1 * x * x
  if (x < 2 / d1) return n1 * (x - 1.5 / d1) ** 2 + 0.75
  if (x < 2.5 / d1) return n1 * (x - 2.25 / d1) ** 2 + 0.9375
  return n1 * (x - 2.625 / d1) ** 2 + 0.984375
}
const outBounceExpr = (X: string) =>
  `if(lt(${X},${1 / d1}),${n1}*pow(${X},2),if(lt(${X},${2 / d1}),${n1}*pow(${X}-${1.5 / d1},2)+0.75,` +
  `if(lt(${X},${2.5 / d1}),${n1}*pow(${X}-${2.25 / d1},2)+0.9375,${n1}*pow(${X}-${2.625 / d1},2)+0.984375)))`

/** Every built-in easing, in the order easings.net shows them (formulas from its source). */
export const EASES: Record<string, EaseDef> = {
  linear: { fn: (x) => x, expr: (P) => P, bezier: [0, 0, 1, 1] },

  easeInSine: { fn: (x) => 1 - Math.cos((x * PI) / 2), expr: (P) => `(1-cos(${P}*PI/2))`, bezier: [0.12, 0, 0.39, 0] },
  easeOutSine: { fn: (x) => Math.sin((x * PI) / 2), expr: (P) => `sin(${P}*PI/2)`, bezier: [0.61, 1, 0.88, 1] },
  easeInOutSine: { fn: (x) => -(Math.cos(PI * x) - 1) / 2, expr: (P) => `(-(cos(PI*${P})-1)/2)`, bezier: [0.37, 0, 0.63, 1] },

  easeInQuad: { fn: (x) => x * x, expr: (P) => `pow(${P},2)`, bezier: [0.11, 0, 0.5, 0] },
  easeOutQuad: { fn: (x) => 1 - (1 - x) * (1 - x), expr: (P) => `(1-pow(1-${P},2))`, bezier: [0.5, 1, 0.89, 1] },
  easeInOutQuad: {
    fn: (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
    expr: (P) => `if(lt(${P},0.5),2*pow(${P},2),1-pow(2-2*${P},2)/2)`,
    bezier: [0.45, 0, 0.55, 1]
  },

  easeInCubic: { fn: (x) => x ** 3, expr: (P) => `pow(${P},3)`, bezier: [0.32, 0, 0.67, 0] },
  easeOutCubic: { fn: (x) => 1 - (1 - x) ** 3, expr: (P) => `(1-pow(1-${P},3))`, bezier: [0.33, 1, 0.68, 1] },
  easeInOutCubic: {
    fn: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
    expr: (P) => `if(lt(${P},0.5),4*pow(${P},3),1-pow(2-2*${P},3)/2)`,
    bezier: [0.65, 0, 0.35, 1]
  },

  easeInQuart: { fn: (x) => x ** 4, expr: (P) => `pow(${P},4)`, bezier: [0.5, 0, 0.75, 0] },
  easeOutQuart: { fn: (x) => 1 - (1 - x) ** 4, expr: (P) => `(1-pow(1-${P},4))`, bezier: [0.25, 1, 0.5, 1] },
  easeInOutQuart: {
    fn: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
    expr: (P) => `if(lt(${P},0.5),8*pow(${P},4),1-pow(2-2*${P},4)/2)`,
    bezier: [0.76, 0, 0.24, 1]
  },

  easeInQuint: { fn: (x) => x ** 5, expr: (P) => `pow(${P},5)`, bezier: [0.64, 0, 0.78, 0] },
  easeOutQuint: { fn: (x) => 1 - (1 - x) ** 5, expr: (P) => `(1-pow(1-${P},5))`, bezier: [0.22, 1, 0.36, 1] },
  easeInOutQuint: {
    fn: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
    expr: (P) => `if(lt(${P},0.5),16*pow(${P},5),1-pow(2-2*${P},5)/2)`,
    bezier: [0.83, 0, 0.17, 1]
  },

  easeInExpo: {
    fn: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
    expr: (P) => `if(eq(${P},0),0,pow(2,10*${P}-10))`,
    bezier: [0.7, 0, 0.84, 0]
  },
  easeOutExpo: {
    fn: (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
    expr: (P) => `if(eq(${P},1),1,1-pow(2,-10*${P}))`,
    bezier: [0.16, 1, 0.3, 1]
  },
  easeInOutExpo: {
    fn: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
    expr: (P) => `if(eq(${P},0),0,if(eq(${P},1),1,if(lt(${P},0.5),pow(2,20*${P}-10)/2,(2-pow(2,10-20*${P}))/2)))`,
    bezier: [0.87, 0, 0.13, 1]
  },

  easeInCirc: { fn: (x) => 1 - Math.sqrt(1 - x ** 2), expr: (P) => `(1-sqrt(1-pow(${P},2)))`, bezier: [0.55, 0, 1, 0.45] },
  easeOutCirc: { fn: (x) => Math.sqrt(1 - (x - 1) ** 2), expr: (P) => `sqrt(1-pow(${P}-1,2))`, bezier: [0, 0.55, 0.45, 1] },
  easeInOutCirc: {
    fn: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
    expr: (P) => `if(lt(${P},0.5),(1-sqrt(1-pow(2*${P},2)))/2,(sqrt(1-pow(2-2*${P},2))+1)/2)`,
    bezier: [0.85, 0, 0.15, 1]
  },

  easeInBack: { fn: (x) => c3 * x ** 3 - c1 * x * x, expr: (P) => `(${c3}*pow(${P},3)-${c1}*pow(${P},2))`, bezier: [0.36, 0, 0.66, -0.56] },
  easeOutBack: {
    fn: (x) => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
    expr: (P) => `(1+${c3}*pow(${P}-1,3)+${c1}*pow(${P}-1,2))`,
    bezier: [0.34, 1.56, 0.64, 1]
  },
  easeInOutBack: {
    fn: (x) => (x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
    expr: (P) =>
      `if(lt(${P},0.5),pow(2*${P},2)*(${c2 + 1}*2*${P}-${c2})/2,(pow(2*${P}-2,2)*(${c2 + 1}*(2*${P}-2)+${c2})+2)/2)`,
    bezier: [0.68, -0.6, 0.32, 1.6]
  },

  easeInElastic: {
    fn: (x) => (x === 0 ? 0 : x === 1 ? 1 : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * c4)),
    expr: (P) => `if(eq(${P},0),0,if(eq(${P},1),1,-pow(2,10*${P}-10)*sin((${P}*10-10.75)*${c4})))`
  },
  easeOutElastic: {
    fn: (x) => (x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
    expr: (P) => `if(eq(${P},0),0,if(eq(${P},1),1,pow(2,-10*${P})*sin((${P}*10-0.75)*${c4})+1))`
  },
  easeInOutElastic: {
    fn: (x) =>
      x === 0 ? 0 : x === 1 ? 1 : x < 0.5
        ? -(2 ** (20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
        : (2 ** (-20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
    expr: (P) =>
      `if(eq(${P},0),0,if(eq(${P},1),1,if(lt(${P},0.5),-(pow(2,20*${P}-10)*sin((20*${P}-11.125)*${c5}))/2,` +
      `pow(2,10-20*${P})*sin((20*${P}-11.125)*${c5})/2+1)))`
  },

  easeInBounce: { fn: (x) => 1 - outBounce(1 - x), expr: (P) => `(1-${outBounceExpr(`(1-${P})`)})` },
  easeOutBounce: { fn: outBounce, expr: (P) => outBounceExpr(P) },
  easeInOutBounce: {
    fn: (x) => (x < 0.5 ? (1 - outBounce(1 - 2 * x)) / 2 : (1 + outBounce(2 * x - 1)) / 2),
    expr: (P) => `if(lt(${P},0.5),(1-${outBounceExpr(`(1-2*${P})`)})/2,(1+${outBounceExpr(`(2*${P}-1)`)})/2)`
  }
}

export const EASE_NAMES = Object.keys(EASES)

/** The families easings.net groups them in (each has In, Out and In-out). */
export const EASE_FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'] as const

/** Names used by projects saved before the easings.net set. */
const LEGACY: Record<string, string> = { easeIn: 'easeInQuad', easeOut: 'easeOutQuad', easeInOut: 'easeInOutQuad' }

/** A valid ease from whatever a file holds (old names, unknown names, malformed curves). */
export function normalizeEase(e: unknown): Ease {
  if (typeof e === 'string') return EASES[e] ? e : (LEGACY[e] ?? 'easeInOutQuad')
  const c = e as EaseCurve | null
  if (c && Array.isArray(c.points) && c.points.length >= 2) return { points: fixCurve(c.points) }
  return 'easeInOutQuad'
}

export const isCurve = (e: Ease): e is EaseCurve => typeof e === 'object'

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p

/** Formats a number for an ffmpeg expression/option: plain decimal, no exponent. */
export function num(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return '0'
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

// ---------------------------------------------------------------- custom curves

/**
 * Keeps a curve valid: starts at (0,0), ends at (1,1), points in order, and every handle within its own
 * segment's width (so the curve never runs backwards in time and has one value at each moment).
 */
export function fixCurve(points: CurvePoint[]): CurvePoint[] {
  const pts = points
    .map((p) => ({ x: clamp(Number(p.x) || 0, 0, 1), y: Number.isFinite(p.y) ? clamp(p.y, -2, 3) : 0, in: [...(p.in ?? [0, 0])] as [number, number], out: [...(p.out ?? [0, 0])] as [number, number] }))
    .sort((a, b) => a.x - b.x)
  pts[0].x = 0
  pts[0].y = 0
  pts[pts.length - 1].x = 1
  pts[pts.length - 1].y = 1
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const left = i > 0 ? p.x - pts[i - 1].x : 0
    const right = i < pts.length - 1 ? pts[i + 1].x - p.x : 0
    p.in = [clamp(p.in[0], -left, 0), clamp(p.in[1], -3, 3)]
    p.out = [clamp(p.out[0], 0, right), clamp(p.out[1], -3, 3)]
    if (i === 0) p.in = [0, 0]
    if (i === pts.length - 1) p.out = [0, 0]
  }
  return pts
}

const bez = (a: number, b: number, c: number, d: number, s: number) => {
  const m = 1 - s
  return m * m * m * a + 3 * m * m * s * b + 3 * m * s * s * c + s * s * s * d
}

/** Value of a custom curve at x (0..1). */
export function evalCurve(curve: EaseCurve, x: number): number {
  const pts = curve.points
  if (x <= 0) return pts[0].y
  if (x >= 1) return pts[pts.length - 1].y
  let i = 0
  while (i < pts.length - 2 && x > pts[i + 1].x) i++
  const a = pts[i]
  const b = pts[i + 1]
  const x0 = a.x, x1 = a.x + a.out[0], x2 = b.x + b.in[0], x3 = b.x
  // x(s) only increases (handles stay inside the segment), so bisection always finds it.
  let lo = 0
  let hi = 1
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2
    if (bez(x0, x1, x2, x3, mid) < x) lo = mid
    else hi = mid
  }
  const s = (lo + hi) / 2
  return bez(a.y, a.y + a.out[1], b.y + b.in[1], b.y, s)
}

/** Points of a curve's segments at Bézier parameter steps, for drawing it. */
export function curvePath(curve: EaseCurve, steps = 24): [number, number][] {
  const out: [number, number][] = []
  const pts = curve.points
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const s = k / steps
      out.push([bez(a.x, a.x + a.out[0], b.x + b.in[0], b.x, s), bez(a.y, a.y + a.out[1], b.y + b.in[1], b.y, s)])
    }
  }
  return out
}

/** Pieces in the export's table for a custom curve (the preview uses the exact curve; they differ by well under 1%). */
const TABLE = 128

/**
 * ffmpeg expression for a custom curve: a lookup of TABLE straight pieces, arranged as a balanced tree of
 * if()s so each frame needs only about seven comparisons.
 */
function curveExpr(curve: EaseCurve, P: string): string {
  const ys = Array.from({ length: TABLE + 1 }, (_, i) => evalCurve(curve, i / TABLE))
  const piece = (i: number) => `(${num(ys[i])}+(${num(ys[i + 1] - ys[i])})*(${P}*${TABLE}-${i}))`
  const tree = (lo: number, hi: number): string => {
    if (hi - lo === 1) return piece(lo)
    const mid = (lo + hi) >> 1
    return `if(lt(${P},${num(mid / TABLE)}),${tree(lo, mid)},${tree(mid, hi)})`
  }
  return tree(0, TABLE)
}

/** The ease as a function of progress 0..1. */
export function easeFn(e: Ease): (p: number) => number {
  if (isCurve(e)) return (p) => evalCurve(e, p)
  return (EASES[e] ?? EASES.easeInOutQuad).fn
}

export function easeExpr(e: Ease, P: string): string {
  return isCurve(e) ? curveExpr(e, P) : (EASES[e] ?? EASES.easeInOutQuad).expr(P)
}

// ---------------------------------------------------------------- built-in → editable

/**
 * An editable curve that looks like a built-in easing: its CSS cubic-bezier when easings.net gives one,
 * otherwise (Elastic, Bounce) a point at every peak and dip, with handles along the curve's slope on each side.
 */
export function curveFromEase(name: EaseName): EaseCurve {
  const def = EASES[name] ?? EASES.linear
  if (def.bezier) {
    const [x1, y1, x2, y2] = def.bezier
    return { points: fixCurve([{ x: 0, y: 0, in: [0, 0], out: [x1, y1] }, { x: 1, y: 1, in: [x2 - 1, y2 - 1], out: [0, 0] }]) }
  }
  const N = 2000
  const f = def.fn
  const ys = Array.from({ length: N + 1 }, (_, i) => f(i / N))
  const keys = [0]
  for (let i = 1; i < N; i++) {
    const d0 = ys[i] - ys[i - 1]
    const d1 = ys[i + 1] - ys[i]
    if (d0 * d1 < 0 || (d0 !== 0 && d1 === 0)) keys.push(i)
  }
  keys.push(N)
  const h = 1 / N
  // Slopes either side of a point, measured a sample away from it: a corner (where Bounce hits the ground)
  // usually falls between two samples, and the nearest pair would straddle it and mix both sides.
  const slopeLeft = (i: number) => (i >= 2 ? (ys[i - 1] - ys[i - 2]) / h : (ys[1] - ys[0]) / h)
  const slopeRight = (i: number) => (i <= N - 2 ? (ys[i + 2] - ys[i + 1]) / h : slopeLeft(i))
  const build = (ks: number[]): EaseCurve => ({
    points: fixCurve(ks.map((k, j) => {
      const x = k / N
      const left = j > 0 ? x - ks[j - 1] / N : 0
      const right = j < ks.length - 1 ? ks[j + 1] / N - x : 0
      return { x, y: ys[k], in: [-left / 3, (-left / 3) * slopeLeft(k)], out: [right / 3, (right / 3) * slopeRight(k)] }
    }))
  })
  // Add a point half way along any stretch that strays more than 1% from the real curve (steep swings).
  for (let pass = 0; pass < 4; pass++) {
    const curve = build(keys)
    const extra: number[] = []
    for (let j = 0; j < keys.length - 1; j++) {
      let worst = 0
      for (let i = keys[j]; i <= keys[j + 1]; i += 5) worst = Math.max(worst, Math.abs(evalCurve(curve, i / N) - ys[i]))
      if (worst > 0.01 && keys[j + 1] - keys[j] > 4) extra.push((keys[j] + keys[j + 1]) >> 1)
    }
    if (!extra.length) break
    keys.push(...extra)
    keys.sort((a, b) => a - b)
  }
  return build(keys)
}

// ---------------------------------------------------------------- animation

/** Eased progress for local clip time. */
export function progress(ease: Ease, local: number, duration: number): number {
  const p = duration > 0 ? clamp(local / duration, 0, 1) : 1
  return easeFn(ease)(p)
}

export function transformAt(t: TransformAnim, local: number, duration: number): TransformState {
  if (!t.animate) return t.start
  const p = progress(t.ease, local, duration)
  const out = {} as TransformState
  for (const k of Object.keys(t.start) as (keyof TransformState)[]) out[k] = lerp(t.start[k], t.end[k], p)
  return out
}

export const CROP_SIDES = ['cropLeft', 'cropRight', 'cropTop', 'cropBottom'] as const

/** Whether a clip is cropped at any point of its transform. */
export function hasCrop(t: TransformAnim): boolean {
  return CROP_SIDES.some((k) => t.start[k] > 0 || (t.animate && t.end[k] > 0))
}

/**
 * The rectangle a crop hides on one side of a w x h layer, in whole pixels (both renderers round the same
 * way). Null when nothing is hidden on that side.
 */
export function cropBox(side: (typeof CROP_SIDES)[number], amount: number, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const px = Math.round(clamp(amount, 0, 1) * (side === 'cropLeft' || side === 'cropRight' ? w : h))
  if (px <= 0) return null
  switch (side) {
    case 'cropLeft': return { x: 0, y: 0, w: px, h }
    case 'cropRight': return { x: w - px, y: 0, w: px, h }
    case 'cropTop': return { x: 0, y: 0, w, h: px }
    default: return { x: 0, y: h - px, w, h: px }
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
export function animExpr(a: number, b: number, ease: Ease, timeVar: string, t0: number, d: number): string {
  if (a === b || d <= 0) return num(a)
  const P = `clip((${timeVar}-${num(t0)})/${num(d)},0,1)`
  return `(${num(a)}+(${num(b - a)})*${easeExpr(ease, P)})`
}

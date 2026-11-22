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

// Easing: the easings.net set, custom curves from the easing graph, and that the export's ffmpeg
// expressions give the same values as the preview's functions.
import { describe, expect, it } from 'vitest'
import {
  EASES, EASE_NAMES, animExpr, cropBox, curveFromEase, easeFn, evalCurve, fixCurve, normalizeEase, transformAt
} from '../src/shared/easing'
import { type EaseCurve, defaultTransform, normalizeAnimation } from '../src/shared/model'

/** Evaluates an ffmpeg expression in JS (the functions ClipWorld's expressions use). */
function evalExpr(expr: string, t: number): number {
  const fn = new Function(
    't', 'pow', 'clip', 'lt', 'eq', 'if_', 'sin', 'cos', 'sqrt', 'PI',
    `return ${expr.replace(/\bif\(/g, 'if_(')}`
  )
  return fn(
    t, Math.pow, (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)), (a: number, b: number) => (a < b ? 1 : 0),
    (a: number, b: number) => (a === b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b), Math.sin, Math.cos, Math.sqrt, Math.PI
  )
}

const samples = Array.from({ length: 201 }, (_, i) => i / 200)

describe('built-in easings', () => {
  it('has Linear and all 30 easings from easings.net', () => {
    expect(EASE_NAMES.length).toBe(31)
    for (const f of ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce']) {
      for (const k of ['In', 'Out', 'InOut']) expect(EASES[`ease${k}${f}`], `ease${k}${f}`).toBeDefined()
    }
  })

  it('start at 0 and end at 1', () => {
    for (const name of EASE_NAMES) {
      expect(EASES[name].fn(0), name).toBeCloseTo(0, 6)
      expect(EASES[name].fn(1), name).toBeCloseTo(1, 6)
    }
  })

  it('match known values from easings.net', () => {
    expect(EASES.easeOutBounce.fn(0.5)).toBeCloseTo(0.765625, 6)
    expect(EASES.easeInOutBack.fn(0.25)).toBeCloseTo(-0.0996818, 5)
    expect(EASES.easeOutElastic.fn(0.1)).toBeCloseTo(1.25, 2)
    expect(EASES.easeInOutSine.fn(0.5)).toBeCloseTo(0.5, 6)
    expect(EASES.easeInExpo.fn(0.5)).toBeCloseTo(0.03125, 6)
  })

  it("the export's ffmpeg expressions agree with the preview's functions", () => {
    for (const name of EASE_NAMES) {
      const expr = animExpr(2, 10, name, 't', 1, 4)
      for (const t of [0, 1, ...samples.map((s) => 1 + s * 4), 9]) {
        const p = Math.min(1, Math.max(0, (t - 1) / 4))
        expect(evalExpr(expr, t), `${name} at ${t}`).toBeCloseTo(2 + 8 * EASES[name].fn(p), 5)
      }
    }
  })
})

describe('custom curves', () => {
  const s: EaseCurve = {
    points: fixCurve([
      { x: 0, y: 0, in: [0, 0], out: [0.2, 0.6] },
      { x: 0.5, y: 1.2, in: [-0.1, 0], out: [0.1, 0] },
      { x: 1, y: 1, in: [-0.2, 0], out: [0, 0] }
    ])
  }

  it('go through their points', () => {
    expect(evalCurve(s, 0)).toBe(0)
    expect(evalCurve(s, 0.5)).toBeCloseTo(1.2, 3)
    expect(evalCurve(s, 1)).toBe(1)
  })

  it('stay valid however they are edited', () => {
    const c = fixCurve([
      { x: 0.7, y: 0.4, in: [-2, 9], out: [3, 0] },
      { x: 0.2, y: 5, in: [0, 0], out: [0, 0] },
      { x: 0.9, y: 0.3, in: [0, 0], out: [0, 0] }
    ])
    expect(c.map((p) => p.x)).toEqual([0, 0.7, 1])
    expect([c[0].y, c[2].y]).toEqual([0, 1])
    // Handles never reach past the neighbouring points, so the curve can't go back in time.
    expect(c[1].in[0]).toBeGreaterThanOrEqual(-0.7)
    expect(c[1].out[0]).toBeLessThanOrEqual(0.3 + 1e-12)
  })

  it('export within half a percent of the preview', () => {
    const expr = animExpr(0, 1, s, 't', 0, 1)
    for (const x of samples) expect(Math.abs(evalExpr(expr, x) - evalCurve(s, x))).toBeLessThan(0.005)
  })

  it('every built-in turns into an editable curve that looks like it', () => {
    for (const name of EASE_NAMES) {
      const curve = curveFromEase(name)
      let worst = 0
      for (const x of samples) worst = Math.max(worst, Math.abs(evalCurve(curve, x) - EASES[name].fn(x)))
      // The cubic-bezier versions are easings.net's own approximations; the rest put a point on every peak.
      expect(worst, `${name}: ${curve.points.length} points`).toBeLessThan(0.05)
      expect(curve.points.length, name).toBeLessThanOrEqual(name.includes('Elastic') || name.includes('Bounce') ? 24 : 2)
    }
  })

  it('a converted curve exports within half a percent too (Elastic, the hardest)', () => {
    const c = curveFromEase('easeOutElastic')
    const expr = animExpr(0, 1, c, 't', 0, 1)
    for (const x of samples) expect(Math.abs(evalExpr(expr, x) - evalCurve(c, x))).toBeLessThan(0.005)
    expect(easeFn(c)(0.5)).toBeCloseTo(evalCurve(c, 0.5), 9)
  })
})

describe('older files', () => {
  it('map the old easing names and fill in crop', () => {
    expect(normalizeEase('easeInOut')).toBe('easeInOutQuad')
    expect(normalizeEase('easeIn')).toBe('easeInQuad')
    expect(normalizeEase('easeOutCubic')).toBe('easeOutCubic')
    expect(normalizeEase('nonsense')).toBe('easeInOutQuad')
    const old = { transform: { animate: true, start: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, end: { x: 1, y: 0, scale: 1, rotation: 0, opacity: 1 }, ease: 'easeOut' } }
    const a = normalizeAnimation(old as never)
    expect(a.transform.ease).toBe('easeOutQuad')
    expect(a.transform.start.cropLeft).toBe(0)
    expect(a.transform.end.cropBottom).toBe(0)
  })
})

describe('crop', () => {
  it('animates with the transform and rounds to whole pixels', () => {
    const t = defaultTransform()
    t.animate = true
    t.ease = 'linear'
    t.end.cropLeft = 0.5
    expect(transformAt(t, 1, 2).cropLeft).toBeCloseTo(0.25)
    expect(cropBox('cropLeft', 0.25, 101, 50)).toEqual({ x: 0, y: 0, w: 25, h: 50 })
    expect(cropBox('cropBottom', 0.1, 100, 50)).toEqual({ x: 0, y: 45, w: 100, h: 5 })
    expect(cropBox('cropRight', 0, 100, 50)).toBeNull()
  })
})

describe('typed values', () => {
  it('can go past the slider, except where something real stops them', async () => {
    const { EFFECT_MAP, fieldLimits } = await import('../src/shared/effects')
    const param = (type: string, key: string) => EFFECT_MAP[type].params.find((p) => p.key === key)!
    // Past the slider's end, never below zero.
    expect(fieldLimits(param('blur', 'radius'))).toEqual({ min: 0 })
    expect(fieldLimits(param('brightness', 'amount'))).toEqual({ min: 0 })
    expect(fieldLimits(param('pixelate', 'size'))).toEqual({ min: 2 })
    // Angles and gains go both ways without limit.
    expect(fieldLimits(param('hue', 'degrees'))).toEqual({ min: undefined })
    // Proportions stay within 0–100%.
    expect(fieldLimits(param('grayscale', 'amount'))).toEqual({ min: 0, max: 1 })
    expect(fieldLimits(param('chromaKey', 'similarity'))).toEqual({ min: 0.01, max: 1 })
    // Real limits: the export's sharpen, the preview's pitch shifter and echo.
    expect(fieldLimits(param('sharpen', 'amount'))).toEqual({ min: 0, max: 2 })
    expect(fieldLimits(param('pitch', 'semitones'))).toEqual({ min: -24, max: 24 })
    expect(fieldLimits(param('echo', 'feedback'))).toEqual({ min: 0, max: 0.95 })
  })
})

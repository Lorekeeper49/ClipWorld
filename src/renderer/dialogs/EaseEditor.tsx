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

// The easing graph: pick a built-in curve (Linear and everything from easings.net) or one of your own
// presets, and reshape it freely. Changes apply to the clip straight away.
import { useEffect, useMemo, useRef, useState } from 'react'
import { EASES, EASE_FAMILIES, clamp, curveFromEase, curvePath, easeFn, fixCurve, isCurve } from '@shared/easing'
import { easeName } from '@shared/labels'
import { type CurvePoint, type Ease, type EaseCurve, clone, uid } from '@shared/model'
import { Btn, Modal } from '../components/ui'
import { t, useT } from '../i18n'
import { edit, get, patchSettings, set, toast, useStore } from '../state/store'

const NO_PRESETS: { id: string; name: string; curve: EaseCurve }[] = []

const W = 520
const H = 360
const PAD = 36

type Target = { clipId: string; field: 'transform' | 'zoom' }

/** The clip's current ease for the edited field. */
const easeOf = (target: Target | null): Ease | null => {
  if (!target) return null
  const c = get().project.clips.find((x) => x.id === target.clipId)
  return c ? c[target.field].ease : null
}

function setEase(target: Target, ease: Ease, key = 'set'): void {
  edit((p) => {
    const c = p.clips.find((x) => x.id === target.clipId)
    if (c) c[target.field].ease = clone(ease)
  }, { key: `${target.clipId}:${target.field}.ease.${key}` })
}

const sameCurve = (a: Ease, b: Ease) => isCurve(a) && isCurve(b) && JSON.stringify(a.points) === JSON.stringify(b.points)

/** A small picture of an easing, for the preset list and the Tools window. */
export function EaseIcon({ ease, width = 34, height = 24 }: { ease: Ease; width?: number; height?: number }) {
  const d = useMemo(() => {
    const f = easeFn(ease)
    const ys = Array.from({ length: 41 }, (_, i) => f(i / 40))
    const lo = Math.min(0, ...ys)
    const hi = Math.max(1, ...ys)
    const sy = (v: number) => 2 + (height - 4) * (1 - (v - lo) / (hi - lo))
    return ys.map((v, i) => `${i ? 'L' : 'M'}${(2 + ((width - 4) * i) / 40).toFixed(1)},${sy(v).toFixed(1)}`).join('')
  }, [ease, width, height])
  return (
    <svg className="ease-icon" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

/** What to call an ease: its built-in name, the name of a matching preset of yours, or "Custom curve". */
export function easeLabel(ease: Ease): string {
  if (!isCurve(ease)) return easeName(ease)
  const mine = (get().settings.easePresets ?? []).find((p) => sameCurve(p.curve, ease))
  return mine ? mine.name : t('easeEditor.custom')
}

/** The Ease field in the Tools window: shows the curve and opens the graph. */
export function EaseField({ clipId, field, ease }: Target & { ease: Ease }) {
  useT()
  useStore((s) => s.settings.easePresets)
  return (
    <button type="button" className="select ease-field" data-testid={`ease-${field}`} onClick={() => set({ modal: 'ease', easeTarget: { clipId, field } })}
      title={t('easeEditor.open')}>
      <EaseIcon ease={ease} />
      <span>{easeLabel(ease)}</span>
    </button>
  )
}

function Graph({ target, ease }: { target: Target; ease: Ease }) {
  // A built-in shows its exact curve; its editable points appear on top and editing any turns it into a curve.
  const curve: EaseCurve = useMemo(() => (isCurve(ease) ? ease : curveFromEase(ease)), [ease])
  const [selected, setSelected] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const range = useRef<[number, number]>([-0.1, 1.1])
  // The value range only changes between drags, so the graph doesn't slide under the pointer.
  if (!dragging.current) {
    const f = easeFn(ease)
    let lo = 0
    let hi = 1
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100)
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    for (const p of curve.points) for (const v of [p.y, p.y + p.in[1], p.y + p.out[1]]) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    const m = (hi - lo) * 0.12
    range.current = [lo - m, hi + m]
  }
  const [lo, hi] = range.current
  const sx = (x: number) => PAD + x * (W - 2 * PAD)
  const sy = (y: number) => PAD + (1 - (y - lo) / (hi - lo)) * (H - 2 * PAD)
  const toGraph = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const py = ((e.clientY - r.top) / r.height) * H
    return [(px - PAD) / (W - 2 * PAD), lo + (1 - (py - PAD) / (H - 2 * PAD)) * (hi - lo)]
  }
  const commit = (points: CurvePoint[], key: string) => setEase(target, { points: fixCurve(points) }, key)

  const path = isCurve(ease)
    ? curvePath(ease).map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join('')
    : Array.from({ length: 241 }, (_, i) => i / 240).map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(EASES[ease].fn(x)).toFixed(1)}`).join('')

  /** Drags a point (what = 'p') or one of its handles, Alt to move a handle on its own. */
  const startDrag = (e: React.PointerEvent, index: number, what: 'p' | 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    setSelected(index)
    const base = clone(curve.points)
    const last = base.length - 1
    if (what === 'p' && (index === 0 || index === last)) return
    dragging.current = true
    const move = (ev: PointerEvent) => {
      const [x, y] = toGraph(ev)
      const pts = clone(base)
      const p = pts[index]
      if (what === 'p') {
        p.x = Math.min(pts[index + 1].x - 0.005, Math.max(pts[index - 1].x + 0.005, x))
        p.y = y
      } else {
        const v: [number, number] = [x - p.x, y - p.y]
        p[what] = v
        // Handles stay in line (a smooth point) unless Alt is held or it's an end point.
        const other = what === 'in' ? 'out' : 'in'
        if (!ev.altKey && index > 0 && index < last) {
          const len = Math.hypot(...base[index][other])
          const l = Math.hypot(...v) || 1
          p[other] = [(-v[0] / l) * len, (-v[1] / l) * len]
        }
      }
      commit(pts, `drag${index}${what}`)
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const remove = (index: number) => {
    if (index <= 0 || index >= curve.points.length - 1) return
    commit(curve.points.filter((_, i) => i !== index), `remove${index}`)
    setSelected(null)
  }

  const add = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('.ease-point')) return
    const [x] = toGraph(e)
    if (x <= 0.01 || x >= 0.99) return
    const f = easeFn(ease)
    const y = f(x)
    const slope = (f(Math.min(1, x + 0.005)) - f(Math.max(0, x - 0.005))) / 0.01
    const pts = clone(curve.points)
    const i = pts.findIndex((p) => p.x > x)
    const reach = Math.min(x - pts[i - 1].x, pts[i].x - x) / 3
    pts.splice(i, 0, { x, y, in: [-reach, -reach * slope], out: [reach, reach * slope] })
    commit(pts, `add${i}`)
    setSelected(i)
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null && !(e.target as HTMLElement).closest('input')) {
        e.preventDefault()
        remove(selected)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const last = curve.points.length - 1
  return (
    <div className="ease-graph">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} data-testid="ease-graph"
        onDoubleClick={add} onPointerDown={() => setSelected(null)}>
        <rect x={sx(0)} y={sy(1)} width={sx(1) - sx(0)} height={sy(0) - sy(1)} className="ease-box" />
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={sx(g)} x2={sx(g)} y1={sy(hi)} y2={sy(lo)} className="ease-grid" />)}
        <line x1={sx(0)} x2={sx(1)} y1={sy(0)} y2={sy(0)} className="ease-axis" />
        <line x1={sx(0)} x2={sx(1)} y1={sy(1)} y2={sy(1)} className="ease-axis" />
        <text x={sx(0) - 6} y={sy(0) + 4} className="ease-label" textAnchor="end">0</text>
        <text x={sx(0) - 6} y={sy(1) + 4} className="ease-label" textAnchor="end">1</text>
        <text x={sx(1)} y={H - 10} className="ease-label" textAnchor="end">{t('easeEditor.time')} →</text>
        <text x={12} y={sy(0.5)} className="ease-label" transform={`rotate(-90 12 ${sy(0.5)})`} textAnchor="middle">{t('easeEditor.value')} →</text>
        <path d={path} className="ease-curve" data-testid="ease-curve" />
        {curve.points.map((p, i) => (
          <g key={i} className={`ease-point${selected === i ? ' selected' : ''}${isCurve(ease) ? '' : ' suggested'}`}>
            {i > 0 && (
              <>
                <line x1={sx(p.x)} y1={sy(p.y)} x2={sx(p.x + p.in[0])} y2={sy(p.y + p.in[1])} className="ease-handle-line" />
                <circle cx={sx(p.x + p.in[0])} cy={sy(p.y + p.in[1])} r={5} className="ease-handle" data-testid="ease-handle-in"
                  onPointerDown={(e) => startDrag(e, i, 'in')} />
              </>
            )}
            {i < last && (
              <>
                <line x1={sx(p.x)} y1={sy(p.y)} x2={sx(p.x + p.out[0])} y2={sy(p.y + p.out[1])} className="ease-handle-line" />
                <circle cx={sx(p.x + p.out[0])} cy={sy(p.y + p.out[1])} r={5} className="ease-handle" data-testid="ease-handle-out"
                  onPointerDown={(e) => startDrag(e, i, 'out')} />
              </>
            )}
            <rect x={sx(p.x) - 6} y={sy(p.y) - 6} width={12} height={12} rx={2} className={`ease-node${i === 0 || i === last ? ' fixed' : ''}`}
              data-testid="ease-point" onPointerDown={(e) => startDrag(e, i, 'p')}
              onContextMenu={(e) => { e.preventDefault(); remove(i) }} />
          </g>
        ))}
      </svg>
      <div className="ease-graph-tools">
        <span className="dim small">{t('easeEditor.hint')}</span>
        <Btn small icon="trash" disabled={selected === null || selected === 0 || selected === last} onClick={() => selected !== null && remove(selected)}
          testId="ease-remove-point">{t('easeEditor.removePoint')}</Btn>
      </div>
    </div>
  )
}

/**
 * Where the start-to-end line sits in the motion strip, as fractions of its width: centered, half as wide,
 * so curves that overshoot (Elastic, Back) or dip below the start (Elastic In) stay in view either side.
 */
const MOTION_FROM = 0.25
const MOTION_SPAN = 0.5

/** A dot moving with the easing, over and over, so you can see the motion. */
function Motion({ ease }: { ease: Ease }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = easeFn(ease)
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const cycle = ((now - t0) / 1000) % 2.2
      const p = Math.min(1, cycle / 1.6)
      // Kept inside the strip even for a custom curve that goes further out than the margins allow.
      const at = clamp(MOTION_FROM + f(p) * MOTION_SPAN, 0, 1)
      if (ref.current) ref.current.style.left = `calc(${(at * 100).toFixed(2)}% - 7px)`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ease])
  return (
    <div className="ease-motion" title={t('easeEditor.motion')} data-testid="ease-motion">
      <div className="ease-motion-track" style={{ left: `${MOTION_FROM * 100}%`, width: `${MOTION_SPAN * 100}%` }} />
      <div className="ease-motion-tick" style={{ left: `${MOTION_FROM * 100}%` }} />
      <div className="ease-motion-tick" style={{ left: `${(MOTION_FROM + MOTION_SPAN) * 100}%` }} />
      <div className="ease-motion-dot" ref={ref} data-testid="ease-motion-dot" />
    </div>
  )
}

export function EaseEditor() {
  useT()
  const target = useStore((s) => s.easeTarget)
  const ease = useStore((s) => {
    const c = s.easeTarget && s.project.clips.find((x) => x.id === s.easeTarget!.clipId)
    return c ? c[s.easeTarget!.field].ease : null
  })
  // Read the stored list as it is: `?? []` inside the selector would be a new array on every read,
  // which React takes as a change and re-renders forever.
  const mine = useStore((s) => s.settings.easePresets) ?? NO_PRESETS
  const [naming, setNaming] = useState<string | null>(null)
  const close = () => set({ modal: null, easeTarget: null })
  useEffect(() => {
    if (!easeOf(target)) close()
  })
  if (!target || !ease) return null

  const pick = (e: Ease) => setEase(target, e, 'pick')
  const save = () => {
    const name = (naming ?? '').trim() || t('easeEditor.defaultName', { n: mine.length + 1 })
    const curve = isCurve(ease) ? ease : curveFromEase(ease)
    patchSettings({ easePresets: [...mine, { id: uid('ez'), name, curve: clone(curve) }] })
    if (!isCurve(ease)) pick(curve)
    setNaming(null)
    toast(t('easeEditor.saved', { name }))
  }
  const Item = ({ value, label, testId, onDelete }: { value: Ease; label: string; testId: string; onDelete?: () => void }) => {
    const active = isCurve(value) ? sameCurve(value, ease) : value === ease
    return (
      <div className={`ease-item${active ? ' active' : ''}`}>
        <button type="button" onClick={() => pick(value)} data-testid={testId} title={label}>
          <EaseIcon ease={value} />
          <span>{label}</span>
        </button>
        {onDelete && <Btn small icon="trash" title={t('easeEditor.deletePreset')} onClick={onDelete} testId="ease-delete-preset" />}
      </div>
    )
  }
  return (
    <Modal title={t('easeEditor.title')} width={900} onClose={close}
      footer={
        <>
          {naming === null ? (
            <Btn icon="plus" onClick={() => setNaming('')} testId="ease-save-preset">{t('easeEditor.savePreset')}</Btn>
          ) : (
            <span className="ease-naming">
              <input className="sub-name" autoFocus value={naming} placeholder={t('easeEditor.defaultName', { n: mine.length + 1 })} data-testid="ease-preset-name"
                onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(null) } }} />
              <Btn primary small onClick={save} testId="ease-preset-save">{t('common.save')}</Btn>
              <Btn small onClick={() => setNaming(null)}>{t('common.cancel')}</Btn>
            </span>
          )}
          <span className="toolbar-spacer" />
          <Btn primary onClick={close} testId="ease-done">{t('common.done')}</Btn>
        </>
      }>
      <div className="ease-editor">
        <div className="ease-list" data-testid="ease-presets">
          <h4>{t('easeEditor.mine')}</h4>
          {mine.length === 0 && <p className="dim small">{t('easeEditor.mineEmpty')}</p>}
          {mine.map((p) => (
            <Item key={p.id} value={p.curve} label={p.name} testId="ease-my-preset"
              onDelete={() => patchSettings({ easePresets: mine.filter((x) => x.id !== p.id) })} />
          ))}
          <h4>{t('easeEditor.basic')}</h4>
          <Item value="linear" label={easeName('linear')} testId="ease-preset-linear" />
          {EASE_FAMILIES.map((f) => (
            <div key={f}>
              <h4>{t(`easing.families.${f}`)}</h4>
              {(['In', 'Out', 'InOut'] as const).map((k) => (
                <Item key={k} value={`ease${k}${f}`} label={t(`easing.kinds.${k}`)} testId={`ease-preset-ease${k}${f}`} />
              ))}
            </div>
          ))}
        </div>
        <div className="ease-main">
          <div className="ease-current">
            <EaseIcon ease={ease} width={28} height={20} />
            <span data-testid="ease-current-name">{easeLabel(ease)}</span>
            {!isCurve(ease) && <span className="dim small">{t('easeEditor.builtInHint')}</span>}
          </div>
          <Graph target={target} ease={ease} />
          <Motion ease={ease} />
        </div>
      </div>
    </Modal>
  )
}

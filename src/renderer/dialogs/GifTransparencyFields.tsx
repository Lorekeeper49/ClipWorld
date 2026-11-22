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

// The transparent-GIF part of the Export window: a see-through background, an optional color made
// see-through (like the Color mask), and a preview of the frame at the playhead as the GIF will show it.
import { useEffect, useRef } from 'react'
import type { GifTransparency } from '@shared/formats'
import { REF_HEIGHT } from '@shared/model'
import { Color, Slider, Toggle } from '../components/ui'
import { Scratch, applyMask, colorKeyCanvas } from '../engine/layers'
import { player } from '../engine/player'
import { useT } from '../i18n'
import { useStore } from '../state/store'

const scratch = new Scratch()
const hex = (v: number) => v.toString(16).padStart(2, '0')

function GifPreview({ gif, onPick }: { gif: GifTransparency; onPick: (color: string) => void }) {
  const t = useT()
  const ref = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLCanvasElement | null>(null)
  const projectH = useStore((s) => s.project.settings.height)
  useEffect(() => {
    let live = true
    void (async () => {
      // Wait (briefly) for the videos under the playhead to have their picture.
      for (let i = 0; i < 120 && !player.ready(); i++) await new Promise((r) => requestAnimationFrame(r))
      const out = ref.current
      const frame = live && out ? player.frameCanvas(gif.transparent) : null
      if (!frame || !out) return
      frameRef.current = frame
      out.width = frame.width
      out.height = frame.height
      const ctx = out.getContext('2d', { willReadFrequently: true })!
      ctx.clearRect(0, 0, out.width, out.height)
      ctx.drawImage(frame, 0, 0)
      if (!gif.transparent) return
      if (gif.key) {
        const key = colorKeyCanvas(frame, gif.color, gif.tolerance, gif.softness)
        const feather = (gif.feather * frame.height) / REF_HEIGHT
        if (key) {
          // What is already see-through counts as hidden too (as in the export), before feathering.
          const mask = scratch.get(0, frame.width, frame.height)
          mask.ctx.drawImage(key, 0, 0)
          mask.ctx.globalCompositeOperation = 'destination-in'
          mask.ctx.drawImage(frame, 0, 0)
          mask.ctx.globalCompositeOperation = 'source-over'
          applyMask({ canvas: out, ctx }, mask.canvas, { id: 'gif', type: 'colorMask', enabled: true, params: { invert: false } }, feather, scratch)
        }
      }
      // As in the GIF: a pixel is see-through or solid, cut at half.
      const img = ctx.getImageData(0, 0, out.width, out.height)
      const px = img.data
      for (let i = 3; i < px.length; i += 4) px[i] = px[i] >= 128 ? 255 : 0
      ctx.putImageData(img, 0, 0)
    })()
    return () => {
      live = false
    }
  }, [gif.transparent, gif.key, gif.color, gif.tolerance, gif.softness, gif.feather, projectH])

  /** Clicking the picture picks the color under the pointer (from the frame before anything is hidden). */
  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = frameRef.current
    if (!frame || !gif.key) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * frame.width)
    const y = Math.floor(((e.clientY - r.top) / r.height) * frame.height)
    const d = frame.getContext('2d')!.getImageData(Math.min(frame.width - 1, Math.max(0, x)), Math.min(frame.height - 1, Math.max(0, y)), 1, 1).data
    if (d[3] > 0) onPick(`#${hex(d[0])}${hex(d[1])}${hex(d[2])}`)
  }

  return (
    <figure className="gif-preview">
      <canvas ref={ref} onClick={pick} className={gif.key ? 'pickable' : ''} data-testid="gif-preview"
        title={gif.key ? t('export.gif.pickHint') : undefined} />
      <figcaption className="dim small">{gif.key ? t('export.gif.previewPick') : t('export.gif.preview')}</figcaption>
    </figure>
  )
}

export function GifTransparencyFields({ gif, onChange }: { gif: GifTransparency; onChange: (patch: Partial<GifTransparency>) => void }) {
  const t = useT()
  return (
    <div className="gif-transparency">
      <Toggle label={t('export.gif.transparent')} value={gif.transparent} onChange={(v) => onChange({ transparent: v })} testId="gif-transparent" />
      <p className="dim small toggle-hint">{t('export.gif.transparentHint')}</p>
      {gif.transparent && (
        <>
          <Toggle label={t('export.gif.key')} value={gif.key} onChange={(v) => onChange({ key: v })} testId="gif-key" />
          {gif.key && (
            <>
              <Color label={t('export.gif.color')} value={gif.color} onChange={(v) => onChange({ color: v })} />
              <Slider label={t('export.gif.tolerance')} value={gif.tolerance} min={0.01} max={1} step={0.005} display={100} unit="%" reset={0.15}
                onChange={(v) => onChange({ tolerance: v })} testId="gif-tolerance" />
              <Slider label={t('export.gif.softness')} value={gif.softness} min={0} max={1} step={0.01} display={100} unit="%" reset={0.05}
                onChange={(v) => onChange({ softness: v })} testId="gif-softness" />
              <Slider label={t('export.gif.feather')} value={gif.feather} min={0} max={50} field={{ min: 0, max: 200 }} step={0.5} unit="px" reset={0}
                onChange={(v) => onChange({ feather: v })} testId="gif-feather" />
            </>
          )}
          <GifPreview gif={gif} onPick={(color) => onChange({ color })} />
        </>
      )}
    </div>
  )
}

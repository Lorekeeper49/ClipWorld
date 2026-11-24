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

// The preview of plugin picture effects. A plugin effect is an ffmpeg filter, which the browser can't
// run, so while the preview is paused the layer is sent to ffmpeg (through the plugin's filter) and the
// result is drawn once it arrives. While playing, the layer is shown without the effect.
import type { EffectInstance } from '@shared/model'

const MAX = 40
const done = new Map<string, ImageBitmap | 'failed'>()
const busy = new Set<string>()
let warned = new Set<string>()

function remember(key: string, v: ImageBitmap | 'failed'): void {
  done.set(key, v)
  while (done.size > MAX) {
    const first = done.keys().next().value as string
    const old = done.get(first)
    if (old && old !== 'failed') old.close()
    done.delete(first)
  }
}

export interface PluginPreviewEnv {
  playing: boolean
  fps: number
  /** Asks the preview to draw again (when a result arrives). */
  redraw: () => void
}

/**
 * The layer with the plugin effect applied, if it's ready; otherwise null (and, while paused, it gets
 * made). `frame` identifies what's in the layer (clip and time), so a result is only reused for it.
 */
export function pluginEffectLayer(
  e: EffectInstance, src: HTMLCanvasElement, cw: number, ch: number, pxRef: number, frame: string, duration: number, env: PluginPreviewEnv
): CanvasImageSource | null {
  const key = `${e.type}|${JSON.stringify(e.params)}|${frame}|${cw}x${ch}`
  const hit = done.get(key)
  if (hit) return hit === 'failed' ? null : hit
  if (env.playing || busy.has(e.id)) return null
  busy.add(e.id)
  // The scratch canvas is reused right after this, so the picture is copied now.
  const copy = document.createElement('canvas')
  copy.width = cw
  copy.height = ch
  copy.getContext('2d')!.drawImage(src, 0, 0)
  copy.toBlob(async (blob) => {
    try {
      if (!blob) throw new Error('Could not read the picture')
      const r = await window.cw.pluginPreviewFrame({
        type: e.type, params: e.params, png: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch, scale: pxRef, fps: env.fps, duration
      })
      if (r.error) throw new Error(r.error)
      remember(key, r.png ? await createImageBitmap(new Blob([r.png as BlobPart], { type: 'image/png' })) : 'failed')
    } catch (err) {
      remember(key, 'failed')
      if (!warned.has(e.type)) {
        warned.add(e.type)
        console.warn(`[plugins] preview of ${e.type} failed:`, (err as Error).message)
      }
    } finally {
      busy.delete(e.id)
      env.redraw()
    }
  }, 'image/png')
  return null
}

/** Forgets every result (plugins turned off or restarted). */
export function clearPluginPreviews(): void {
  for (const v of done.values()) if (v !== 'failed') v.close()
  done.clear()
  warned = new Set()
}

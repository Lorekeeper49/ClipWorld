// Scroll state of the timeline and lazily-loaded assets (waveform peaks, filmstrips) for clip drawing.
import { useEffect, useState } from 'react'

export const HEADER_W = 132
export const RULER_H = 26
export const LANE_H = { video: 58, audio: 46 } as const

/** Visible horizontal window of the timeline scroller, in content pixels. */
export const view = {
  left: 0,
  width: 0,
  listeners: new Set<() => void>(),
  set(left: number, width: number): void {
    if (left === this.left && width === this.width) return
    this.left = left
    this.width = width
    for (const l of this.listeners) l()
  },
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

const peaksCache = new Map<string, Uint8Array | Promise<Uint8Array | null> | null>()

/** Waveform peaks for a cached peaks file (one byte per 1/PEAKS_PER_SECOND s). */
export function usePeaks(url: string | undefined): Uint8Array | null {
  const [, bump] = useState(0)
  const cur = url ? peaksCache.get(url) : null
  useEffect(() => {
    if (!url || peaksCache.has(url)) return
    let alive = true
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => new Uint8Array(b))
      .catch(() => null)
    peaksCache.set(url, p)
    void p.then((data) => {
      peaksCache.set(url, data)
      if (alive) bump((v) => v + 1)
    })
    return () => {
      alive = false
    }
  }, [url])
  // A request started by another clip: re-render when it lands.
  useEffect(() => {
    if (!(cur instanceof Promise)) return
    let alive = true
    void cur.then(() => alive && bump((v) => v + 1))
    return () => {
      alive = false
    }
  }, [cur])
  return cur instanceof Uint8Array ? cur : null
}

const imageCache = new Map<string, HTMLImageElement>()

export function useImage(url: string | undefined): HTMLImageElement | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!url) return
    let img = imageCache.get(url)
    if (!img) {
      img = new Image()
      img.src = url
      imageCache.set(url, img)
    }
    if (img.complete) return
    const on = () => bump((v) => v + 1)
    img.addEventListener('load', on)
    return () => img!.removeEventListener('load', on)
  }, [url])
  const img = url ? imageCache.get(url) : undefined
  return img && img.complete && img.naturalWidth > 0 ? img : null
}

/** Picks a ruler tick spacing (seconds) that keeps labels at least ~80px apart. */
export function tickStep(pps: number): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  for (const s of steps) if (s * pps >= 80) return s
  return 7200
}

export function tickLabel(t: number, step: number): string {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const sec = step < 1 ? s.toFixed(2).padStart(5, '0') : String(Math.round(s)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

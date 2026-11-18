// The preview engine: a master clock, pooled <video>/<audio> elements kept in sync with it, a canvas
// compositor and the Web Audio graph. It reads the project straight from the store every frame.
import { useSyncExternalStore } from 'react'
import { clamp, transformAt } from '@shared/easing'
import { fadeFactor, n as nParam, s as sParam } from '@shared/effects'
import { layerInfo } from '@shared/filtergraph'
import {
  type Clip, type EffectInstance, type MediaItem, type Project, REF_HEIGHT, type SubtitleCue, type SubtitleTrack, clipEnd, fitSize,
  projectDuration
} from '@shared/model'
import { activeClips } from '@shared/timeline-ops'
import { chunkName } from '@shared/ipc'
import { type State, get, set, useStore } from '../state/store'
import { AudioEngine, type EffectChain } from './audio'
import { type LayerEnv, Scratch, applyMask, differenceMaskCanvas, renderLayer } from './layers'
import { measureText, rasterSubtitle, rasterText } from './raster'
import { clipTrackTime, cueAt } from '@shared/subtitles'

type Mode = 'play' | 'hold' | 'paused'
type Role = 'active' | 'preload'

interface VideoSlot {
  el: HTMLVideoElement
  /** Source key (`clipId#part`) this element is assigned to, or null when free. */
  clipId: string | null
  role: Role
  url: string
  mediaId: string
  failed: boolean
}

/** Which file shows a video clip at a given moment, and where in that file. */
interface VideoSource {
  /** `clipId#o` for the original, `clipId#<k>` for preview chunk k, `clipId#a` for an animated image. */
  key: string
  url: string
  /** Position inside `url`, seconds. */
  time: number
  mediaId: string
  /** Timeline time at which this source stops covering the clip (next chunk or clip end). */
  until: number
}

/**
 * Picks the fastest thing to show for clip `c` at timeline time `t`: the fast-seek preview chunk when
 * it is built, otherwise the original file. `current` is the key already playing this clip; while
 * playing, an element showing the original keeps going instead of switching mid-stream.
 */
function resolveVideo(s: State, c: Clip, m: MediaItem | undefined, t: number, current?: string): VideoSource | null {
  if (!m) return null
  const cache = s.mediaCache[m.id]
  if (!cache || cache.missing) return null
  const src = sourceTime(c, t)
  const end = clipEnd(c)
  if (m.kind === 'image') {
    return cache.proxyUrl && cache.proxyState === 'ready'
      ? { key: `${c.id}#a`, url: cache.proxyUrl, time: src, mediaId: m.id, until: end }
      : null
  }
  const ch = cache.chunks
  const original: VideoSource | null =
    cache.sourceUrl && s.playable[m.id] !== 'bad' && !ch?.required
      ? { key: `${c.id}#o`, url: cache.sourceUrl, time: src, mediaId: m.id, until: end }
      : null
  if (original && current === original.key) return original
  if (ch) {
    const k = Math.min(ch.count - 1, Math.max(0, Math.floor(src / ch.seconds + 1e-9)))
    if (ch.done.includes(k)) {
      const chunkEnd = (k + 1) * ch.seconds
      const until = k < ch.count - 1 && c.speed > 0 ? Math.min(end, c.start + (chunkEnd - c.srcIn) / c.speed) : end
      return { key: `${c.id}#${k}`, url: ch.prefix + chunkName(k), time: src - k * ch.seconds, mediaId: m.id, until }
    }
  }
  return original
}

interface AudioSlot {
  el: HTMLAudioElement
  node: MediaElementAudioSourceNode
  chain: EffectChain | null
  gain: GainNode
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  clipId: string | null
  url: string
}

const PRELOAD_WINDOW = 1.0
const EPS = 1e-3

const isVideoLike = (c: Clip, m?: MediaItem): boolean => c.type === 'video' || (c.type === 'image' && !!m?.animated)
const sourceTime = (c: Clip, t: number): number => c.srcIn + clamp(t - c.start, 0, c.duration) * c.speed

/** True when `next` continues exactly where `prev` leaves off in the same source (e.g. after a split). */
function continues(prev: Clip, next: Clip): boolean {
  return (
    prev.mediaId === next.mediaId &&
    prev.audioStream === next.audioStream &&
    Math.abs(prev.speed - next.speed) < 1e-6 &&
    Math.abs(clipEnd(prev) - next.start) < EPS &&
    Math.abs(prev.srcIn + prev.duration * prev.speed - next.srcIn) < 0.02
  )
}

class Player {
  time = 0
  playing = false

  private listeners = new Set<() => void>()
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private videos: VideoSlot[] = []
  /** Source chosen for each visible clip on the last tick. */
  private activeKeys = new Map<string, VideoSource>()
  private focusSent = new Map<string, number>()
  private lastShown = new Map<string, HTMLVideoElement>()
  private focusAt = 0
  private audios: AudioSlot[] = []
  private images = new Map<string, HTMLImageElement>()
  private texts = new Map<string, { key: string; canvas: HTMLCanvasElement; w: number; h: number }>()
  private audio: AudioEngine | null = null
  private last = 0
  private needsDraw = true
  private holdSince = 0
  private lastVolume = -1
  private started = false

  // ------------------------------------------------------------ public API

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.needsDraw = true
    if (!this.started) {
      this.started = true
      useStore.subscribe(() => {
        this.needsDraw = true
      })
      this.last = performance.now()
      requestAnimationFrame(this.tick)
    }
  }

  detach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) {
      this.canvas = null
      this.ctx = null
    }
  }

  invalidate(): void {
    this.needsDraw = true
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  play(): void {
    if (this.playing) return
    const total = projectDuration(get().project)
    if (total <= 0) return
    if (this.time >= total - EPS) this.time = 0
    this.engine().resume()
    this.playing = true
    this.holdSince = 0
    this.last = performance.now()
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.needsDraw = true
    this.emit()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(t: number): void {
    const total = projectDuration(get().project)
    this.time = clamp(t, 0, Math.max(total, 0))
    this.needsDraw = true
    this.emit()
  }

  step(frames: number): void {
    const fps = get().project.settings.fps || 30
    this.pause()
    this.seek(Math.round(this.time * fps + frames) / fps)
  }

  /** Current output level (peak, 1 = full scale) of a playing audio clip. */
  level(clipId: string): number {
    const slot = this.audios.find((s) => s.clipId === clipId)
    if (!slot || !this.playing) return 0
    slot.analyser.getFloatTimeDomainData(slot.buf)
    let peak = 0
    for (let i = 0; i < slot.buf.length; i++) {
      const v = Math.abs(slot.buf[i])
      if (v > peak) peak = v
    }
    return peak
  }

  /** Renders the current frame to a PNG data URL (used by tests to compare preview and export). */
  snapshot(): string | null {
    const s = get()
    this.draw(s.project, activeClips(s.project, this.time).visual)
    return this.canvas?.toDataURL('image/png') ?? null
  }

  /** Whether every video needed for the current frame has a decoded frame available. */
  ready(): boolean {
    const s = get()
    const p = s.project
    for (const c of activeClips(p, this.time).visual) {
      const m = p.media.find((x) => x.id === c.mediaId)
      if (!isVideoLike(c, m)) continue
      // Judge against the current playhead, not the last tick's choice: a seek may not have been synced yet.
      const want = resolveVideo(s, c, m, this.time, this.activeKeys.get(c.id)?.key)
      const src = this.activeKeys.get(c.id)
      const slot = src ? this.videos.find((v) => v.clipId === src.key) : undefined
      if (!want || !src || src.key !== want.key || !slot || slot.el.readyState < 2 || slot.el.seeking) return false
      if (Math.abs(slot.el.currentTime - want.time) > 0.05) return false
    }
    return true
  }

  /** Which source each visible clip is using: 'original', 'chunk', or 'none' (for tests and diagnostics). */
  sources(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [clipId, src] of this.activeKeys) out[clipId] = src.key.endsWith('#o') ? 'original' : src.key.endsWith('#a') ? 'proxy' : 'chunk'
    return out
  }

  // ------------------------------------------------------------ internals

  private engine(): AudioEngine {
    if (!this.audio) {
      this.audio = new AudioEngine()
      this.lastVolume = -1
    }
    return this.audio
  }

  private tick = (now: number): void => {
    requestAnimationFrame(this.tick)
    const s = get()
    const p = s.project
    const dt = Math.min(0.25, (now - this.last) / 1000)
    this.last = now

    if (this.playing) {
      const stalled = this.isStalled()
      if (stalled && !this.holdSince) this.holdSince = now
      if (!stalled) this.holdSince = 0
      // Wait for a buffering video rather than letting picture and sound drift, but never forever.
      if (!stalled || now - this.holdSince > 3000) {
        const total = projectDuration(p)
        this.time += dt
        if (this.time >= total) {
          this.time = total
          this.playing = false
        }
        this.emit()
      }
    }
    const mode: Mode = !this.playing ? 'paused' : this.holdSince && now - this.holdSince > 150 ? 'hold' : 'play'

    const active = activeClips(p, this.time)
    const upcoming: Clip[] = []
    if (this.playing) {
      const hidden = new Set(p.tracks.filter((t) => t.hidden || t.muted).map((t) => t.id))
      for (const c of p.clips) {
        if (c.start > this.time && c.start - this.time < PRELOAD_WINDOW && !hidden.has(c.trackId)) upcoming.push(c)
      }
    }
    const busy = this.syncVideos(s, p, active.visual, upcoming, mode)
    this.syncAudios(s, p, active.audio, upcoming, mode)
    this.reportFocus(s, p, active.visual, now)

    if (this.audio && s.settings.previewVolume !== this.lastVolume) {
      this.lastVolume = s.settings.previewVolume
      this.audio.setMasterVolume(this.lastVolume)
    }
    if (this.playing || this.needsDraw || busy) {
      this.needsDraw = false
      this.draw(p, active.visual)
    }
  }

  private isStalled(): boolean {
    for (const slot of this.videos) {
      // Only what is on screen can hold playback; an element preloading the next clip cannot.
      if (!slot.clipId || slot.failed || !slot.url || slot.role !== 'active') continue
      if (slot.el.readyState < 2 || slot.el.seeking) return true
    }
    return false
  }

  /** Tells the main process where the user is working so nearby preview chunks are built first. */
  private reportFocus(s: State, p: Project, visual: Clip[], now: number): void {
    if (now - this.focusAt < 400) return
    this.focusAt = now
    for (const c of visual) {
      const m = p.media.find((x) => x.id === c.mediaId)
      const ch = m ? s.mediaCache[m.id]?.chunks : undefined
      if (!m || !ch || ch.done.length >= ch.count) continue
      const src = sourceTime(c, this.time)
      const prev = this.focusSent.get(m.id)
      if (prev === undefined || Math.abs(prev - src) > 5) {
        this.focusSent.set(m.id, src)
        window.cw.proxyFocus(m.id, src)
      }
    }
  }

  private syncElement(el: HTMLMediaElement, target: number, c: Clip, mode: Mode, role: Role): void {
    if (el.readyState < 1) return
    let t = target
    if (Number.isFinite(el.duration)) t = clamp(t, 0, Math.max(0, el.duration - 0.02))
    if (role === 'preload' || mode !== 'play') {
      if (!el.paused) el.pause()
      if (mode === 'hold' && role === 'active') return
      if (!el.seeking && Math.abs(el.currentTime - t) > 0.012) el.currentTime = t
      return
    }
    const rate = clamp(c.speed, 0.0625, 16)
    if (el.playbackRate !== rate) el.playbackRate = rate
    if (el.preservesPitch !== c.preservePitch) el.preservesPitch = c.preservePitch
    const drift = el.currentTime - t
    if (el.paused) {
      if (Math.abs(drift) > 0.04 && !el.seeking) el.currentTime = t
      el.play().catch(() => {})
    } else if (Math.abs(drift) > Math.max(0.3, 0.2 * rate) && !el.seeking) {
      el.currentTime = t
    }
  }

  /** Returns true while any assigned video is still seeking/loading (so the canvas keeps redrawing). */
  private syncVideos(s: State, p: Project, visual: Clip[], upcoming: Clip[], mode: Mode): boolean {
    const wanted = new Map<string, { clip: Clip; src: VideoSource; role: Role }>()
    this.activeKeys.clear()
    for (const id of this.lastShown.keys()) if (!visual.some((c) => c.id === id)) this.lastShown.delete(id)
    for (const c of visual) {
      const m = p.media.find((x) => x.id === c.mediaId)
      if (!isVideoLike(c, m)) continue
      const current =
        mode === 'play'
          ? (this.videos.find((v) => v.role === 'active' && v.clipId?.startsWith(c.id + '#'))?.clipId ?? undefined)
          : undefined
      const src = resolveVideo(s, c, m, this.time, current)
      if (!src) continue
      wanted.set(src.key, { clip: c, src, role: 'active' })
      this.activeKeys.set(c.id, src)
      // Crossing into the next preview chunk: have it loaded and positioned before the boundary.
      if (this.playing && src.until < clipEnd(c) - EPS && src.until - this.time < PRELOAD_WINDOW) {
        const next = resolveVideo(s, c, m, src.until + 1e-4)
        if (next && !wanted.has(next.key)) wanted.set(next.key, { clip: c, src: next, role: 'preload' })
      }
    }
    for (const c of upcoming) {
      const m = p.media.find((x) => x.id === c.mediaId)
      if (!isVideoLike(c, m)) continue
      // A clip that simply continues an active one takes over its element; no separate preload.
      if (visual.some((a) => continues(a, c))) continue
      const src = resolveVideo(s, c, m, c.start)
      if (src && !wanted.has(src.key)) wanted.set(src.key, { clip: c, src, role: 'preload' })
    }
    for (const slot of this.videos) if (slot.clipId && !wanted.has(slot.clipId)) slot.clipId = null

    let busy = false
    for (const [key, w] of wanted) {
      let slot = this.videos.find((v) => v.clipId === key)
      if (slot && slot.url !== w.src.url) {
        slot.clipId = null
        slot = undefined
      }
      if (!slot) {
        const free = this.videos.filter((v) => !v.clipId)
        slot =
          free.find((v) => v.url === w.src.url && Math.abs(v.el.currentTime - w.src.time) < 0.2) ??
          free.find((v) => v.url === w.src.url) ??
          free[0] ??
          this.createVideoSlot()
        slot.clipId = key
        slot.mediaId = w.src.mediaId
        if (slot.url !== w.src.url) {
          slot.url = w.src.url
          slot.failed = false
          slot.el.src = w.src.url
        }
      }
      slot.role = w.role
      if (slot.failed) continue
      this.syncElement(slot.el, w.src.time, w.clip, mode, w.role)
      if (w.role === 'active' && (slot.el.seeking || slot.el.readyState < 2)) busy = true
    }
    const free = this.videos.filter((v) => !v.clipId)
    free.forEach((v, i) => {
      if (!v.el.paused) v.el.pause()
      if (i >= 4) {
        v.el.removeAttribute('src')
        v.el.load()
        this.videos.splice(this.videos.indexOf(v), 1)
      }
    })
    return busy
  }

  private createVideoSlot(): VideoSlot {
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    const slot: VideoSlot = { el, clipId: null, role: 'preload', url: '', mediaId: '', failed: false }
    const redraw = () => {
      this.needsDraw = true
    }
    el.addEventListener('seeked', redraw)
    el.addEventListener('loadeddata', redraw)
    el.addEventListener('error', () => {
      slot.failed = true
      const st = get()
      const cache = st.mediaCache[slot.mediaId]
      // The original could not be decoded: ask for a proxy and stop trying the original.
      if (cache && slot.url === cache.sourceUrl && st.playable[slot.mediaId] !== 'bad') {
        set({ playable: { ...st.playable, [slot.mediaId]: 'bad' } })
        void window.cw.requestProxy(slot.mediaId)
      }
    })
    this.videos.push(slot)
    return slot
  }

  private syncAudios(s: ReturnType<typeof get>, p: Project, audio: Clip[], upcoming: Clip[], mode: Mode): void {
    const wanted = new Map<string, { clip: Clip; url: string; target: number; role: Role }>()
    const urlFor = (c: Clip): string | null => {
      const cache = c.mediaId ? s.mediaCache[c.mediaId] : undefined
      return cache && !cache.missing ? (cache.audioUrls[c.audioStream] ?? null) : null
    }
    for (const c of audio) {
      const url = urlFor(c)
      if (url) wanted.set(c.id, { clip: c, url, target: sourceTime(c, this.time), role: 'active' })
    }
    for (const c of upcoming) {
      if (c.type !== 'audio' || audio.some((a) => continues(a, c))) continue
      const url = urlFor(c)
      if (url) wanted.set(c.id, { clip: c, url, target: c.srcIn, role: 'preload' })
    }
    for (const slot of this.audios) if (slot.clipId && !wanted.has(slot.clipId)) slot.clipId = null
    if (!wanted.size && !this.audios.length) return

    const engine = this.engine()
    const now = engine.ctx.currentTime
    for (const [id, w] of wanted) {
      let slot = this.audios.find((a) => a.clipId === id)
      if (slot && slot.url !== w.url) {
        slot.clipId = null
        slot = undefined
      }
      if (!slot) {
        const free = this.audios.filter((a) => !a.clipId)
        slot =
          free.find((a) => a.url === w.url && Math.abs(a.el.currentTime - w.target) < 0.2) ??
          free.find((a) => a.url === w.url) ??
          free[0] ??
          this.createAudioSlot(engine)
        slot.clipId = id
        if (slot.url !== w.url) {
          slot.url = w.url
          slot.el.src = w.url
        }
      }
      const sig = engine.signature(w.clip.effects)
      if (!slot.chain || slot.chain.signature !== sig) {
        slot.node.disconnect()
        slot.chain?.dispose()
        slot.chain = engine.buildChain(w.clip.effects)
        slot.node.connect(slot.chain.input)
        slot.chain.output.connect(slot.gain)
      }
      const local = this.time - w.clip.start
      const g =
        w.role === 'active' && !w.clip.muted
          ? w.clip.volume * fadeFactor(w.clip.effects, local, w.clip.duration, true)
          : 0
      slot.gain.gain.setTargetAtTime(g, now, 0.012)
      this.syncElement(slot.el, w.target, w.clip, mode, w.role)
    }
    const free = this.audios.filter((a) => !a.clipId)
    free.forEach((a, i) => {
      if (!a.el.paused) a.el.pause()
      a.gain.gain.setTargetAtTime(0, now, 0.012)
      if (i >= 6) {
        a.node.disconnect()
        a.chain?.dispose()
        a.gain.disconnect()
        a.analyser.disconnect()
        a.el.removeAttribute('src')
        a.el.load()
        this.audios.splice(this.audios.indexOf(a), 1)
      }
    })
  }

  private createAudioSlot(engine: AudioEngine): AudioSlot {
    const el = document.createElement('audio')
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    const node = engine.ctx.createMediaElementSource(el)
    const gain = engine.ctx.createGain()
    gain.gain.value = 0
    const analyser = engine.ctx.createAnalyser()
    analyser.fftSize = 1024
    gain.connect(analyser)
    analyser.connect(engine.master)
    const slot: AudioSlot = { el, node, chain: null, gain, analyser, buf: new Float32Array(1024), clipId: null, url: '' }
    this.audios.push(slot)
    return slot
  }

  private image(url: string): HTMLImageElement | null {
    let img = this.images.get(url)
    if (!img) {
      img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        this.needsDraw = true
      }
      img.src = url
      this.images.set(url, img)
    }
    return img.complete && img.naturalWidth > 0 ? img : null
  }

  private text(c: Clip, H: number, px: number): { canvas: HTMLCanvasElement; w: number; h: number; q: number } | null {
    if (!c.text) return null
    const m = measureText(c.text, H)
    const info = layerInfo(c, undefined, get().project.settings, { w: m.w, h: m.h, k: 4 })
    const q = info?.q ?? 1
    const maxDim = Math.max(m.w, m.h)
    const k = Math.max(0.05, Math.min(px * q, 4096 / maxDim))
    const key = `${JSON.stringify(c.text)}|${H}|${k.toFixed(3)}`
    const hit = this.texts.get(c.id)
    if (hit && hit.key === key) return { ...hit, q }
    const r = rasterText(c.text, H, k)
    this.texts.set(c.id, { key, canvas: r.canvas, w: r.w, h: r.h })
    if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!)
    return { canvas: r.canvas, w: r.w, h: r.h, q }
  }

  private draw(p: Project, visual: Clip[]): void {
    const { canvas, ctx } = this
    if (!canvas || !ctx) return
    const s = get()
    const W = p.settings.width
    const H = p.settings.height
    const px = canvas.width / W
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'

    for (const c of visual) {
      const local = this.time - c.start
      let source: CanvasImageSource | null = null
      let bw = 0
      let bh = 0
      if (c.type === 'text') {
        const t = this.text(c, H, px)
        if (!t) continue
        source = t.canvas
        bw = t.w
        bh = t.h
      } else if (c.type === 'subtitles') {
        const track = p.subtitles.find((t) => t.id === c.subtitleTrackId)
        const cue = track && cueAt(track, clipTrackTime(c, this.time))
        if (!track || !cue) continue
        const info = layerInfo(c, undefined, p.settings, { w: W, h: H, k: 4 })
        source = this.subtitle(track, cue, W, H, px * (info?.q ?? 1))
        bw = W
        bh = H
      } else {
        const m = p.media.find((x) => x.id === c.mediaId)
        const info = layerInfo(c, m, p.settings)
        if (!m || !info) continue
        bw = info.bw
        bh = info.bh
        if (isVideoLike(c, m)) {
          const key = this.activeKeys.get(c.id)?.key
          const slot = key ? this.videos.find((v) => v.clipId === key) : undefined
          if (slot && !slot.failed && slot.el.readyState >= 2) {
            source = slot.el
            this.lastShown.set(c.id, slot.el)
          } else {
            // Switching files (e.g. to a preview chunk): keep showing the previous picture until the
            // new one has a frame, rather than flashing black.
            const prev = this.lastShown.get(c.id)
            if (prev && prev.readyState >= 2 && prev.src) source = prev
            else if (m.kind === 'image') source = this.image(s.mediaCache[m.id]?.sourceUrl ?? '')
          }
        } else {
          const url = s.mediaCache[m.id]?.sourceUrl
          if (url) source = this.image(url)
        }
      }
      if (!source) continue
      const tr = transformAt(c.transform, local, c.duration)
      const alpha = clamp(tr.opacity, 0, 1) * fadeFactor(c.effects, local, c.duration)
      if (alpha <= 0) continue
      const cw = Math.max(1, Math.round(bw * px))
      const ch = Math.max(1, Math.round(bh * px))
      const layer = renderLayer(c, source, cw, ch, (H / REF_HEIGHT) * px, local, this.layerEnv)
      const place = (target: CanvasRenderingContext2D) => {
        target.save()
        target.globalAlpha = alpha
        target.translate((W / 2 + tr.x * W) * px, (H / 2 + tr.y * H) * px)
        if (tr.rotation) target.rotate((tr.rotation * Math.PI) / 180)
        if (tr.scale !== 1) target.scale(tr.scale, tr.scale)
        target.drawImage(layer.image, -cw / 2 - layer.pad, -ch / 2 - layer.pad, cw + layer.pad * 2, ch + layer.pad * 2)
        target.restore()
      }
      // Difference mask: as in the export, the clip is placed on a transparent frame, compared with the
      // reference (what the canvas already shows underneath, or a clean background), and hidden where
      // they match.
      const diff = c.effects.find((e) => e.enabled && e.type === 'differenceMask')
      const reference = diff
        ? sParam(diff, 'reference') === 'plate' ? this.plate(p, s, diff, canvas.width, canvas.height) : canvas
        : null
      if (!diff || !reference) {
        // A clean background still loading (or missing) shows the clip unmasked for now.
        place(ctx)
        continue
      }
      const pos = this.frameScratch.get(0, canvas.width, canvas.height)
      place(pos.ctx)
      const mask = differenceMaskCanvas(pos.canvas, reference, diff)
      if (mask) applyMask(pos, mask, diff, nParam(diff, 'feather') * (H / REF_HEIGHT) * px, this.frameScratch)
      ctx.drawImage(pos.canvas, 0, 0)
    }

    // Editing guide: the subtitle track open in the Subtitles window, while it is not on the timeline.
    // Shown in the preview only, never exported.
    const guide = s.subtitleGuide ? p.subtitles.find((t) => t.id === s.activeSubtitleTrack) : undefined
    if (guide && !p.clips.some((c) => c.subtitleTrackId === guide.id)) {
      const cue = cueAt(guide, this.time)
      if (cue) {
        ctx.save()
        ctx.globalAlpha = 0.85
        ctx.drawImage(this.subtitle(guide, cue, W, H, px), 0, 0, canvas.width, canvas.height)
        ctx.restore()
      }
    }
  }

  /** Scratch canvases at preview-frame size (difference masks). */
  private frameScratch = new Scratch()

  /** Image lookups for image masks: the media's still image, once loaded. */
  private layerEnv: LayerEnv = {
    image: (mediaId) => {
      const url = get().mediaCache[mediaId]?.sourceUrl
      return url ? this.image(url) : null
    }
  }

  private plates = new Map<string, { canvas: HTMLCanvasElement; ready: boolean }>()

  /**
   * A difference mask's clean background as a full-frame canvas: an image, or one frame of a video,
   * fitted into the frame like an untransformed clip on black (as in the export). Null until loaded.
   */
  private plate(p: Project, s: State, e: EffectInstance, w: number, h: number): HTMLCanvasElement | null {
    const m = p.media.find((x) => x.id === sParam(e, 'plate') && (x.kind === 'video' || (x.kind === 'image' && !x.animated)))
    const url = m ? s.mediaCache[m.id]?.sourceUrl : undefined
    if (!m || !url) return null
    const at = m.kind === 'video' ? clamp(nParam(e, 'plateTime'), 0, Math.max(0, m.duration - 0.05)) : 0
    const key = `${m.id}|${at.toFixed(3)}|${w}x${h}`
    const hit = this.plates.get(key)
    if (hit) return hit.ready ? hit.canvas : null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const entry = { canvas, ready: false }
    this.plates.set(key, entry)
    if (this.plates.size > 8) this.plates.delete(this.plates.keys().next().value!)
    const paint = (src: CanvasImageSource) => {
      const c2 = canvas.getContext('2d')!
      c2.fillStyle = '#000'
      c2.fillRect(0, 0, w, h)
      c2.imageSmoothingQuality = 'high'
      const f = fitSize(m.width, m.height, w, h)
      c2.drawImage(src, (w - f.w) / 2, (h - f.h) / 2, f.w, f.h)
      entry.ready = true
      this.needsDraw = true
    }
    if (m.kind === 'image') {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => paint(img)
      img.src = url
    } else {
      const v = document.createElement('video')
      v.crossOrigin = 'anonymous'
      v.muted = true
      v.preload = 'auto'
      v.addEventListener('loadedmetadata', () => {
        v.currentTime = at
      }, { once: true })
      v.addEventListener('seeked', () => {
        paint(v)
        v.removeAttribute('src')
        v.load()
      }, { once: true })
      v.src = url
    }
    return null
  }

  private subtitles = new Map<string, HTMLCanvasElement>()

  /** Full-frame canvas of one cue, cached by everything that changes how it looks. */
  private subtitle(track: SubtitleTrack, cue: SubtitleCue, W: number, H: number, k: number): HTMLCanvasElement {
    const kk = Math.max(0.05, Math.min(k, 4096 / W))
    const key = `${cue.text}|${JSON.stringify(track.style)}|${W}x${H}|${kk.toFixed(3)}`
    let hit = this.subtitles.get(key)
    if (!hit) {
      hit = rasterSubtitle(cue.text, track.style, W, H, kk)
      this.subtitles.set(key, hit)
      if (this.subtitles.size > 48) this.subtitles.delete(this.subtitles.keys().next().value!)
    }
    return hit
  }
}

export const player = new Player()

export function usePlayerTime(): number {
  return useSyncExternalStore(player.subscribe, () => player.time)
}

export function usePlaying(): boolean {
  return useSyncExternalStore(player.subscribe, () => player.playing)
}

/** Checks whether Chromium can decode a video's original file; if not, asks for a proxy. */
export function checkPlayable(mediaId: string, url: string): void {
  if (get().playable[mediaId]) return
  const el = document.createElement('video')
  el.muted = true
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'
  let done = false
  const finish = (ok: boolean) => {
    if (done) return
    done = true
    el.removeAttribute('src')
    el.load()
    if (get().playable[mediaId]) return
    set((st) => ({ playable: { ...st.playable, [mediaId]: ok ? 'ok' : 'bad' } }))
    if (!ok) void window.cw.requestProxy(mediaId)
  }
  el.addEventListener('loadeddata', () => finish(el.videoWidth > 0))
  el.addEventListener('error', () => finish(false))
  setTimeout(() => finish(el.readyState >= 2 && el.videoWidth > 0), 8000)
  el.src = url
}

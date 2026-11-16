import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { PEAKS_PER_SECOND } from '@shared/ipc'
import { type Clip, type MediaItem, type Track, clipEnd, isTimed, projectDuration } from '@shared/model'
import { clipCues } from '@shared/subtitles'
import {
  type MoveOrigin, addTrack, moveClips, removeTrack, snapPoints, snapTime, stretchClip, trimClip, withLinked
} from '@shared/timeline-ops'
import { Btn, Icon } from '../components/ui'
import { player } from '../engine/player'
import { addTextAction, addToTimeline, deleteSelectionAction, redo, splitAction, undo, zoomTimeline } from '../state/actions'
import { bindingFor } from '../state/shortcuts'
import { edit, get, set, useStore } from '../state/store'
import { MEDIA_MIME } from './MediaPanel'
import { HEADER_W, LANE_H, RULER_H, tickLabel, tickStep, useImage, usePeaks, view } from './timeline/view'

const SNAP_PX = 8

// ---------------------------------------------------------------- pointer drag helper

function drag(e: React.PointerEvent, onMove: (ev: PointerEvent, dx: number, dy: number) => void, onEnd?: (moved: boolean) => void): void {
  const x0 = e.clientX
  const y0 = e.clientY
  let moved = false
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0
    const dy = ev.clientY - y0
    if (!moved && Math.hypot(dx, dy) < 3) return
    moved = true
    onMove(ev, dx, dy)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    document.body.classList.remove('dragging')
    onEnd?.(moved)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  document.body.classList.add('dragging')
}

let dragSeq = 0

// ---------------------------------------------------------------- clip drawing

/** Cue blocks (with their text) inside a subtitle clip, drawn only for the visible part. */
function SubtitleClipCanvas({ clip, pps, height }: { clip: Clip; pps: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const track = useStore((s) => s.project.subtitles.find((t) => t.id === clip.subtitleTrackId))
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !track) return
    const placed = clipCues(clip, track)
    const draw = () => {
      const clipLeft = clip.start * pps
      const clipW = clip.duration * pps
      const visL = Math.max(0, Math.floor(view.left - HEADER_W - clipLeft - 150))
      const visR = Math.min(clipW, Math.ceil(view.left + view.width - clipLeft + 150))
      if (visR <= visL) {
        canvas.style.display = 'none'
        return
      }
      const w = visR - visL
      const dpr = window.devicePixelRatio || 1
      canvas.style.display = 'block'
      canvas.style.left = `${visL}px`
      canvas.style.width = `${w}px`
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.font = '11px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      const top = 18
      const h = height - top - 4
      for (const p of placed) {
        const x0 = (p.start - clip.start) * pps - visL
        const x1 = (p.end - clip.start) * pps - visL
        if (x1 < 0 || x0 > w) continue
        const bw = Math.max(2, x1 - x0 - 1)
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.fillRect(x0, top, bw, h)
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        ctx.fillRect(x0, top, 1.5, h)
        if (bw > 24) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(x0, top, bw - 3, h)
          ctx.clip()
          ctx.fillStyle = '#fff'
          ctx.fillText(p.cue.text.replace(/\s*\n\s*/g, ' / '), x0 + 5, top + h / 2)
          ctx.restore()
        }
      }
    }
    draw()
    return view.subscribe(draw)
  }, [clip, track, pps, height])
  return <canvas ref={ref} className="clip-canvas" />
}

function ClipCanvas({ clip, media, pps, height }: { clip: Clip; media: MediaItem | undefined; pps: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const cache = useStore((s) => (media ? s.mediaCache[media.id] : undefined))
  const peaks = usePeaks(clip.type === 'audio' ? cache?.peakUrls[clip.audioStream] : undefined)
  const strip = useImage(clip.type === 'video' ? cache?.filmstrip?.url : clip.type === 'image' ? cache?.sourceUrl : undefined)
  const film = cache?.filmstrip

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const clipLeft = clip.start * pps
      const clipW = clip.duration * pps
      const visL = Math.max(0, Math.floor(view.left - HEADER_W - clipLeft - 150))
      const visR = Math.min(clipW, Math.ceil(view.left + view.width - clipLeft + 150))
      if (visR <= visL) {
        canvas.style.display = 'none'
        return
      }
      const w = visR - visL
      const dpr = window.devicePixelRatio || 1
      canvas.style.display = 'block'
      canvas.style.left = `${visL}px`
      canvas.style.width = `${w}px`
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (clip.type === 'audio' && peaks) {
        const mid = canvas.height / 2
        const vol = clip.muted ? 0 : clip.volume
        ctx.fillStyle = 'rgba(255,255,255,0.78)'
        const hot: number[] = []
        for (let x = 0; x < canvas.width; x++) {
          const t0 = clip.srcIn + ((visL + x / dpr) / pps) * clip.speed
          const t1 = clip.srcIn + ((visL + (x + 1) / dpr) / pps) * clip.speed
          const i0 = Math.max(0, Math.floor(t0 * PEAKS_PER_SECOND))
          const i1 = Math.min(peaks.length - 1, Math.max(i0, Math.floor(t1 * PEAKS_PER_SECOND)))
          let peak = 0
          const stride = Math.max(1, Math.floor((i1 - i0) / 64))
          for (let i = i0; i <= i1; i += stride) if (peaks[i] > peak) peak = peaks[i]
          const amp = (peak / 255) * vol
          if (amp > 1) hot.push(x)
          const hgt = Math.max(1, Math.min(1, amp) * (canvas.height - 4))
          ctx.fillRect(x, mid - hgt / 2, 1, hgt)
        }
        // Columns that would clip at the current volume are marked.
        ctx.fillStyle = '#ff5d6c'
        for (const x of hot) ctx.fillRect(x, 0, 1, 2 * dpr)
      } else if (clip.type === 'video' && strip && film && media && media.duration > 0) {
        const tw = (height * film.tileW) / film.tileH
        for (let i = Math.floor(visL / tw); i * tw < visR; i++) {
          const srcT = clip.srcIn + (((i + 0.5) * tw) / pps) * clip.speed
          const frame = Math.min(film.count - 1, Math.max(0, Math.floor((srcT / media.duration) * film.count)))
          ctx.drawImage(strip, frame * film.tileW, 0, film.tileW, film.tileH, (i * tw - visL) * dpr, 0, tw * dpr, canvas.height)
        }
      } else if (clip.type === 'image' && strip) {
        const tw = (height * strip.naturalWidth) / strip.naturalHeight
        for (let i = Math.floor(visL / tw); i * tw < visR; i++) {
          ctx.drawImage(strip, (i * tw - visL) * dpr, 0, tw * dpr, canvas.height)
        }
      }
    }
    draw()
    return view.subscribe(draw)
  }, [clip.start, clip.duration, clip.srcIn, clip.speed, clip.volume, clip.muted, clip.type, pps, height, peaks, strip, film, media])

  return <canvas ref={ref} className="clip-canvas" />
}

interface ClipProps {
  clip: Clip
  media: MediaItem | undefined
  pps: number
  height: number
  selected: boolean
  missing: boolean
  onDown: (e: React.PointerEvent, clip: Clip, zone: 'body' | 'start' | 'end') => void
}

const ClipView = memo(function ClipView({ clip, media, pps, height, selected, missing, onDown }: ClipProps) {
  const timed = isTimed(clip, media)
  const subName = useStore((s) => (clip.type === 'subtitles' ? s.project.subtitles.find((t) => t.id === clip.subtitleTrackId)?.name : undefined))
  const label =
    clip.type === 'text' ? (clip.text?.content.split('\n')[0] ?? 'Text')
      : clip.type === 'subtitles' ? `Subtitles · ${subName ?? clip.name}`
        : clip.name || media?.name || ''
  const fx = clip.effects.filter((e) => e.enabled).length
  const speedPct = Math.round(clip.speed * 100)
  return (
    <div
      className={`clip clip-${clip.type}${selected ? ' selected' : ''}${missing ? ' missing' : ''}${clip.muted ? ' muted' : ''}`}
      style={{ left: clip.start * pps, width: Math.max(2, clip.duration * pps), height }}
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-type={clip.type}
      onPointerDown={(e) => e.button === 0 && onDown(e, clip, 'body')}
    >
      {clip.type === 'subtitles' && <SubtitleClipCanvas clip={clip} pps={pps} height={height} />}
      {clip.type !== 'text' && clip.type !== 'subtitles' && !missing && <ClipCanvas clip={clip} media={media} pps={pps} height={height} />}
      <div className="clip-label">
        {clip.linkId && <Icon name="link" size={11} />}
        <span className="clip-name">{label}</span>
        {timed && speedPct !== 100 && <span className="clip-badge speed" data-testid="clip-speed">{speedPct}%</span>}
        {clip.type === 'audio' && Math.abs(clip.volume - 1) > 0.005 && <span className="clip-badge">{Math.round(clip.volume * 100)}%</span>}
        {fx > 0 && <span className="clip-badge fx">fx {fx}</span>}
      </div>
      <div className="clip-edge start" data-testid="clip-edge-start" title="Drag to change speed · Alt+drag to trim"
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onDown(e, clip, 'start') } }} />
      <div className="clip-edge end" data-testid="clip-edge-end" title="Drag to change speed · Alt+drag to trim"
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onDown(e, clip, 'end') } }} />
    </div>
  )
})

// ---------------------------------------------------------------- ruler

function Ruler({ pps, onDown }: { pps: number; onDown: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, view.width)
      canvas.style.left = `${view.left}px`
      canvas.style.width = `${w}px`
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(RULER_H * dpr)
      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, RULER_H)
      const step = tickStep(pps)
      const minor = step / 5
      const t0 = Math.max(0, Math.floor((view.left - HEADER_W) / pps / minor) * minor)
      const t1 = (view.left + w) / pps
      ctx.font = '11px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'top'
      for (let i = Math.round(t0 / minor); i * minor <= t1; i++) {
        const t = i * minor
        const x = Math.round(t * pps - view.left) + 0.5
        const major = i % 5 === 0
        ctx.strokeStyle = major ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.14)'
        ctx.beginPath()
        ctx.moveTo(x, major ? 12 : 19)
        ctx.lineTo(x, RULER_H)
        ctx.stroke()
        if (major) {
          ctx.fillStyle = 'rgba(230,232,238,0.72)'
          ctx.fillText(tickLabel(t, step), x + 4, 3)
        }
      }
    }
    draw()
    return view.subscribe(draw)
  }, [pps])
  return (
    <div className="tl-ruler" onPointerDown={onDown} data-testid="ruler">
      <canvas ref={ref} />
    </div>
  )
}

// ---------------------------------------------------------------- panel

export function TimelinePanel() {
  const tracks = useStore((s) => s.project.tracks)
  const clips = useStore((s) => s.project.clips)
  const media = useStore((s) => s.project.media)
  const mediaCache = useStore((s) => s.mediaCache)
  const pps = useStore((s) => s.pps)
  const snapping = useStore((s) => s.snapping)
  const selection = useStore((s) => s.selection)
  const canUndo = useStore((s) => s.undo.length > 0)
  const canRedo = useStore((s) => s.redo.length > 0)
  const duration = useStore((s) => projectDuration(s.project))
  const scrollRef = useRef<HTMLDivElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<{ time: number; offset: number } | null>(null)
  const ppsRef = useRef(pps)
  ppsRef.current = pps

  const timeAt = useCallback((clientX: number): number => {
    const sc = scrollRef.current!
    const r = sc.getBoundingClientRect()
    return (clientX - r.left + sc.scrollLeft - HEADER_W) / ppsRef.current
  }, [])

  /** Snaps to clip edges and the playhead, then to whole frames. */
  const snap = useCallback((t: number, ignore?: Set<string>, usePlayhead = true): number => {
    const s = get()
    const fps = s.project.settings.fps || 30
    if (s.snapping) {
      const pts = snapPoints(s.project, ignore)
      if (usePlayhead) pts.push(player.time)
      const snapped = snapTime(t, pts, SNAP_PX / ppsRef.current)
      if (snapped !== t) return snapped
    }
    return Math.max(0, Math.round(t * fps) / fps)
  }, [])

  // Keep the shared view window in sync with the scroller.
  useLayoutEffect(() => {
    const sc = scrollRef.current!
    const sync = () => view.set(sc.scrollLeft, sc.clientWidth)
    sync()
    sc.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(sc)
    return () => {
      sc.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [])

  // Zooming keeps the time under the pointer in place.
  useLayoutEffect(() => {
    const sc = scrollRef.current!
    const a = zoomAnchor.current
    if (a) {
      sc.scrollLeft = Math.max(0, a.time * pps + HEADER_W - a.offset)
      zoomAnchor.current = null
    }
    view.set(sc.scrollLeft, sc.clientWidth)
  }, [pps])

  // The playhead moves without re-rendering React; during playback the view follows it.
  useEffect(() => {
    const update = () => {
      const el = playheadRef.current
      const sc = scrollRef.current
      if (!el || !sc) return
      const x = HEADER_W + player.time * ppsRef.current
      el.style.transform = `translateX(${x}px)`
      if (player.playing) {
        const right = sc.scrollLeft + sc.clientWidth
        if (x > right - 30 || x < sc.scrollLeft + HEADER_W) sc.scrollLeft = Math.max(0, x - HEADER_W - 60)
      }
    }
    update()
    return player.subscribe(update)
  }, [pps])

  // Ctrl+wheel zooms; a plain wheel scrolls sideways when there is nothing to scroll vertically.
  useEffect(() => {
    const sc = scrollRef.current!
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const r = sc.getBoundingClientRect()
        zoomAnchor.current = { time: Math.max(0, timeAt(e.clientX)), offset: e.clientX - r.left }
        zoomTimeline(e.deltaY < 0 ? 1.18 : 1 / 1.18)
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && sc.scrollHeight <= sc.clientHeight + 1) {
        e.preventDefault()
        sc.scrollLeft += e.deltaY
      }
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [timeAt])

  const scrub = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const fps = get().project.settings.fps || 30
    const go = (x: number) => player.seek(Math.max(0, Math.round(timeAt(x) * fps) / fps))
    player.pause()
    go(e.clientX)
    drag(e, (ev) => go(ev.clientX))
  }, [timeAt])

  const onClipDown = useCallback((e: React.PointerEvent, clip: Clip, zone: 'body' | 'start' | 'end') => {
    const s = get()
    const key = `drag${++dragSeq}`

    if (zone !== 'body') {
      // Edge drag: rate-stretch by default, classic trim with Alt.
      const group = new Set(withLinked(s.project, [clip.id]))
      if (!s.selection.includes(clip.id)) set({ selection: [...group] })
      const trim = e.altKey
      drag(e, (ev) => {
        const t = snap(timeAt(ev.clientX), group)
        edit((p) => {
          if (trim) trimClip(p, clip.id, zone, t)
          else stretchClip(p, clip.id, zone, t)
        }, { key, sticky: true })
      })
      return
    }

    const multi = e.ctrlKey || e.metaKey || e.shiftKey
    const own = e.altKey ? [clip.id] : withLinked(s.project, [clip.id])
    let selection = s.selection
    if (multi) {
      const has = selection.includes(clip.id)
      selection = has ? selection.filter((id) => !own.includes(id)) : [...new Set([...selection, ...own])]
      set({ selection })
      return
    }
    const wasSelected = selection.includes(clip.id)
    if (!wasSelected || e.altKey) {
      selection = own
      set({ selection })
    }
    const origin: MoveOrigin = {}
    for (const c of s.project.clips) if (selection.includes(c.id)) origin[c.id] = { start: c.start, trackId: c.trackId }
    const moving = new Set(Object.keys(origin))
    const grabStart = clip.start
    const grabEnd = clipEnd(clip)
    drag(
      e,
      (ev, dx) => {
        let dt = dx / ppsRef.current
        const st = get()
        if (st.snapping) {
          const pts = snapPoints(st.project, moving)
          pts.push(player.time)
          const tol = SNAP_PX / ppsRef.current
          const a = snapTime(grabStart + dt, pts, tol)
          const b = snapTime(grabEnd + dt, pts, tol)
          if (a !== grabStart + dt) dt = a - grabStart
          else if (b !== grabEnd + dt) dt = b - grabEnd
        }
        const lane = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-track-id]')
        const trackId = lane?.dataset.trackId
        edit((p) => {
          const retarget = trackId ? { clipId: clip.id, trackId } : undefined
          if (!moveClips(p, origin, dt, retarget) && retarget) moveClips(p, origin, dt)
        }, { key, sticky: true })
      },
      (moved) => {
        // A plain click on one clip of a multi-selection narrows the selection to it.
        if (!moved && wasSelected && get().selection.length > own.length) set({ selection: own })
      }
    )
  }, [snap, timeAt])

  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(MEDIA_MIME)
    if (!raw) return
    e.preventDefault()
    const { mediaId, audioStream } = JSON.parse(raw) as { mediaId: string; audioStream?: number }
    const lane = (e.target as HTMLElement).closest<HTMLElement>('[data-track-id]')
    addToTimeline(mediaId, snap(Math.max(0, timeAt(e.clientX)), undefined, true), lane?.dataset.trackId, audioStream)
  }

  const fit = () => {
    const sc = scrollRef.current!
    if (duration <= 0) return
    set({ pps: Math.min(800, Math.max(2, (sc.clientWidth - HEADER_W - 48) / duration)) })
    sc.scrollLeft = 0
  }

  const selected = new Set(selection)
  const mediaMap = new Map(media.map((m) => [m.id, m]))
  const contentWidth = HEADER_W + Math.max(duration + 20, 60) * pps + 400

  return (
    <div className="panel timeline-panel" data-panel="timeline">
      <div className="panel-toolbar">
        <Btn icon="scissors" title={`Split at playhead (${bindingFor('timeline.split')})`} onClick={splitAction} testId="split">Split</Btn>
        <span className="toolbar-sep" />
        <Btn icon="undo" title={`Undo (${bindingFor('edit.undo')})`} onClick={undo} disabled={!canUndo} testId="undo" />
        <Btn icon="redo" title={`Redo (${bindingFor('edit.redo')})`} onClick={redo} disabled={!canRedo} testId="redo" />
        <Btn icon="trash" title={`Delete selected (${bindingFor('edit.delete')})`} onClick={deleteSelectionAction} disabled={!selection.length} />
        <span className="toolbar-sep" />
        <Btn icon="magnet" title={`Snapping (${bindingFor('timeline.snap')})`} active={snapping} onClick={() => set({ snapping: !snapping })} />
        <Btn icon="text" title={`Add text at playhead (${bindingFor('timeline.addText')})`} onClick={() => addTextAction()} />
        <span className="toolbar-hint">Drag a clip's edge to change its speed · Alt+drag to trim</span>
        <span className="toolbar-spacer" />
        <Btn small icon="plus" title="Add video track" onClick={() => edit((p) => { addTrack(p, 'video') })}>Video</Btn>
        <Btn small icon="plus" title="Add audio track" onClick={() => edit((p) => { addTrack(p, 'audio') })}>Audio</Btn>
        <span className="toolbar-sep" />
        <Btn icon="minus" title="Zoom out" onClick={() => zoomTimeline(1 / 1.4)} />
        <input
          type="range" className="slider zoom-slider" min={Math.log(2)} max={Math.log(800)} step={0.01} value={Math.log(pps)}
          style={{ '--fill': `${((Math.log(pps) - Math.log(2)) / (Math.log(800) - Math.log(2))) * 100}%` } as React.CSSProperties}
          onChange={(e) => set({ pps: Math.exp(Number(e.target.value)) })} title="Timeline zoom (Ctrl+wheel)"
        />
        <Btn icon="plus" title="Zoom in" onClick={() => zoomTimeline(1.4)} />
        <Btn icon="fit" title="Fit timeline to window" onClick={fit} />
      </div>
      <div
        className="tl-scroll"
        ref={scrollRef}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MEDIA_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onDrop}
      >
        <div className="tl-content" style={{ width: contentWidth }}>
          <div className="tl-row tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-header tl-corner" style={{ width: HEADER_W }} />
            <Ruler pps={pps} onDown={scrub} />
          </div>
          {tracks.map((t) => (
            <TrackRow key={t.id} track={t} height={LANE_H[t.kind]} empty={!clips.some((c) => c.trackId === t.id)} onLaneDown={(e) => {
              if (e.target !== e.currentTarget) return
              set({ selection: [] })
              scrub(e)
            }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => (
                <ClipView
                  key={c.id}
                  clip={c}
                  media={c.mediaId ? mediaMap.get(c.mediaId) : undefined}
                  pps={pps}
                  height={LANE_H[t.kind] - 6}
                  selected={selected.has(c.id)}
                  missing={!!(c.mediaId && mediaCache[c.mediaId]?.missing)}
                  onDown={onClipDown}
                />
              ))}
            </TrackRow>
          ))}
          <div className="tl-playhead" ref={playheadRef} data-testid="playhead"><span /></div>
        </div>
      </div>
    </div>
  )
}

function TrackRow({ track, height, empty, children, onLaneDown }: {
  track: Track
  height: number
  empty: boolean
  children: React.ReactNode
  onLaneDown: (e: React.PointerEvent) => void
}) {
  const count = useStore((s) => s.project.tracks.filter((t) => t.kind === track.kind).length)
  const off = track.kind === 'video' ? track.hidden : track.muted
  const toggle = () =>
    edit((p) => {
      const t = p.tracks.find((x) => x.id === track.id)
      if (!t) return
      if (t.kind === 'video') t.hidden = !t.hidden
      else t.muted = !t.muted
    })
  return (
    <div className={`tl-row tl-track tl-${track.kind}${off ? ' off' : ''}`} style={{ height }}>
      <div className="tl-header" style={{ width: HEADER_W }}>
        <Icon name={track.kind === 'video' ? 'film' : 'music'} size={13} />
        <span className="tl-track-name">{track.name}</span>
        {empty && count > 1 && (
          <Btn small icon="close" title="Remove empty track" onClick={() => edit((p) => { removeTrack(p, track.id) })} />
        )}
        <Btn small icon={track.kind === 'video' ? (off ? 'eyeOff' : 'eye') : off ? 'mute' : 'volume'}
          title={track.kind === 'video' ? (off ? 'Show track' : 'Hide track') : off ? 'Unmute track' : 'Mute track'}
          active={off} onClick={toggle} />
      </div>
      <div className="tl-lane" data-track-id={track.id} data-track-kind={track.kind} data-testid="lane" onPointerDown={onLaneDown}>
        {children}
      </div>
    </div>
  )
}

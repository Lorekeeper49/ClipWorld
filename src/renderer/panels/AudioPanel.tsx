import { useEffect, useMemo, useRef } from 'react'
import { type Clip, MAX_VOLUME } from '@shared/model'
import { groupOf } from '@shared/timeline-ops'
import { Btn, Icon, Num } from '../components/ui'
import { player } from '../engine/player'
import { edit, primaryClip, useStore } from '../state/store'

/** Level meter driven outside React, straight from the audio graph. */
function Meter({ clipId }: { clipId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    let shown = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const level = player.level(clipId)
      shown = level > shown ? level : shown * 0.9
      const el = ref.current
      if (!el) return
      // -48 dB .. +6 dB mapped onto the bar.
      const db = shown > 0.00001 ? 20 * Math.log10(shown) : -100
      const frac = Math.min(1, Math.max(0, (db + 48) / 54))
      el.style.width = `${frac * 100}%`
      el.classList.toggle('hot', shown > 1)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clipId])
  return <div className="meter" title="Output level"><div className="meter-fill" ref={ref} /><span className="meter-zero" /></div>
}

function TrackRow({ clip, trackName }: { clip: Clip; trackName: string }) {
  const setVolume = (v: number) =>
    edit((p) => {
      const c = p.clips.find((x) => x.id === clip.id)
      if (c) c.volume = Math.min(MAX_VOLUME, Math.max(0, v))
    }, { key: `${clip.id}:volume` })
  const toggleMute = () =>
    edit((p) => {
      const c = p.clips.find((x) => x.id === clip.id)
      if (c) c.muted = !c.muted
    })
  const pct = (clip.volume / MAX_VOLUME) * 100
  return (
    <div className={`audio-row${clip.muted ? ' muted' : ''}`} data-testid="audio-row" data-clip-id={clip.id}>
      <div className="audio-row-head">
        <Btn small icon={clip.muted ? 'mute' : 'volume'} active={clip.muted} title={clip.muted ? 'Unmute' : 'Mute'} onClick={toggleMute} />
        <span className="audio-name" title={clip.name}>{clip.name || 'Audio'}</span>
        <span className="audio-track-tag">{trackName}</span>
      </div>
      <div className="audio-row-body">
        <span className="slider-wrap">
          <input
            type="range" className="slider" min={0} max={MAX_VOLUME} step={0.01} value={clip.volume}
            data-testid="volume-slider"
            style={{ '--fill': `${pct}%` } as React.CSSProperties}
            onChange={(e) => setVolume(Number(e.target.value))}
            onDoubleClick={() => setVolume(1)}
            title="0% to 500% — double-click to reset to 100%"
          />
          <span className="slider-mark" style={{ left: `${(1 / MAX_VOLUME) * 100}%` }} />
        </span>
        <Num value={clip.volume} min={0} max={MAX_VOLUME} step={0.01} display={100} unit="%" width={70} testId="volume-input" onChange={setVolume} />
      </div>
      <Meter clipId={clip.id} />
    </div>
  )
}

export function AudioPanel() {
  const clip = useStore(primaryClip)
  const project = useStore((s) => s.project)
  const rows = useMemo(() => {
    if (!clip) return []
    const order = new Map(project.tracks.map((t, i) => [t.id, i]))
    return groupOf(project, clip)
      .filter((c) => c.type === 'audio')
      .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
  }, [clip, project])
  const trackName = (id: string) => project.tracks.find((t) => t.id === id)?.name ?? ''

  return (
    <div className="panel audio-panel scroll" data-panel="audio">
      {!clip ? (
        <div className="empty small">
          <Icon name="music" size={22} />
          <p className="dim">Select a video on the timeline to see and mix its audio tracks.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty small">
          <Icon name="mute" size={22} />
          <p className="dim">The selected clip has no audio tracks.</p>
        </div>
      ) : (
        <>
          <div className="audio-title">
            <span>{rows.length} audio track{rows.length === 1 ? '' : 's'}</span>
            <span className="dim">100% is the original level</span>
          </div>
          {rows.map((c) => <TrackRow key={c.id} clip={c} trackName={trackName(c.trackId)} />)}
        </>
      )}
    </div>
  )
}

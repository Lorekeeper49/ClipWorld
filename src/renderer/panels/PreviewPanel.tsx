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

import { useEffect, useRef } from 'react'
import { projectDuration } from '@shared/model'
import { Btn, Icon, formatTime } from '../components/ui'
import { player, usePlayerTime, usePlaying } from '../engine/player'
import { useT } from '../i18n'
import { patchSettings, useStore } from '../state/store'

function Timecode() {
  const t = usePlayerTime()
  const fps = useStore((s) => s.project.settings.fps)
  const total = useStore((s) => projectDuration(s.project))
  return (
    <span className="timecode" data-testid="timecode">
      {formatTime(t, fps)} <span className="dim">/ {formatTime(total, fps)}</span>
    </span>
  )
}

export function PreviewPanel() {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const width = useStore((s) => s.project.settings.width)
  const height = useStore((s) => s.project.settings.height)
  const volume = useStore((s) => s.settings.previewVolume)
  const playing = usePlaying()
  const t = useT()

  // The canvas always fits the video frame inside the panel — nothing else is drawn or zoomable.
  useEffect(() => {
    const stage = stageRef.current!
    const canvas = canvasRef.current!
    player.attach(canvas)
    const layout = () => {
      const availW = Math.max(16, stage.clientWidth - 16)
      const availH = Math.max(16, stage.clientHeight - 16)
      const scale = Math.min(availW / width, availH / height)
      const cssW = Math.max(1, Math.floor(width * scale))
      const cssH = Math.max(1, Math.floor(height * scale))
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      const dpr = window.devicePixelRatio || 1
      const k = Math.min(1, (cssW * dpr) / width)
      const w = Math.max(2, Math.round(width * k))
      const h = Math.max(2, Math.round(height * k))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      player.invalidate()
    }
    layout()
    const ro = new ResizeObserver(layout)
    ro.observe(stage)
    return () => {
      ro.disconnect()
      player.detach(canvas)
    }
  }, [width, height])

  return (
    <div className="panel preview-panel">
      <div className="preview-stage" ref={stageRef} onClick={() => player.toggle()}>
        <canvas ref={canvasRef} data-testid="preview-canvas" />
      </div>
      <div className="transport">
        <Timecode />
        <div className="transport-buttons">
          <Btn icon="start" title={t('actions.play.start')} onClick={() => player.seek(0)} />
          <Btn icon="prev" title={t('actions.play.prevFrame')} onClick={() => player.step(-1)} />
          <Btn icon={playing ? 'pause' : 'play'} title={playing ? t('preview.pause') : t('preview.play')} primary onClick={() => player.toggle()} testId="play" />
          <Btn icon="next" title={t('actions.play.nextFrame')} onClick={() => player.step(1)} />
          <Btn icon="end" title={t('actions.play.end')} onClick={() => player.seek(Infinity)} />
        </div>
        <label className="preview-volume" title={t('preview.volumeHint')}>
          <button type="button" className="btn btn-icon" aria-label={t('preview.mute')}
            onClick={() => patchSettings({ previewVolume: volume > 0 ? 0 : 1 })}>
            <Icon name={volume > 0 ? 'volume' : 'mute'} />
          </button>
          <input
            type="range" className="slider" min={0} max={1} step={0.01} value={volume}
            data-testid="preview-volume"
            style={{ '--fill': `${volume * 100}%` } as React.CSSProperties}
            onChange={(e) => patchSettings({ previewVolume: Number(e.target.value) })}
          />
          <span className="preview-volume-value">{Math.round(volume * 100)}%</span>
        </label>
      </div>
    </div>
  )
}

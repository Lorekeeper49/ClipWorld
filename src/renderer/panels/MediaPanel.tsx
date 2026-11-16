import { useState } from 'react'
import type { MediaItem } from '@shared/model'
import { Btn, Icon, formatDuration } from '../components/ui'
import { addToTimeline, deleteMediaAction, importMediaAction, importPaths, relinkMediaAction } from '../state/actions'
import { set, useStore } from '../state/store'

export const MEDIA_MIME = 'application/x-clipworld-media'

function Thumb({ m }: { m: MediaItem }) {
  const cache = useStore((s) => s.mediaCache[m.id])
  if (cache?.missing) return <div className="media-thumb missing"><Icon name="warn" size={22} /></div>
  if (m.kind === 'audio') return <div className="media-thumb audio"><Icon name="music" size={22} /></div>
  const url = cache?.posterUrl
  return (
    <div className="media-thumb">
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name={m.kind === 'image' ? 'image' : 'film'} size={22} />}
    </div>
  )
}

function MediaRow({ m }: { m: MediaItem }) {
  const selected = useStore((s) => s.selectedMediaId === m.id)
  const cache = useStore((s) => s.mediaCache[m.id])
  const uses = useStore((s) => s.project.clips.reduce((n, c) => n + (c.mediaId === m.id ? 1 : 0), 0))
  const [open, setOpen] = useState(true)
  const audioReady = m.audioStreams.filter((a) => cache?.audioUrls[a.index]).length
  const hasTracks = m.kind === 'video' && m.audioStreams.length > 0

  const ch = cache?.chunks
  let status: string | null = null
  if (cache?.missing) status = 'File not found'
  else if (cache?.proxyState === 'pending') status = `Building preview ${Math.round((cache.proxyProgress ?? 0) * 100)}%`
  else if (cache?.proxyState === 'error' || ch?.failed) status = 'Preview unavailable (export still works)'
  else if (m.audioStreams.length && audioReady < m.audioStreams.length) {
    status = `Extracting audio ${Math.round((cache?.audioProgress ?? 0) * 100)}%`
  } else if (ch && ch.done.length < ch.count) {
    status = `Optimizing for fast seeking ${Math.floor((ch.done.length / ch.count) * 100)}%`
  }

  const meta: string[] = []
  if (m.kind !== 'audio') meta.push(`${m.width}×${m.height}`)
  if (m.kind === 'video') meta.push(`${Number(m.fps.toFixed(2))} fps`)
  if (m.duration > 0) meta.push(formatDuration(m.duration))

  return (
    <li className={`media-item${selected ? ' selected' : ''}`} data-testid="media-item" data-media-id={m.id}>
      <div
        className="media-main"
        draggable={!cache?.missing}
        onDragStart={(e) => {
          e.dataTransfer.setData(MEDIA_MIME, JSON.stringify({ mediaId: m.id }))
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={() => set({ selectedMediaId: m.id })}
        onDoubleClick={() => !cache?.missing && addToTimeline(m.id)}
        title={`${m.path}\nDrag to the timeline, or double-click to add at the playhead`}
      >
        <Thumb m={m} />
        <div className="media-info">
          <div className="media-name">{m.name}</div>
          <div className="media-meta">{meta.join(' · ')}</div>
          {status && (
            <div className={`media-status${cache?.missing || cache?.proxyState === 'error' || ch?.failed ? ' bad' : ''}`}
              data-testid="media-status"
              title={ch && !ch.failed && ch.done.length < ch.count
                ? 'Building a seek-friendly preview copy in the background, starting where you are working. Playback and export use the original meanwhile.'
                : undefined}>
              {status}
            </div>
          )}
          {uses > 0 && !status && <div className="media-meta">Used {uses}×</div>}
        </div>
        <div className="media-actions">
          {cache?.missing ? (
            <Btn small icon="folder" title="Locate file…" onClick={(e) => { e.stopPropagation(); void relinkMediaAction(m.id) }} />
          ) : (
            <Btn small icon="plus" title="Add to timeline at playhead" testId="media-add" onClick={(e) => { e.stopPropagation(); addToTimeline(m.id) }} />
          )}
          <Btn small icon="trash" title="Delete from project (removes its clips from the timeline)" testId="media-delete"
            onClick={(e) => { e.stopPropagation(); deleteMediaAction(m.id) }} />
        </div>
      </div>
      {hasTracks && (
        <div className="media-tracks">
          <button type="button" className="media-tracks-head" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'down' : 'right'} size={12} />
            {m.audioStreams.length} audio track{m.audioStreams.length === 1 ? '' : 's'}
          </button>
          {open && m.audioStreams.map((a) => (
            <div
              key={a.index}
              className={`media-track${cache?.audioUrls[a.index] ? '' : ' pending'}`}
              data-testid="media-audio-track"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(MEDIA_MIME, JSON.stringify({ mediaId: m.id, audioStream: a.index }))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => addToTimeline(m.id, undefined, undefined, a.index)}
              title="Drag to the timeline to use this audio track on its own"
            >
              <Icon name="music" size={12} />
              <span className="media-track-name">{a.title}</span>
              <span className="media-track-meta">{a.codec} · {a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

export function MediaPanel() {
  const media = useStore((s) => s.project.media)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`panel media-panel${over ? ' drop-over' : ''}`}
      data-panel="media"
      tabIndex={-1}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const paths = [...e.dataTransfer.files].map((f) => window.cw.pathForFile(f)).filter(Boolean)
        void importPaths(paths)
      }}
    >
      <div className="panel-toolbar">
        <Btn icon="upload" primary onClick={() => void importMediaAction()} testId="import-media">Import</Btn>
        <span className="toolbar-hint">{media.length ? `${media.length} item${media.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {media.length === 0 ? (
        <div className="empty">
          <Icon name="upload" size={28} />
          <p>Import video, audio or images</p>
          <p className="dim">Drop files here or use Import. A video's audio tracks are extracted automatically.</p>
        </div>
      ) : (
        <ul className="media-list">
          {media.map((m) => <MediaRow key={m.id} m={m} />)}
        </ul>
      )}
    </div>
  )
}

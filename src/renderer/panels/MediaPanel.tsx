import { useState } from 'react'
import type { MediaItem } from '@shared/model'
import { Btn, Icon, formatDuration } from '../components/ui'
import {
  addToTimeline, convertToMp4Action, deleteMediaAction, importMediaAction, importPaths, relinkMediaAction, setFastSeekAction
} from '../state/actions'
import { useT } from '../i18n'
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
  const t = useT()
  const selected = useStore((s) => s.selectedMediaId === m.id)
  const cache = useStore((s) => s.mediaCache[m.id])
  const uses = useStore((s) => s.project.clips.reduce((n, c) => n + (c.mediaId === m.id ? 1 : 0), 0))
  const [open, setOpen] = useState(true)
  const audioReady = m.audioStreams.filter((a) => cache?.audioUrls[a.index]).length
  const hasTracks = m.kind === 'video' && m.audioStreams.length > 0

  const ch = cache?.chunks
  const converting = cache?.convertProgress !== undefined
  const canConvert = m.kind === 'video' && !/\.(mp4|m4v)$/i.test(m.path) && !cache?.missing && !converting
  let status: string | null = null
  if (cache?.missing) status = t('media.status.missing')
  else if (converting) status = t('media.status.converting', { percent: Math.floor((cache!.convertProgress ?? 0) * 100) })
  else if (cache?.proxyState === 'pending') status = t('media.status.buildingPreview', { percent: Math.round((cache.proxyProgress ?? 0) * 100) })
  else if (cache?.proxyState === 'error' || ch?.failed) status = t('media.status.previewUnavailable')
  else if (m.audioStreams.length && audioReady < m.audioStreams.length) {
    status = t('media.status.extractingAudio', { percent: Math.round((cache?.audioProgress ?? 0) * 100) })
  } else if (ch && ch.done.length < ch.count) {
    status = t('media.status.optimizing', { percent: Math.floor((ch.done.length / ch.count) * 100) })
  } else if (m.fastSeek && ch) {
    status = t('media.status.optimized')
  }
  const fastSeekDone = !!ch && ch.done.length >= ch.count
  // Videos the preview cannot decode always get the copy; the button is for the user's own choice.
  const canFastSeek = m.kind === 'video' && !cache?.missing && !converting && !ch?.required

  const meta: string[] = []
  if (m.kind !== 'audio') meta.push(`${m.width}×${m.height}`)
  if (m.kind === 'video') meta.push(t('common.fps', { fps: Number(m.fps.toFixed(2)) }))
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
        title={`${m.path}\n${t('media.dragHint')}`}
      >
        <Thumb m={m} />
        <div className="media-info">
          <div className="media-name">{m.name}</div>
          <div className="media-meta">{meta.join(' · ')}</div>
          {status && (
            <div className={`media-status${cache?.missing || cache?.proxyState === 'error' || ch?.failed ? ' bad' : ''}`}
              data-testid="media-status"
              title={ch && !ch.failed && ch.done.length < ch.count
                ? t('media.optimizingHint')
                : undefined}>
              {status}
            </div>
          )}
          {uses > 0 && !status && <div className="media-meta">{t('media.used', { count: uses })}</div>}
          <div className="media-buttons">
            {canConvert && (
              <button type="button" className="media-convert" data-testid="convert-mp4"
                title={t('media.convertHint', { name: m.name })}
                onClick={(e) => { e.stopPropagation(); void convertToMp4Action(m.id) }}>
                {t('media.convert')}
              </button>
            )}
            {converting && (
              <button type="button" className="media-convert" data-testid="convert-cancel"
                onClick={(e) => { e.stopPropagation(); void window.cw.cancelConvert(m.id) }}>
                {t('common.cancel')}
              </button>
            )}
            {canFastSeek && (
              <button type="button" className="media-convert" data-testid={m.fastSeek ? 'fast-seek-off' : 'fast-seek-on'}
                title={m.fastSeek
                  ? (fastSeekDone
                    ? t('media.fastSeekOffHint')
                    : t('media.fastSeekStopHint'))
                  : t('media.fastSeekHint')}
                onClick={(e) => { e.stopPropagation(); setFastSeekAction(m.id, !m.fastSeek) }}>
                {m.fastSeek ? (fastSeekDone ? t('media.fastSeekOff') : t('media.fastSeekStop')) : t('media.fastSeekOn')}
              </button>
            )}
          </div>
        </div>
        <div className="media-actions">
          {cache?.missing ? (
            <Btn small icon="folder" title={t('media.locate')} onClick={(e) => { e.stopPropagation(); void relinkMediaAction(m.id) }} />
          ) : (
            <Btn small icon="plus" title={t('media.add')} testId="media-add" onClick={(e) => { e.stopPropagation(); addToTimeline(m.id) }} />
          )}
          <Btn small icon="trash" title={t('media.delete')} testId="media-delete"
            onClick={(e) => { e.stopPropagation(); deleteMediaAction(m.id) }} />
        </div>
      </div>
      {hasTracks && (
        <div className="media-tracks">
          <button type="button" className="media-tracks-head" onClick={() => setOpen(!open)}>
            <Icon name={open ? 'down' : 'right'} size={12} />
            {t('common.audioTracks', { count: m.audioStreams.length })}
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
              title={t('media.trackHint')}
            >
              <Icon name="music" size={12} />
              <span className="media-track-name">{a.title}</span>
              <span className="media-track-meta">{a.codec} · {a.channels === 1 ? t('media.mono') : a.channels === 2 ? t('media.stereo') : t('media.channels', { count: a.channels })}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

export function MediaPanel() {
  const t = useT()
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
        <Btn icon="upload" primary onClick={() => void importMediaAction()} testId="import-media">{t('media.import')}</Btn>
        <span className="toolbar-hint">{media.length ? t('media.items', { count: media.length }) : ''}</span>
      </div>
      {media.length === 0 ? (
        <div className="empty">
          <Icon name="upload" size={28} />
          <p>{t('media.emptyTitle')}</p>
          <p className="dim">{t('media.emptyHint')}</p>
        </div>
      ) : (
        <ul className="media-list">
          {media.map((m) => <MediaRow key={m.id} m={m} />)}
        </ul>
      )}
      <p className="media-tip" data-testid="media-tip">
        <Icon name="info" size={13} />
        {t('media.mp4Tip')}
      </p>
    </div>
  )
}

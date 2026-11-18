import { useEffect, useMemo, useState } from 'react'
import {
  AUDIO_CODECS, CONTAINERS, CONTAINER_MAP, type ExportSettings, VIDEO_CODECS, defaultExportSettings, normalizeExportSettings
} from '@shared/formats'
import type { ExportResult } from '@shared/ipc'
import { projectDuration } from '@shared/model'
import { Btn, Field, Modal, Num, Select, Slider, formatDuration } from '../components/ui'
import { audioCodecName, containerName, encoderName, videoCodecName } from '@shared/labels'
import { useT } from '../i18n'
import { runExportAction } from '../state/actions'
import { set, useStore } from '../state/store'

/** Quality bands; names are messages export.qualities.<name>. */
const QUALITY_NAMES: [number, string][] = [[25, 'draft'], [50, 'good'], [75, 'high'], [90, 'veryHigh'], [101, 'maximum']]

export function ExportDialog() {
  const t = useT()
  const caps = useStore((s) => s.caps)
  const saved = useStore((s) => s.settings.exportSettings)
  const project = useStore((s) => s.project)
  const [settings, setSettings] = useState<ExportSettings>(() => normalizeExportSettings(saved ?? defaultExportSettings(), caps.encoders))
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [started, setStarted] = useState(0)

  useEffect(() => window.cw.onExportProgress(setProgress), [])

  const update = (patch: Partial<ExportSettings>) => setSettings((s) => normalizeExportSettings({ ...s, ...patch }, caps.encoders))
  const container = CONTAINER_MAP[settings.container]
  const hasVideo = container.video.length > 0
  const hasAudio = container.audio.length > 0
  const duration = projectDuration(project)
  const audioTracks = useMemo(
    () => new Set(project.clips.filter((c) => c.type === 'audio').map((c) => c.trackId)).size,
    [project.clips]
  )

  const videoCodecs = container.video
    .filter((v) => VIDEO_CODECS[v].encoders.some((e) => caps.encoders.includes(e.id)))
    .map((v) => ({ value: v, label: videoCodecName(v) }))
  const encoders = hasVideo
    ? VIDEO_CODECS[settings.videoCodec].encoders.filter((e) => caps.encoders.includes(e.id)).map((e) => ({ value: e.id, label: encoderName(e.id) }))
    : []
  const audioCodecs = container.audio
    .filter((a) => caps.encoders.includes(AUDIO_CODECS[a].encoder))
    .map((a) => ({ value: a, label: audioCodecName(a) }))
  const lossless = AUDIO_CODECS[settings.audioCodec]?.lossless
  const qualityName = t(`export.qualities.${QUALITY_NAMES.find(([limit]) => settings.quality < limit)?.[1] ?? 'maximum'}`)

  const start = async () => {
    setProgress(0)
    setResult(null)
    setPhase('running')
    setStarted(Date.now())
    const r = await runExportAction(settings)
    if (!r) {
      setPhase('idle')
      return
    }
    setResult(r)
    setPhase('done')
  }

  const close = () => {
    if (phase === 'running') return
    set({ modal: null })
  }

  const elapsed = (Date.now() - started) / 1000
  const eta = progress > 0.02 ? (elapsed / progress) * (1 - progress) : 0

  return (
    <Modal
      title={t('export.title')}
      onClose={phase === 'running' ? undefined : close}
      width={540}
      footer={
        phase === 'running' ? (
          <Btn danger onClick={() => void window.cw.cancelExport()} testId="export-cancel">{t('export.cancel')}</Btn>
        ) : phase === 'done' ? (
          <>
            {result?.ok && <Btn icon="folder" onClick={() => void window.cw.showInFolder(result.outPath)}>{t('export.showInFolder')}</Btn>}
            <Btn onClick={() => { setPhase('idle'); setResult(null) }}>{t('export.again')}</Btn>
            <Btn primary onClick={close} testId="export-close">{t('common.done')}</Btn>
          </>
        ) : (
          <>
            <Btn onClick={close}>{t('common.cancel')}</Btn>
            <Btn primary icon="export" onClick={() => void start()} disabled={duration <= 0} testId="export-start">{t('actions.file.export')}</Btn>
          </>
        )
      }
    >
      {phase === 'running' && (
        <div className="export-progress" data-testid="export-progress">
          <div className="progress"><div className="progress-fill" style={{ width: `${progress * 100}%` }} /></div>
          <div className="export-progress-row">
            <span>{Math.round(progress * 100)}%</span>
            <span className="dim">{eta > 0 ? t('export.eta', { time: formatDuration(Math.ceil(eta)) }) : t('export.starting')}</span>
          </div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className={`export-result${result.ok ? '' : ' bad'}`} data-testid="export-result" data-ok={result.ok}>
          {result.ok ? (
            <>
              <h3>{t('export.finished')}</h3>
              <p className="path">{result.outPath}</p>
            </>
          ) : result.cancelled ? (
            <h3>{t('export.cancelled')}</h3>
          ) : (
            <>
              <h3>{t('export.failed')}</h3>
              <pre className="error-text">{result.error}</pre>
            </>
          )}
        </div>
      )}
      {phase === 'idle' && (
        <div className="form">
          <Field label={t('export.format')}>
            <Select value={settings.container} testId="export-container"
              options={CONTAINERS.map((c) => ({ value: c.id, label: containerName(c.id) }))} onChange={(v) => update({ container: v })} />
          </Field>
          {hasVideo && videoCodecs.length > 1 && (
            <Field label={t('export.videoCodec')}>
              <Select value={settings.videoCodec} options={videoCodecs} onChange={(v) => update({ videoCodec: v, videoEncoder: '' })} />
            </Field>
          )}
          {hasVideo && encoders.length > 1 && (
            <Field label={t('export.encoder')}>
              <Select value={settings.videoEncoder} options={encoders} onChange={(v) => update({ videoEncoder: v })} testId="export-encoder" />
            </Field>
          )}
          {hasVideo && settings.videoEncoder !== 'gif' && (
            <>
              <Slider label={t('export.quality')} value={settings.quality} min={1} max={100} step={1} onChange={(v) => update({ quality: v })} />
              <p className="dim small indent">{t('export.qualityHint', { name: qualityName })}</p>
            </>
          )}
          {hasAudio && audioCodecs.length > 1 && (
            <Field label={t('export.audioCodec')}>
              <Select value={settings.audioCodec} options={audioCodecs} onChange={(v) => update({ audioCodec: v })} />
            </Field>
          )}
          {hasAudio && !lossless && (
            <Field label={t('export.audioBitrate')}>
              <Num value={settings.audioBitrate} min={32} max={512} step={16} unit="kbps" width={100} onChange={(v) => update({ audioBitrate: v })} />
            </Field>
          )}
          {hasAudio && hasVideo && settings.container !== 'gif' && audioTracks > 1 && (
            <Field label={t('export.audioTracks')}>
              <Select<'mix' | 'separate'>
                value={settings.audioMode}
                options={[
                  { value: 'mix', label: t('export.mix') },
                  { value: 'separate', label: t('export.separate', { count: audioTracks }) }
                ]}
                onChange={(v) => update({ audioMode: v })}
              />
            </Field>
          )}
          <div className="export-summary">
            {hasVideo && <span>{project.settings.width} × {project.settings.height} · {t('common.fps', { fps: project.settings.fps })}</span>}
            <span>{t('export.length', { time: formatDuration(duration) })}</span>
            <span className="dim">{t('export.metadataHint')}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}

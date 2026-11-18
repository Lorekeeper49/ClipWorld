import { projectDuration } from '@shared/model'
import { Btn, Field, Num, Section, Select, formatBytes, formatDuration } from '../components/ui'
import { useT } from '../i18n'
import { edit, mediaOf, primaryClip, useStore } from '../state/store'

/** Preset names that are words are message keys (metadata.presets.<name>). */
const RESOLUTIONS: [number, number, string][] = [
  [3840, 2160, '4K UHD'], [2560, 1440, '1440p'], [1920, 1080, '1080p'], [1280, 720, '720p'], [854, 480, '480p'],
  [1080, 1920, 'vertical'], [1080, 1350, 'portrait'], [1080, 1080, 'square']
]
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]

export function MetadataPanel() {
  const t = useT()
  const settings = useStore((s) => s.project.settings)
  const duration = useStore((s) => projectDuration(s.project))
  const clip = useStore(primaryClip)
  const selectedMedia = useStore((s) => mediaOf(s, s.selectedMediaId ?? undefined))
  const clipMedia = useStore((s) => mediaOf(s, clip?.mediaId))
  const media = clipMedia ?? selectedMedia

  const setRes = (width: number, height: number) =>
    edit((p) => {
      p.settings.width = Math.min(8192, Math.max(16, Math.round(width / 2) * 2))
      p.settings.height = Math.min(8192, Math.max(16, Math.round(height / 2) * 2))
    }, { key: 'settings.res' })
  const setFps = (fps: number) => edit((p) => { p.settings.fps = Math.min(240, Math.max(1, fps)) }, { key: 'settings.fps' })

  const resKey = `${settings.width}x${settings.height}`
  const resOptions = RESOLUTIONS.map(([w, h, label]) => ({ value: `${w}x${h}`, label: `${w} × ${h} — ${/^[a-z]+$/.test(label) ? t(`metadata.presets.${label}`) : label}` }))
  if (!resOptions.some((o) => o.value === resKey)) resOptions.unshift({ value: resKey, label: `${settings.width} × ${settings.height} — ${t('metadata.custom')}` })
  const fpsKey = String(settings.fps)
  const fpsOptions = RATES.map((r) => ({ value: String(r), label: t('common.fps', { fps: r }) }))
  if (!fpsOptions.some((o) => o.value === fpsKey)) fpsOptions.unshift({ value: fpsKey, label: `${t('common.fps', { fps: settings.fps })} — ${t('metadata.custom')}` })

  return (
    <div className="panel metadata-panel scroll" data-panel="metadata">
      <Section title={t('metadata.exportFrame')} icon="film">
        <Field label={t('metadata.resolution')}>
          <Select value={resKey} options={resOptions} testId="resolution-preset"
            onChange={(v) => { const [w, h] = v.split('x').map(Number); setRes(w, h) }} />
        </Field>
        <Field label={t('metadata.size')}>
          <Num value={settings.width} min={16} max={8192} step={2} unit="w" width={84} testId="res-width" onChange={(v) => setRes(v, settings.height)} />
          <span className="dim">×</span>
          <Num value={settings.height} min={16} max={8192} step={2} unit="h" width={84} testId="res-height" onChange={(v) => setRes(settings.width, v)} />
        </Field>
        <Field label={t('metadata.frameRate')}>
          <Select value={fpsKey} options={fpsOptions} testId="fps-preset" onChange={(v) => setFps(Number(v))} />
        </Field>
        <Field label={t('metadata.customRate')}>
          <Num value={settings.fps} min={1} max={240} step={0.001} unit="fps" width={96} testId="fps" onChange={setFps} />
        </Field>
        {media && media.kind !== 'audio' && (
          <Btn small onClick={() => { setRes(media.width, media.height); if (media.fps > 0) setFps(Number(media.fps.toFixed(3))) }}>
            {t('metadata.match', { name: media.name })}
          </Btn>
        )}
        <p className="dim small">{t('metadata.applyHint', { length: formatDuration(duration) })}</p>
      </Section>

      {media && (
        <Section title={t('metadata.source')} icon="info">
          <dl className="props">
            <dt>{t('metadata.name')}</dt><dd>{media.name}</dd>
            <dt>{t('metadata.folder')}</dt><dd className="path" title={media.path}>{media.path.replace(/[\\/][^\\/]*$/, '')}</dd>
            <dt>{t('metadata.type')}</dt><dd>{t(`metadata.kinds.${media.kind === 'image' && media.animated ? 'animated' : media.kind}`)}</dd>
            {media.kind !== 'audio' && <><dt>{t('metadata.resolution')}</dt><dd>{media.width} × {media.height}</dd></>}
            {media.kind === 'video' && <><dt>{t('metadata.frameRate')}</dt><dd>{t('common.fps', { fps: Number(media.fps.toFixed(3)) })}</dd></>}
            {media.duration > 0 && <><dt>{t('metadata.duration')}</dt><dd>{formatDuration(media.duration)} ({t('common.seconds', { s: media.duration.toFixed(2) })})</dd></>}
            {media.videoCodec && <><dt>{t('metadata.videoCodec')}</dt><dd>{media.videoCodec}</dd></>}
            {media.audioStreams.length > 0 && (
              <><dt>{t('metadata.audio')}</dt><dd>{media.audioStreams.map((a) => `${a.title} (${a.codec}, ${a.sampleRate / 1000} kHz)`).join('; ')}</dd></>
            )}
            <dt>{t('metadata.fileSize')}</dt><dd>{formatBytes(media.size)}</dd>
          </dl>
        </Section>
      )}

      {clip && (
        <Section title={t('metadata.clip')} icon="scissors">
          <dl className="props">
            <dt>{t('metadata.startsAt')}</dt><dd>{t('common.seconds', { s: clip.start.toFixed(2) })}</dd>
            <dt>{t('metadata.length')}</dt><dd>{t('common.seconds', { s: clip.duration.toFixed(2) })}</dd>
            {clip.type !== 'text' && clip.type !== 'image' && <><dt>{t('metadata.sourceIn')}</dt><dd>{t('common.seconds', { s: clip.srcIn.toFixed(2) })}</dd><dt>{t('metadata.speed')}</dt><dd>{Math.round(clip.speed * 100)}%</dd></>}
          </dl>
        </Section>
      )}
    </div>
  )
}

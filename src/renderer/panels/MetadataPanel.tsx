import { projectDuration } from '@shared/model'
import { Btn, Field, Num, Section, Select, formatBytes, formatDuration } from '../components/ui'
import { edit, mediaOf, primaryClip, useStore } from '../state/store'

const RESOLUTIONS: [number, number, string][] = [
  [3840, 2160, '4K UHD'], [2560, 1440, '1440p'], [1920, 1080, '1080p'], [1280, 720, '720p'], [854, 480, '480p'],
  [1080, 1920, 'Vertical 1080p'], [1080, 1350, 'Portrait 4:5'], [1080, 1080, 'Square']
]
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]

export function MetadataPanel() {
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
  const resOptions = RESOLUTIONS.map(([w, h, label]) => ({ value: `${w}x${h}`, label: `${w} × ${h} — ${label}` }))
  if (!resOptions.some((o) => o.value === resKey)) resOptions.unshift({ value: resKey, label: `${settings.width} × ${settings.height} — Custom` })
  const fpsKey = String(settings.fps)
  const fpsOptions = RATES.map((r) => ({ value: String(r), label: `${r} fps` }))
  if (!fpsOptions.some((o) => o.value === fpsKey)) fpsOptions.unshift({ value: fpsKey, label: `${settings.fps} fps — Custom` })

  return (
    <div className="panel metadata-panel scroll" data-panel="metadata">
      <Section title="Export frame" icon="film">
        <Field label="Resolution">
          <Select value={resKey} options={resOptions} testId="resolution-preset"
            onChange={(v) => { const [w, h] = v.split('x').map(Number); setRes(w, h) }} />
        </Field>
        <Field label="Size">
          <Num value={settings.width} min={16} max={8192} step={2} unit="w" width={84} testId="res-width" onChange={(v) => setRes(v, settings.height)} />
          <span className="dim">×</span>
          <Num value={settings.height} min={16} max={8192} step={2} unit="h" width={84} testId="res-height" onChange={(v) => setRes(settings.width, v)} />
        </Field>
        <Field label="Frame rate">
          <Select value={fpsKey} options={fpsOptions} testId="fps-preset" onChange={(v) => setFps(Number(v))} />
        </Field>
        <Field label="Custom rate">
          <Num value={settings.fps} min={1} max={240} step={0.001} unit="fps" width={96} testId="fps" onChange={setFps} />
        </Field>
        {media && media.kind !== 'audio' && (
          <Btn small onClick={() => { setRes(media.width, media.height); if (media.fps > 0) setFps(Number(media.fps.toFixed(3))) }}>
            Match “{media.name}”
          </Btn>
        )}
        <p className="dim small">Changes apply immediately to the preview and to the export. Timeline length: {formatDuration(duration)}.</p>
      </Section>

      {media && (
        <Section title="Source file" icon="info">
          <dl className="props">
            <dt>Name</dt><dd>{media.name}</dd>
            <dt>Folder</dt><dd className="path" title={media.path}>{media.path.replace(/[\\/][^\\/]*$/, '')}</dd>
            <dt>Type</dt><dd>{media.kind === 'image' && media.animated ? 'animated image' : media.kind}</dd>
            {media.kind !== 'audio' && <><dt>Resolution</dt><dd>{media.width} × {media.height}</dd></>}
            {media.kind === 'video' && <><dt>Frame rate</dt><dd>{Number(media.fps.toFixed(3))} fps</dd></>}
            {media.duration > 0 && <><dt>Duration</dt><dd>{formatDuration(media.duration)} ({media.duration.toFixed(2)} s)</dd></>}
            {media.videoCodec && <><dt>Video codec</dt><dd>{media.videoCodec}</dd></>}
            {media.audioStreams.length > 0 && (
              <><dt>Audio</dt><dd>{media.audioStreams.map((a) => `${a.title} (${a.codec}, ${a.sampleRate / 1000} kHz)`).join('; ')}</dd></>
            )}
            <dt>Size</dt><dd>{formatBytes(media.size)}</dd>
          </dl>
        </Section>
      )}

      {clip && (
        <Section title="Selected clip" icon="scissors">
          <dl className="props">
            <dt>Starts at</dt><dd>{clip.start.toFixed(2)} s</dd>
            <dt>Length</dt><dd>{clip.duration.toFixed(2)} s</dd>
            {clip.type !== 'text' && clip.type !== 'image' && <><dt>Source in</dt><dd>{clip.srcIn.toFixed(2)} s</dd><dt>Speed</dt><dd>{Math.round(clip.speed * 100)}%</dd></>}
          </dl>
        </Section>
      )}
    </div>
  )
}

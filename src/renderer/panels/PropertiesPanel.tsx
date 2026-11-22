// Properties of the selected clip: speed, pitch and looping (loop points, count, intro, outro, crossfade).
import { makeEffect } from '@shared/effects'
import {
  type ClipLoop, MAX_LOOP_COUNT, MIN_LOOP_COUNT, effectiveCrossfade, loopFromClip, loopable, partialIntoOutro
} from '@shared/loop'
import { type Clip, isTimed } from '@shared/model'
import { groupOf, setClipLoop } from '@shared/timeline-ops'
import { SpeedField } from './SpeedField'
import { Field, Icon, Num, Section, Slider, Toggle, formatDuration } from '../components/ui'
import { t, useT } from '../i18n'
import { edit, mediaOf, primaryClip, toast, useStore } from '../state/store'

/** Changes the loop (or removes it), telling the user when there isn't room on the track. */
function changeLoop(clipId: string, patch: Partial<ClipLoop> | null, key: string): void {
  let ok = true
  edit((p) => { ok = setClipLoop(p, clipId, patch) }, { key: `${clipId}:loop.${key}` })
  if (!ok) toast(t('properties.noRoom'), 'error')
}

function SpeedSection({ clip }: { clip: Clip }) {
  const project = useStore((s) => s.project)
  const audioClips = groupOf(project, clip).filter((c) => c.type === 'audio')
  // Pitch is the clip's pitch-shift effect (on its sound), so it sounds the same as adding one by hand.
  const pitchFx = audioClips.map((c) => c.effects.find((e) => e.type === 'pitch' && e.enabled)).find(Boolean)
  const pitch = pitchFx ? Number(pitchFx.params.semitones ?? 0) : 0
  const setPitch = (semitones: number) =>
    edit((p) => {
      for (const c of groupOf(p, p.clips.find((x) => x.id === clip.id)!)) {
        if (c.type !== 'audio') continue
        const existing = c.effects.find((e) => e.type === 'pitch')
        if (Math.abs(semitones) < 0.05) c.effects = c.effects.filter((e) => e.type !== 'pitch')
        else if (existing) {
          existing.params.semitones = semitones
          existing.enabled = true
        } else {
          const e = makeEffect('pitch')
          e.params.semitones = semitones
          c.effects.unshift(e)
        }
      }
    }, { key: `${clip.id}:pitch` })
  return (
    <Section title={t('properties.speedPitch')} icon="film">
      <SpeedField clip={clip} label={t('properties.speed')} testId="prop-speed" />
      {audioClips.length > 0 && (
        <>
          <Slider label={t('properties.pitch')} value={pitch} min={-12} max={12} field={{ min: -24, max: 24 }} step={0.1} unit="st" reset={0} mark={0}
            onChange={setPitch} testId="prop-pitch" />
          <Toggle label={t('tools.speed.keepPitch')} value={clip.preservePitch}
            onChange={(v) => edit((p) => { for (const c of groupOf(p, p.clips.find((x) => x.id === clip.id)!)) c.preservePitch = v })} />
          <p className="dim small">{t('properties.pitchHint')}</p>
        </>
      )}
    </Section>
  )
}

function LoopSection({ clip, mediaDuration }: { clip: Clip; mediaDuration: number }) {
  const l = clip.loop
  const shown = l ?? loopFromClip(clip, mediaDuration)
  const length = shown.end - shown.start
  return (
    <Section title={t('properties.loop')} icon="reset">
      <Toggle label={t('properties.loopOn')} value={!!l} testId="prop-loop"
        onChange={(on) => changeLoop(clip.id, on ? { count: shown.count } : null, 'on')} />
      {!l ? (
        <p className="dim small">{t('properties.loopHint')}</p>
      ) : (
        <>
          <Field label={t('properties.count')}>
            <Num value={l.count} min={MIN_LOOP_COUNT} max={MAX_LOOP_COUNT} step={0.1} unit="×" width={90} testId="prop-loop-count"
              onChange={(v) => changeLoop(clip.id, { count: v }, 'count')} />
          </Field>
          <Field label={t('properties.loopStart')}>
            <Num value={l.start} min={0} max={mediaDuration} step={0.01} unit="s" width={90} testId="prop-loop-start"
              onChange={(v) => changeLoop(clip.id, { start: v }, 'start')} />
          </Field>
          <Field label={t('properties.loopEnd')}>
            <Num value={l.end} min={0} max={mediaDuration} step={0.01} unit="s" width={90} testId="prop-loop-end"
              onChange={(v) => changeLoop(clip.id, { end: v }, 'end')} />
          </Field>
          <p className="dim small">
            {t('properties.loopInfo', { length: length.toFixed(2), file: formatDuration(mediaDuration) })}
          </p>
          <Toggle label={t('properties.intro')} value={l.intro} testId="prop-intro"
            onChange={(v) => changeLoop(clip.id, { intro: v }, 'intro')} />
          <p className="dim small toggle-hint">{t('properties.introHint')}</p>
          <Toggle label={t('properties.outro')} value={l.outro} testId="prop-outro"
            onChange={(v) => changeLoop(clip.id, { outro: v }, 'outro')} />
          <p className="dim small toggle-hint">{t('properties.outroHint')}</p>
          {partialIntoOutro(l) && (
            <>
              <Field label={t('properties.crossfade')}>
                <Num value={l.crossfade} min={0} max={5} step={0.05} unit="s" width={90} testId="prop-crossfade"
                  onChange={(v) => changeLoop(clip.id, { crossfade: v }, 'crossfade')} />
              </Field>
              {effectiveCrossfade(l, mediaDuration) + 1e-6 < l.crossfade && (
                <p className="dim small">{t('properties.crossfadeShortened', { seconds: effectiveCrossfade(l, mediaDuration).toFixed(2) })}</p>
              )}
              <p className="notice" data-testid="prop-partial-warning">
                <Icon name="warn" size={13} /> {t('properties.partialWarning')}
              </p>
            </>
          )}
        </>
      )}
    </Section>
  )
}

export function PropertiesPanel() {
  useT()
  const clip = useStore(primaryClip)
  const media = useStore((s) => mediaOf(s, clip?.mediaId))
  if (!clip) {
    return (
      <div className="panel properties-panel scroll" data-panel="properties">
        <div className="empty small">
          <Icon name="info" size={22} />
          <p className="dim">{t('properties.empty')}</p>
        </div>
      </div>
    )
  }
  const timed = isTimed(clip, media) && clip.type !== 'subtitles'
  return (
    <div className="panel properties-panel scroll" data-panel="properties">
      <div className="properties-head">
        <span className="properties-name">{clip.name || media?.name || t(`properties.kinds.${clip.type}`)}</span>
        <span className="dim small">
          {t('properties.where', { start: t('common.seconds', { s: clip.start.toFixed(2) }), length: t('common.seconds', { s: clip.duration.toFixed(2) }) })}
        </span>
      </div>
      {timed && <SpeedSection clip={clip} />}
      {loopable(clip, media) && <LoopSection clip={clip} mediaDuration={media!.duration} />}
      {!timed && <p className="dim pad">{t('properties.nothing')}</p>}
    </div>
  )
}

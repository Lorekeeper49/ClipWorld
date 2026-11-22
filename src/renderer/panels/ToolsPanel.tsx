import { useEffect, useMemo, useRef, useState } from 'react'
import { EFFECTS, EFFECT_MAP, type EffectDef, type ParamDef, fieldLimits, makeEffect } from '@shared/effects'
import { effectGroupName, effectName, optionName, paramName } from '@shared/labels'
import {
  type Clip, type EffectInstance, type TextProps, type TransformState,
  defaultTransform, defaultZoom, isTimed
} from '@shared/model'
import { groupOf } from '@shared/timeline-ops'
import { SpeedField } from './SpeedField'
import { Btn, Color, Field, Icon, Num, Section, Select, Slider, Toggle, useDismiss } from '../components/ui'
import { FontPicker } from '../components/FontPicker'
import { PresetsTool } from './PresetsTool'
import { VoiceoverTool } from './VoiceoverTool'
import { EaseField } from '../dialogs/EaseEditor'
import { t, useT } from '../i18n'
import { addTextAction, importPaths } from '../state/actions'
import { edit, mediaOf, primaryClip, set, toast, useStore } from '../state/store'


/** Edits one clip; rapid changes to the same field merge into a single undo step. */
function editClip(id: string, key: string, fn: (c: Clip) => void): void {
  edit((p) => {
    const c = p.clips.find((x) => x.id === id)
    if (c) fn(c)
  }, { key: `${id}:${key}` })
}

// ---------------------------------------------------------------- text

function TextTool({ clip }: { clip: Clip | undefined }) {
  const tp = clip?.type === 'text' ? clip.text : undefined
  const up = (key: keyof TextProps, v: TextProps[keyof TextProps]) =>
    clip && editClip(clip.id, `text.${key}`, (c) => { if (c.text) (c.text as unknown as Record<string, unknown>)[key] = v })
  return (
    <Section title={t('tools.text.title')} icon="text" right={<Btn small icon="plus" onClick={() => addTextAction()} testId="add-text">{t('actions.timeline.addText')}</Btn>}>
      {!tp || !clip ? (
        <p className="dim">{t('tools.text.empty')}</p>
      ) : (
        <>
          <textarea className="textarea" rows={2} value={tp.content} spellCheck={false} data-testid="text-content"
            onChange={(e) => up('content', e.target.value)} />
          <Field label={t('tools.text.font')}><FontPicker value={tp.fontFamily} onChange={(f) => up('fontFamily', f)} /></Field>
          <Slider label={t('tools.text.size')} value={tp.fontSize} min={8} max={400} field={{ min: 1 }} step={1} unit="px" onChange={(v) => up('fontSize', v)} />
          <Field label={t('tools.text.style')}>
            <Btn small active={tp.bold} onClick={() => up('bold', !tp.bold)} title={t('tools.text.bold')}><b>B</b></Btn>
            <Btn small active={tp.italic} onClick={() => up('italic', !tp.italic)} title={t('tools.text.italic')}><i>I</i></Btn>
            <span className="toolbar-sep" />
            {(['left', 'center', 'right'] as const).map((al) => (
              <Btn small key={al} active={tp.align === al} onClick={() => up('align', al)} title={t(`tools.text.alignTitle.${al}`)}>{t(`tools.text.align.${al}`)}</Btn>
            ))}
          </Field>
          <Color label={t('tools.text.fill')} value={tp.fill} onChange={(v) => up('fill', v)} />
          <Color label={t('tools.text.outline')} value={tp.outline} onChange={(v) => up('outline', v)} />
          <Slider label={t('tools.text.outlineWidth')} value={tp.outlineWidth} min={0} max={40} field={{ min: 0 }} step={0.5} unit="px" onChange={(v) => up('outlineWidth', v)} />
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- clip (speed)

function ClipTool({ clip }: { clip: Clip }) {
  const media = useStore((s) => mediaOf(s, clip.mediaId))
  if (!isTimed(clip, media)) return null
  return (
    <Section title={t('tools.speed.title')} icon="film">
      <SpeedField clip={clip} label={t('tools.speed.title')} testId="speed" />
      <Toggle label={t('tools.speed.keepPitch')} value={clip.preservePitch}
        onChange={(v) => edit((p) => { for (const c of groupOf(p, p.clips.find((x) => x.id === clip.id)!)) c.preservePitch = v })} />
      <p className="dim small">{t('tools.speed.hint')}</p>
    </Section>
  )
}

// ---------------------------------------------------------------- transform

/**
 * Names are messages: tools.transform.fields.<key>. Limits are only where something real stops: opacity and
 * crop are proportions, and the export draws a scaled clip at full size, so 1000% is the most.
 */
const TRANSFORM_FIELDS: { key: keyof TransformState; min?: number; max?: number; step: number; display: number; unit: string }[] = [
  { key: 'x', step: 0.001, display: 100, unit: '%' },
  { key: 'y', step: 0.001, display: 100, unit: '%' },
  { key: 'scale', min: 0.01, max: 10, step: 0.01, display: 100, unit: '%' },
  { key: 'rotation', step: 0.5, display: 1, unit: '°' },
  { key: 'opacity', min: 0, max: 1, step: 0.01, display: 100, unit: '%' },
  // Crop: how much of each edge to hide (the clip keeps its size and position).
  { key: 'cropLeft', min: 0, max: 1, step: 0.001, display: 100, unit: '%' },
  { key: 'cropRight', min: 0, max: 1, step: 0.001, display: 100, unit: '%' },
  { key: 'cropTop', min: 0, max: 1, step: 0.001, display: 100, unit: '%' },
  { key: 'cropBottom', min: 0, max: 1, step: 0.001, display: 100, unit: '%' }
]

function TransformTool({ clip }: { clip: Clip }) {
  const tr = clip.transform
  const setVal = (which: 'start' | 'end', key: keyof TransformState, v: number) =>
    editClip(clip.id, `tr.${which}.${key}`, (c) => {
      c.transform[which][key] = v
      // While not animating, the end state mirrors the start so enabling animation begins from a still.
      if (which === 'start' && !c.transform.animate) c.transform.end[key] = v
    })
  return (
    <Section title={t('tools.transform.title')} icon="move"
      right={<Btn small icon="reset" title={t('tools.transform.reset')} onClick={() => editClip(clip.id, 'tr.reset', (c) => { c.transform = defaultTransform() })} />}>
      <Toggle label={t('tools.transform.animate')} value={tr.animate} testId="transform-animate"
        onChange={(v) => editClip(clip.id, 'tr.animate', (c) => { c.transform.animate = v })} />
      <div className={`pairs${tr.animate ? ' two' : ''}`}>
        <span />
        <span className="pair-head">{tr.animate ? t('tools.start') : ''}</span>
        {tr.animate && <span className="pair-head">{t('tools.end')}</span>}
        {TRANSFORM_FIELDS.map((f) => (
          <div className="pair-row" key={f.key}>
            <span className="field-label">{t(`tools.transform.fields.${f.key}`)}</span>
            <Num value={tr.start[f.key]} min={f.min} max={f.max} step={f.step} display={f.display} unit={f.unit} width={78}
              testId={`tr-start-${f.key}`} onChange={(v) => setVal('start', f.key, v)} />
            {tr.animate && (
              <Num value={tr.end[f.key]} min={f.min} max={f.max} step={f.step} display={f.display} unit={f.unit} width={78}
                testId={`tr-end-${f.key}`} onChange={(v) => setVal('end', f.key, v)} />
            )}
          </div>
        ))}
      </div>
      {tr.animate && (
        <Field label={t('tools.ease')}>
          <EaseField clipId={clip.id} field="transform" ease={tr.ease} />
        </Field>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- zoom

function ZoomTool({ clip }: { clip: Clip }) {
  const z = clip.zoom
  const up = (key: 'start' | 'end' | 'focusX' | 'focusY', v: number) => editClip(clip.id, `zoom.${key}`, (c) => { c.zoom[key] = v })
  return (
    <Section title={t('tools.zoom.title')} icon="zoom"
      right={<Btn small icon="reset" title={t('tools.zoom.reset')} onClick={() => editClip(clip.id, 'zoom.reset', (c) => { c.zoom = defaultZoom() })} />}>
      <Toggle label={t('tools.zoom.enable')} value={z.enabled} testId="zoom-enabled"
        onChange={(v) => editClip(clip.id, 'zoom.enabled', (c) => { c.zoom.enabled = v })} />
      {z.enabled && (
        <>
          <Slider label={t('tools.zoom.start')} value={z.start} min={0.25} max={8} field={{ min: 0.01, max: 8 }} step={0.01} display={100} unit="%" reset={1} mark={1} onChange={(v) => up('start', v)} />
          <Slider label={t('tools.zoom.end')} value={z.end} min={0.25} max={8} field={{ min: 0.01, max: 8 }} step={0.01} display={100} unit="%" reset={1} mark={1} onChange={(v) => up('end', v)} />
          <Slider label={t('tools.zoom.focusX')} value={z.focusX} min={0} max={1} step={0.01} display={100} unit="%" reset={0.5} onChange={(v) => up('focusX', v)} />
          <Slider label={t('tools.zoom.focusY')} value={z.focusY} min={0} max={1} step={0.01} display={100} unit="%" reset={0.5} onChange={(v) => up('focusY', v)} />
          <Field label={t('tools.ease')}>
            <EaseField clipId={clip.id} field="zoom" ease={z.ease} />
          </Field>
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- effects

/** Picks a still image (or video, where allowed) from the project's Media, or imports a new one. */
function MediaPicker({ value, accept, onChange, testId }: { value: string; accept: ('image' | 'video')[]; onChange: (id: string) => void; testId?: string }) {
  const media = useStore((s) => s.project.media)
  const usable = media.filter((m) => (m.kind === 'image' && !m.animated && accept.includes('image')) || (m.kind === 'video' && accept.includes('video')))
  const missing = value && !usable.some((m) => m.id === value)
  const what = accept.includes('video') ? 'imageOrVideo' : 'image'
  return (
    <select className="select" value={missing ? '' : value} data-testid={testId}
      onChange={async (e) => {
        const v = e.target.value
        if (v !== '__import') {
          onChange(v)
          return
        }
        const items = await importPaths(await window.cw.pickMedia())
        const pick = items.find((m) => (m.kind === 'image' && !m.animated && accept.includes('image')) || (m.kind === 'video' && accept.includes('video')))
        if (pick) onChange(pick.id)
        else if (items.length) toast(t(`tools.picker.${what}.unusable`), 'error')
      }}>
      <option value="">{missing ? t(`tools.picker.${what}.missing`) : t(`tools.picker.${what}.choose`)}</option>
      {usable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      <option value="__import">{t('tools.picker.import')}</option>
    </select>
  )
}

function ParamControl({ fx, def, effect, onChange }: { fx: EffectDef; def: ParamDef; effect: EffectInstance; onChange: (v: number | string | boolean) => void }) {
  const v = effect.params[def.key] ?? def.default
  const label = paramName(fx, def)
  if (def.type === 'color') return <Color label={label} value={String(v)} onChange={onChange} />
  if (def.type === 'boolean') return <Toggle label={label} value={!!v} onChange={onChange} />
  if (def.type === 'select') {
    const options = (def.options ?? []).map((o) => ({ value: o.value, label: optionName(fx, def, o.value) }))
    return <Field label={label}><Select value={String(v)} options={options} onChange={onChange} /></Field>
  }
  if (def.type === 'media') {
    return (
      <Field label={label}>
        <MediaPicker value={String(v)} accept={def.accept ?? ['image']} onChange={onChange} testId={`param-${def.key}`} />
      </Field>
    )
  }
  return (
    <Slider label={label} value={Number(v)} min={def.min} max={def.max} field={fieldLimits(def)} step={def.step} display={def.display} unit={def.unit}
      reset={Number(def.default)} onChange={onChange} />
  )
}

/**
 * One effect in a clip's stack. `shown` is the list being displayed (effects or masks); moving swaps
 * with its neighbour in that list, wherever the two sit in the clip's full stack.
 */
function EffectCard({ clipId, effect, shown, hint }: { clipId: string; effect: EffectInstance; shown: EffectInstance[]; hint?: string }) {
  const def = EFFECT_MAP[effect.type]
  if (!def) return null
  const pos = shown.findIndex((x) => x.id === effect.id)
  const mutate = (key: string, fn: (list: EffectInstance[]) => void) => editClip(clipId, `fx.${key}`, (c) => fn(c.effects))
  const swapWith = (other: EffectInstance | undefined) =>
    other && mutate('order', (l) => {
      const i = l.findIndex((x) => x.id === effect.id)
      const j = l.findIndex((x) => x.id === other.id)
      if (i >= 0 && j >= 0) [l[i], l[j]] = [l[j], l[i]]
    })
  const set = (key: string, v: number | string | boolean) =>
    mutate(`${effect.id}.${key}`, (l) => {
      const x = l.find((y) => y.id === effect.id)
      if (x) x.params[key] = v
    })
  const visible = def.params.filter((pd) => !pd.showIf || (effect.params[pd.showIf.key] ?? def.params.find((d) => d.key === pd.showIf!.key)?.default) === pd.showIf.value)
  return (
    <div className={`effect${effect.enabled ? '' : ' disabled'}`} data-testid="effect" data-effect-type={effect.type}>
      <div className="effect-head">
        <input type="checkbox" checked={effect.enabled} title={t('tools.effects.enable')}
          onChange={(ev) => mutate(`${effect.id}.on`, (l) => { const x = l.find((y) => y.id === effect.id); if (x) x.enabled = ev.target.checked })} />
        <span className="effect-name">{effectName(def)}</span>
        <Btn small icon="up" title={t('tools.effects.moveUp')} disabled={pos <= 0} onClick={() => swapWith(shown[pos - 1])} />
        <Btn small icon="down" title={t('tools.effects.moveDown')} disabled={pos >= shown.length - 1} onClick={() => swapWith(shown[pos + 1])} />
        <Btn small icon="trash" title={t('tools.effects.remove')} onClick={() => mutate('remove', (l) => { const i = l.findIndex((y) => y.id === effect.id); if (i >= 0) l.splice(i, 1) })} />
      </div>
      {effect.enabled && hint && <p className="dim small">{hint}</p>}
      {effect.enabled && visible.map((pd) => <ParamControl key={pd.key} fx={def} def={pd} effect={effect} onChange={(v) => set(pd.key, v)} />)}
    </div>
  )
}


function MaskTool({ clip }: { clip: Clip }) {
  const masks = clip.effects.filter((e) => EFFECT_MAP[e.type]?.kind === 'mask')
  const add = (type: string) =>
    edit((p) => {
      const c = p.clips.find((x) => x.id === clip.id)
      if (!c) return
      // Masks go before the clip's other effects, which is also the order they are applied in.
      const firstEffect = c.effects.findIndex((e) => EFFECT_MAP[e.type]?.kind !== 'mask')
      c.effects.splice(firstEffect < 0 ? c.effects.length : firstEffect, 0, makeEffect(type))
    })
  return (
    <Section title={t('tools.mask.title')} icon="eyeOff">
      <div className="mask-buttons">
        <Btn small icon="plus" onClick={() => add('colorMask')} testId="add-color-mask" title={t('tools.mask.colorHint')}>{t('tools.mask.color')}</Btn>
        <Btn small icon="plus" onClick={() => add('imageMask')} testId="add-image-mask" title={t('tools.mask.imageHint')}>{t('tools.mask.image')}</Btn>
        <Btn small icon="plus" onClick={() => add('differenceMask')} testId="add-difference-mask" title={t('tools.mask.differenceHint')}>{t('tools.mask.difference')}</Btn>
      </div>
      {masks.length === 0 && <p className="dim">{t('tools.mask.empty')}</p>}
      {masks.map((e) => <EffectCard key={e.id} clipId={clip.id} effect={e} shown={masks} hint={t(`tools.mask.hints.${e.type}`)} />)}
    </Section>
  )
}

function EffectsTool({ clip }: { clip: Clip }) {
  const project = useStore((s) => s.project)
  // Effects can go on the selected clip or on any audio clip linked to it.
  const targets = useMemo(() => {
    const group = groupOf(project, clip)
    return [clip, ...group.filter((c) => c.id !== clip.id)]
  }, [project, clip])
  const [targetId, setTargetId] = useState(clip.id)
  const target = targets.find((c) => c.id === targetId) ?? clip
  useEffect(() => setTargetId(clip.id), [clip.id])
  const kind = target.type === 'audio' ? 'audio' : 'video'
  // Masks have their own section.
  const available = EFFECTS.filter((e) => e.target === kind && e.kind !== 'mask')
  const groups = [...new Set(available.map((e) => e.group))]
  const shown = target.effects.filter((e) => EFFECT_MAP[e.type] && EFFECT_MAP[e.type].kind !== 'mask')
  const [adding, setAdding] = useState('')
  const label = (c: Clip) => (c.type === 'audio' ? t('tools.effects.audioTarget', { name: c.name || t('tools.effects.track') }) : c.type === 'text' ? t('tools.effects.textTarget') : t('tools.effects.videoTarget'))

  return (
    <Section title={t('tools.effects.title')} icon="sparkle">
      {targets.length > 1 && (
        <div className="seg" role="tablist">
          {targets.map((c) => (
            <button type="button" key={c.id} className={c.id === target.id ? 'active' : ''} onClick={() => setTargetId(c.id)}>{label(c)}</button>
          ))}
        </div>
      )}
      <select className="select wide" value={adding} data-testid="add-effect"
        onChange={(e) => {
          const type = e.target.value
          setAdding('')
          if (type) edit((p) => { p.clips.find((c) => c.id === target.id)?.effects.push(makeEffect(type)) })
        }}>
        <option value="">{kind === 'audio' ? t('tools.effects.addAudio') : t('tools.effects.addVideo')}</option>
        {groups.map((g) => (
          <optgroup label={effectGroupName(g)} key={g}>
            {available.filter((e) => e.group === g).map((e) => <option key={e.type} value={e.type}>{effectName(e)}</option>)}
          </optgroup>
        ))}
      </select>
      {shown.length === 0 && <p className="dim">{t('tools.effects.empty')}</p>}
      {shown.map((e) => <EffectCard key={e.id} clipId={target.id} effect={e} shown={shown} />)}
    </Section>
  )
}

// ---------------------------------------------------------------- panel

export function ToolsPanel() {
  useT()
  const clip = useStore(primaryClip)
  const visual = clip && clip.type !== 'audio'
  return (
    <div className="panel tools-panel scroll" data-panel="tools">
      <TextTool clip={clip} />
      <VoiceoverTool />
      <PresetsTool />
      {!clip && (
        <div className="empty small">
          <Icon name="sparkle" size={22} />
          <p className="dim">{t('tools.empty')}</p>
        </div>
      )}
      {clip && <ClipTool clip={clip} />}
      {clip && visual && <ZoomTool clip={clip} />}
      {clip && visual && <TransformTool clip={clip} />}
      {clip && visual && <MaskTool clip={clip} />}
      {clip && <EffectsTool clip={clip} />}
    </div>
  )
}

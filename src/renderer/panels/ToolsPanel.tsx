import { useEffect, useMemo, useRef, useState } from 'react'
import { EASES, EASE_NAMES } from '@shared/easing'
import { EFFECTS, EFFECT_MAP, type ParamDef, makeEffect } from '@shared/effects'
import {
  type Clip, type EaseName, type EffectInstance, MAX_SPEED, MIN_SPEED, type TextProps, type TransformState,
  defaultTransform, defaultZoom, isTimed
} from '@shared/model'
import { groupOf, stretchClip } from '@shared/timeline-ops'
import { Btn, Color, Field, Icon, Num, Section, Select, Slider, Toggle, useDismiss } from '../components/ui'
import { FontPicker } from '../components/FontPicker'
import { addTextAction } from '../state/actions'
import { edit, mediaOf, primaryClip, set, useStore } from '../state/store'

const easeOptions = EASE_NAMES.map((e) => ({ value: e, label: EASES[e].label }))

/** Edits one clip; rapid changes to the same field merge into a single undo step. */
function editClip(id: string, key: string, fn: (c: Clip) => void): void {
  edit((p) => {
    const c = p.clips.find((x) => x.id === id)
    if (c) fn(c)
  }, { key: `${id}:${key}` })
}

// ---------------------------------------------------------------- text

function TextTool({ clip }: { clip: Clip | undefined }) {
  const t = clip?.type === 'text' ? clip.text : undefined
  const up = (key: keyof TextProps, v: TextProps[keyof TextProps]) =>
    clip && editClip(clip.id, `text.${key}`, (c) => { if (c.text) (c.text as unknown as Record<string, unknown>)[key] = v })
  return (
    <Section title="Text" icon="text" right={<Btn small icon="plus" onClick={() => addTextAction()} testId="add-text">Add text</Btn>}>
      {!t || !clip ? (
        <p className="dim">Add a text clip at the playhead, or select one on the timeline to edit it.</p>
      ) : (
        <>
          <textarea className="textarea" rows={2} value={t.content} spellCheck={false} data-testid="text-content"
            onChange={(e) => up('content', e.target.value)} />
          <Field label="Font"><FontPicker value={t.fontFamily} onChange={(f) => up('fontFamily', f)} /></Field>
          <Slider label="Size" value={t.fontSize} min={8} max={400} step={1} unit="px" onChange={(v) => up('fontSize', v)} />
          <Field label="Style">
            <Btn small active={t.bold} onClick={() => up('bold', !t.bold)} title="Bold"><b>B</b></Btn>
            <Btn small active={t.italic} onClick={() => up('italic', !t.italic)} title="Italic"><i>I</i></Btn>
            <span className="toolbar-sep" />
            {(['left', 'center', 'right'] as const).map((al) => (
              <Btn small key={al} active={t.align === al} onClick={() => up('align', al)} title={`Align ${al}`}>{al[0].toUpperCase() + al.slice(1)}</Btn>
            ))}
          </Field>
          <Color label="Fill" value={t.fill} onChange={(v) => up('fill', v)} />
          <Color label="Outline" value={t.outline} onChange={(v) => up('outline', v)} />
          <Slider label="Outline width" value={t.outlineWidth} min={0} max={40} step={0.5} unit="px" onChange={(v) => up('outlineWidth', v)} />
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- clip (speed)

function ClipTool({ clip }: { clip: Clip }) {
  const media = useStore((s) => mediaOf(s, clip.mediaId))
  if (!isTimed(clip, media)) return null
  const setSpeed = (speed: number) => {
    const sp = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
    // Changing speed is the same operation as dragging the clip's right edge.
    edit((p) => { stretchClip(p, clip.id, 'end', clip.start + (clip.duration * clip.speed) / sp) }, { key: `${clip.id}:speed` })
  }
  return (
    <Section title="Speed" icon="film">
      <Slider label="Speed" value={clip.speed} min={0.1} max={8} step={0.01} display={100} unit="%" reset={1} mark={1} onChange={setSpeed} testId="speed" />
      <Toggle label="Keep audio pitch when speed changes" value={clip.preservePitch}
        onChange={(v) => edit((p) => { for (const c of groupOf(p, p.clips.find((x) => x.id === clip.id)!)) c.preservePitch = v })} />
      <p className="dim small">Dragging a clip's edge on the timeline changes its speed to fit the new length.</p>
    </Section>
  )
}

// ---------------------------------------------------------------- transform

const TRANSFORM_FIELDS: { key: keyof TransformState; label: string; min: number; max: number; step: number; display: number; unit: string }[] = [
  { key: 'x', label: 'Position X', min: -2, max: 2, step: 0.001, display: 100, unit: '%' },
  { key: 'y', label: 'Position Y', min: -2, max: 2, step: 0.001, display: 100, unit: '%' },
  { key: 'scale', label: 'Scale', min: 0.01, max: 10, step: 0.01, display: 100, unit: '%' },
  { key: 'rotation', label: 'Rotation', min: -720, max: 720, step: 0.5, display: 1, unit: '°' },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01, display: 100, unit: '%' }
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
    <Section title="Transform" icon="move"
      right={<Btn small icon="reset" title="Reset transform" onClick={() => editClip(clip.id, 'tr.reset', (c) => { c.transform = defaultTransform() })} />}>
      <Toggle label="Animate from start to end" value={tr.animate} testId="transform-animate"
        onChange={(v) => editClip(clip.id, 'tr.animate', (c) => { c.transform.animate = v })} />
      <div className={`pairs${tr.animate ? ' two' : ''}`}>
        <span />
        <span className="pair-head">{tr.animate ? 'Start' : ''}</span>
        {tr.animate && <span className="pair-head">End</span>}
        {TRANSFORM_FIELDS.map((f) => (
          <div className="pair-row" key={f.key}>
            <span className="field-label">{f.label}</span>
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
        <Field label="Ease">
          <Select<EaseName> value={tr.ease} options={easeOptions} onChange={(v) => editClip(clip.id, 'tr.ease', (c) => { c.transform.ease = v })} />
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
    <Section title="Zoom on video" icon="zoom"
      right={<Btn small icon="reset" title="Reset zoom" onClick={() => editClip(clip.id, 'zoom.reset', (c) => { c.zoom = defaultZoom() })} />}>
      <Toggle label="Zoom into the clip over its length" value={z.enabled} testId="zoom-enabled"
        onChange={(v) => editClip(clip.id, 'zoom.enabled', (c) => { c.zoom.enabled = v })} />
      {z.enabled && (
        <>
          <Slider label="Start zoom" value={z.start} min={0.25} max={8} step={0.01} display={100} unit="%" reset={1} mark={1} onChange={(v) => up('start', v)} />
          <Slider label="End zoom" value={z.end} min={0.25} max={8} step={0.01} display={100} unit="%" reset={1} mark={1} onChange={(v) => up('end', v)} />
          <Slider label="Focus X" value={z.focusX} min={0} max={1} step={0.01} display={100} unit="%" reset={0.5} onChange={(v) => up('focusX', v)} />
          <Slider label="Focus Y" value={z.focusY} min={0} max={1} step={0.01} display={100} unit="%" reset={0.5} onChange={(v) => up('focusY', v)} />
          <Field label="Ease">
            <Select<EaseName> value={z.ease} options={easeOptions} onChange={(v) => editClip(clip.id, 'zoom.ease', (c) => { c.zoom.ease = v })} />
          </Field>
        </>
      )}
    </Section>
  )
}

// ---------------------------------------------------------------- effects

function ParamControl({ def, effect, onChange }: { def: ParamDef; effect: EffectInstance; onChange: (v: number | string | boolean) => void }) {
  const v = effect.params[def.key] ?? def.default
  if (def.type === 'color') return <Color label={def.label} value={String(v)} onChange={onChange} />
  if (def.type === 'boolean') return <Toggle label={def.label} value={!!v} onChange={onChange} />
  if (def.type === 'select') {
    return <Field label={def.label}><Select value={String(v)} options={def.options ?? []} onChange={onChange} /></Field>
  }
  return (
    <Slider label={def.label} value={Number(v)} min={def.min} max={def.max} step={def.step} display={def.display} unit={def.unit}
      reset={Number(def.default)} onChange={onChange} />
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
  const available = EFFECTS.filter((e) => e.target === kind)
  const groups = [...new Set(available.map((e) => e.group))]
  const [adding, setAdding] = useState('')

  const mutate = (key: string, fn: (list: EffectInstance[]) => void) => editClip(target.id, `fx.${key}`, (c) => fn(c.effects))
  const label = (c: Clip) => (c.type === 'audio' ? `Audio · ${c.name || 'track'}` : c.type === 'text' ? 'Text' : 'Video')

  return (
    <Section title="Filters & effects" icon="sparkle">
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
        <option value="">+ Add {kind === 'audio' ? 'an audio effect' : 'a filter or effect'}…</option>
        {groups.map((g) => (
          <optgroup label={g} key={g}>
            {available.filter((e) => e.group === g).map((e) => <option key={e.type} value={e.type}>{e.label}</option>)}
          </optgroup>
        ))}
      </select>
      {target.effects.length === 0 && <p className="dim">No effects yet. Add as many as you like — they apply top to bottom.</p>}
      {target.effects.map((e, i) => {
        const def = EFFECT_MAP[e.type]
        if (!def) return null
        return (
          <div className={`effect${e.enabled ? '' : ' disabled'}`} key={e.id} data-testid="effect" data-effect-type={e.type}>
            <div className="effect-head">
              <input type="checkbox" checked={e.enabled} title="Enable" onChange={(ev) => mutate(`${e.id}.on`, (l) => { l[i].enabled = ev.target.checked })} />
              <span className="effect-name">{def.label}</span>
              <Btn small icon="up" title="Move up" disabled={i === 0} onClick={() => mutate('order', (l) => { [l[i - 1], l[i]] = [l[i], l[i - 1]] })} />
              <Btn small icon="down" title="Move down" disabled={i === target.effects.length - 1} onClick={() => mutate('order', (l) => { [l[i + 1], l[i]] = [l[i], l[i + 1]] })} />
              <Btn small icon="trash" title="Remove" onClick={() => mutate('remove', (l) => { l.splice(i, 1) })} />
            </div>
            {e.enabled && def.params.map((pd) => (
              <ParamControl key={pd.key} def={pd} effect={e} onChange={(v) => mutate(`${e.id}.${pd.key}`, (l) => { l[i].params[pd.key] = v })} />
            ))}
          </div>
        )
      })}
    </Section>
  )
}

// ---------------------------------------------------------------- panel

export function ToolsPanel() {
  const clip = useStore(primaryClip)
  const visual = clip && clip.type !== 'audio'
  return (
    <div className="panel tools-panel scroll" data-panel="tools">
      <TextTool clip={clip} />
      {!clip && (
        <div className="empty small">
          <Icon name="sparkle" size={22} />
          <p className="dim">Select a clip on the timeline to zoom, transform or add filters and effects.</p>
        </div>
      )}
      {clip && <ClipTool clip={clip} />}
      {clip && visual && <ZoomTool clip={clip} />}
      {clip && visual && <TransformTool clip={clip} />}
      {clip && <EffectsTool clip={clip} />}
    </div>
  )
}

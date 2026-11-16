// Subtitle editor: tracks, styling, a fast list of cues, import from files or videos, export to files,
// and putting a track on the timeline (which is what puts it into the exported video).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubtitleStreamListing } from '@shared/ipc'
import type { SubtitleCue, SubtitleStyle, SubtitleTrack } from '@shared/model'
import { LANGUAGES, SUBTITLE_FORMATS, cueAt, formatTimecode, parseTimecode } from '@shared/subtitles'
import { FontPicker } from '../components/FontPicker'
import { Btn, Color, Field, Icon, Section, Select, Slider, Toggle, useDismiss } from '../components/ui'
import { player, usePlayerTime } from '../engine/player'
import {
  addCueAction, addSubtitlesToTimelineAction, deleteCueAction, deleteSubtitleTrackAction, editSubtitleTrack,
  exportSubtitlesAction, importSubtitleFilesAction, importSubtitleStreamAction, newSubtitleTrackAction, setCueEdgeAction,
  timelineTimeOf, trackTimeAt, updateCueAction
} from '../state/actions'
import { bindingFor } from '../state/shortcuts'
import { get, set, useStore } from '../state/store'

const ROW_H = 68

// ---------------------------------------------------------------- small inputs

/** A timecode field (hh:mm:ss.mmm) that commits on Enter or blur and reverts on Escape or bad input. */
function TimeInput({ value, onCommit, testId, title }: { value: number; onCommit: (v: number) => void; testId?: string; title?: string }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      className={`time-input${text !== null && parseTimecode(text) === null ? ' invalid' : ''}`}
      value={text ?? formatTimecode(value)}
      title={title}
      data-testid={testId}
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = text === null ? null : parseTimecode(text)
        setText(null)
        if (v !== null && Math.abs(v - value) > 1e-4) onCommit(v)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(null)
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

// ---------------------------------------------------------------- track header

function TrackBar({ track }: { track: SubtitleTrack | undefined }) {
  const tracks = useStore((s) => s.project.subtitles)
  const clipCount = useStore((s) => (track ? s.project.clips.filter((c) => c.subtitleTrackId === track.id).length : 0))
  return (
    <div className="panel-toolbar sub-toolbar">
      <select className="select" value={track?.id ?? ''} data-testid="subtitle-track"
        onChange={(e) => set({ activeSubtitleTrack: e.target.value, activeCueId: null })}>
        {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <Btn small icon="plus" title="New subtitle track" testId="subtitle-new-track" onClick={() => newSubtitleTrackAction()} />
      {track && (
        <Btn small icon="trash" title="Delete this subtitle track (and its clips on the timeline)"
          onClick={() => deleteSubtitleTrackAction(track.id)} />
      )}
      <span className="toolbar-spacer" />
      {track && (clipCount === 0 ? (
        <Btn small primary icon="film" testId="subtitle-to-timeline" disabled={!track.cues.length}
          title="Put this track on the timeline as a clip. That puts the subtitles into the exported video, and lets you move, stretch, transform and add effects to them."
          onClick={() => addSubtitlesToTimelineAction(track.id)}>
          Add to timeline
        </Btn>
      ) : (
        <span className="sub-on-timeline" title="This track is in the video. Select its clip on the timeline to move it or add effects.">
          <Icon name="film" size={13} /> On timeline{clipCount > 1 ? ` (${clipCount} clips)` : ''}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- import / export popovers

function ImportMenu() {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const media = useStore((s) => s.project.media)
  const [streams, setStreams] = useState<{ mediaId: string; name: string; list: SubtitleStreamListing[] }[] | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    setStreams(null)
    const videos = media.filter((m) => m.kind === 'video')
    void Promise.all(videos.map(async (m) => ({ mediaId: m.id, name: m.name, list: await window.cw.listSubtitleStreams(m.path).catch(() => []) })))
      .then((r) => alive && setStreams(r.filter((x) => x.list.length)))
    return () => {
      alive = false
    }
  }, [open, media])
  return (
    <div className="popover-anchor" ref={ref}>
      <Btn small icon="upload" onClick={() => setOpen(!open)} testId="subtitle-import">Import</Btn>
      {open && (
        <div className="menu-pop sub-pop">
          <button type="button" className="menu-item" onClick={() => { setOpen(false); void importSubtitleFilesAction() }}>
            <span className="menu-check" />
            <span className="menu-label">Subtitle file… (SRT, VTT, ASS, SBV, TTML, SAMI, SUB, LRC)</span>
          </button>
          <div className="menu-sep" />
          {streams === null && <div className="sub-pop-note dim">Looking for subtitle tracks in your videos…</div>}
          {streams?.length === 0 && <div className="sub-pop-note dim">None of the project's videos contain subtitle tracks.</div>}
          {streams?.map((v) => v.list.map((s) => (
            <button type="button" key={`${v.mediaId}:${s.index}`} className="menu-item" disabled={!s.text}
              title={s.text ? undefined : 'Picture-based subtitles (DVD/Blu-ray) cannot be turned into text'}
              onClick={() => {
                setOpen(false)
                void importSubtitleStreamAction(v.mediaId, s.index, s.title || `${v.name} subtitles`, s.language)
              }}>
              <span className="menu-check" />
              <span className="menu-label">{v.name} — {s.title || `Track ${s.index + 1}`} ({s.language}, {s.codec})</span>
            </button>
          )))}
        </div>
      )}
    </div>
  )
}

function ExportBox({ track, onClose }: { track: SubtitleTrack; onClose: () => void }) {
  const onTimeline = useStore((s) => s.project.clips.some((c) => c.subtitleTrackId === track.id))
  const [format, setFormat] = useState('srt')
  const [timing, setTiming] = useState<'timeline' | 'original'>('timeline')
  return (
    <div className="sub-export" data-testid="subtitle-export-box">
      <Field label="Format">
        <Select value={format} onChange={setFormat} testId="subtitle-format"
          options={SUBTITLE_FORMATS.map((f) => ({ value: f.id, label: f.label }))} />
      </Field>
      {onTimeline && (
        <Field label="Timing">
          <Select<'timeline' | 'original'> value={timing} onChange={setTiming}
            options={[
              { value: 'timeline', label: 'Match the video (where the clip sits on the timeline)' },
              { value: 'original', label: 'Original subtitle times' }
            ]} />
        </Field>
      )}
      <div className="sub-export-actions">
        <Btn small onClick={onClose}>Cancel</Btn>
        <Btn small primary icon="export" testId="subtitle-export-save"
          onClick={() => void exportSubtitlesAction(track.id, format, onTimeline ? timing : 'original').then(onClose)}>
          Save…
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- style

function StyleSection({ track }: { track: SubtitleTrack }) {
  const st = track.style
  const up = <K extends keyof SubtitleStyle>(key: K, v: SubtitleStyle[K]) => editSubtitleTrack(track.id, `style.${key}`, (t) => { t.style[key] = v })
  return (
    <Section title="Style" icon="text" defaultOpen={false}>
      <Field label="Font"><FontPicker value={st.fontFamily} onChange={(f) => up('fontFamily', f)} /></Field>
      <Slider label="Size" value={st.fontSize} min={12} max={200} step={1} unit="px" onChange={(v) => up('fontSize', v)} />
      <Field label="Style">
        <Btn small active={st.bold} onClick={() => up('bold', !st.bold)} title="Bold"><b>B</b></Btn>
        <Btn small active={st.italic} onClick={() => up('italic', !st.italic)} title="Italic"><i>I</i></Btn>
        <span className="toolbar-sep" />
        {(['left', 'center', 'right'] as const).map((al) => (
          <Btn small key={al} active={st.align === al} onClick={() => up('align', al)}>{al[0].toUpperCase() + al.slice(1)}</Btn>
        ))}
      </Field>
      <Color label="Text" value={st.fill} onChange={(v) => up('fill', v)} />
      <Color label="Outline" value={st.outline} onChange={(v) => up('outline', v)} />
      <Slider label="Outline width" value={st.outlineWidth} min={0} max={20} step={0.5} unit="px" onChange={(v) => up('outlineWidth', v)} />
      <Toggle label="Background box" value={st.box} onChange={(v) => up('box', v)} />
      {st.box && (
        <>
          <Color label="Box colour" value={st.boxColor} onChange={(v) => up('boxColor', v)} />
          <Slider label="Box opacity" value={st.boxOpacity} min={0} max={1} step={0.01} display={100} unit="%" onChange={(v) => up('boxOpacity', v)} />
        </>
      )}
      <Field label="Position">
        <Select<SubtitleStyle['position']> value={st.position} onChange={(v) => up('position', v)}
          options={[{ value: 'bottom', label: 'Bottom' }, { value: 'middle', label: 'Middle' }, { value: 'top', label: 'Top' }]} />
      </Field>
      {st.position !== 'middle' && (
        <Slider label="Edge margin" value={st.margin} min={0} max={0.4} step={0.005} display={100} unit="%" onChange={(v) => up('margin', v)} />
      )}
      <Slider label="Line width" value={st.maxWidth} min={0.2} max={1} step={0.01} display={100} unit="%" onChange={(v) => up('maxWidth', v)} />
    </Section>
  )
}

// ---------------------------------------------------------------- cue list

interface RowProps {
  track: SubtitleTrack
  cue: SubtitleCue
  index: number
  top: number
  current: boolean
  selected: boolean
  overlap: boolean
  onTimeline: boolean
}

function CueRow({ track, cue, index, top, current, selected, overlap, onTimeline }: RowProps) {
  const project = get().project
  // Times are shown where the subtitle appears in the video when the track is on the timeline.
  const shown = (t: number) => (onTimeline ? timelineTimeOf(project, track, t) : t)
  const toTrack = (t: number) => (onTimeline ? trackTimeAt(project, track, t) : t)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const focusCue = useStore((s) => s.focusCue)
  useEffect(() => {
    if (focusCue === cue.id && textRef.current) {
      textRef.current.focus()
      set({ focusCue: null })
    }
  }, [focusCue, cue.id])
  const select = () => {
    set({ activeCueId: cue.id })
    player.pause()
    player.seek(shown(cue.start) + 1e-3)
  }
  return (
    <div
      className={`cue-row${current ? ' current' : ''}${selected ? ' selected' : ''}${overlap ? ' overlap' : ''}`}
      style={{ top, height: ROW_H }}
      data-testid="cue-row"
      data-cue-id={cue.id}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea, button')) {
          set({ activeCueId: cue.id })
          return
        }
        select()
      }}
    >
      <span className="cue-index" title={overlap ? 'Overlaps the previous subtitle' : 'Click to jump here'}>
        {overlap ? <Icon name="warn" size={12} /> : index + 1}
      </span>
      <div className="cue-times">
        <TimeInput value={shown(cue.start)} testId="cue-start" title="Start"
          onCommit={(v) => updateCueAction(track.id, cue.id, { start: toTrack(v) })} />
        <TimeInput value={shown(cue.end)} testId="cue-end" title="End"
          onCommit={(v) => updateCueAction(track.id, cue.id, { end: toTrack(v) })} />
      </div>
      <textarea
        ref={textRef}
        className="cue-text"
        value={cue.text}
        placeholder="Type the subtitle…"
        spellCheck
        data-testid="cue-text"
        onFocus={() => set({ activeCueId: cue.id })}
        onChange={(e) => updateCueAction(track.id, cue.id, { text: e.target.value })}
        onKeyDown={(e) => {
          // Enter on its own finishes the line; Shift+Enter adds a line break.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            ;(e.target as HTMLTextAreaElement).blur()
          }
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
        }}
      />
      <Btn small icon="trash" title="Delete subtitle" onClick={() => deleteCueAction(track.id, cue.id)} />
    </div>
  )
}

function CueList({ track }: { track: SubtitleTrack }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(400)
  const time = usePlayerTime()
  const project = useStore((s) => s.project)
  const activeCueId = useStore((s) => s.activeCueId)
  const onTimeline = project.clips.some((c) => c.subtitleTrackId === track.id)
  const currentId = cueAt(track, trackTimeAt(project, track, time))?.id
  const cues = track.cues
  const overlaps = useMemo(() => {
    const set = new Set<string>()
    for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end - 1e-3) set.add(cues[i].id)
    return set
  }, [cues])

  useEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Follow the playhead while playing, unless the user is typing in the list.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !currentId || !player.playing || el.contains(document.activeElement)) return
    const i = cues.findIndex((c) => c.id === currentId)
    const top = i * ROW_H
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - ROW_H)
  }, [currentId, cues])

  // A newly added subtitle is scrolled into view so its text box can take focus.
  const focusCue = useStore((s) => s.focusCue)
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !focusCue) return
    const i = cues.findIndex((c) => c.id === focusCue)
    if (i >= 0 && (i * ROW_H < el.scrollTop || (i + 1) * ROW_H > el.scrollTop + el.clientHeight)) {
      el.scrollTop = Math.max(0, i * ROW_H - ROW_H)
      setScroll(el.scrollTop)
    }
  }, [focusCue, cues])

  const first = Math.max(0, Math.floor(scroll / ROW_H) - 3)
  const last = Math.min(cues.length, Math.ceil((scroll + height) / ROW_H) + 3)
  return (
    <div className="cue-scroll" ref={scrollRef} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)} data-testid="cue-list">
      {cues.length === 0 ? (
        <div className="empty small">
          <p className="dim">No subtitles yet. Move the playhead to where someone speaks and press <b>{bindingFor('subtitles.add')}</b> or <b>Add</b>.</p>
        </div>
      ) : (
        <div style={{ height: cues.length * ROW_H, position: 'relative' }}>
          {cues.slice(first, last).map((c, i) => (
            <CueRow key={c.id} track={track} cue={c} index={first + i} top={(first + i) * ROW_H}
              current={c.id === currentId} selected={c.id === activeCueId} overlap={overlaps.has(c.id)} onTimeline={onTimeline} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- panel

export function SubtitlesPanel() {
  const tracks = useStore((s) => s.project.subtitles)
  const activeId = useStore((s) => s.activeSubtitleTrack)
  const guide = useStore((s) => s.subtitleGuide)
  const exportRequest = useStore((s) => s.subtitleExportRequest)
  const track = tracks.find((t) => t.id === activeId) ?? tracks[0]
  const onTimeline = useStore((s) => !!track && s.project.clips.some((c) => c.subtitleTrackId === track.id))
  const [exporting, setExporting] = useState(false)
  useStore((s) => s.settings.shortcuts)

  useEffect(() => {
    if (track && track.id !== activeId) set({ activeSubtitleTrack: track.id })
  }, [track, activeId])
  useEffect(() => {
    if (exportRequest) setExporting(true)
  }, [exportRequest])

  if (!track) {
    return (
      <div className="panel subtitles-panel" data-panel="subtitles">
        <div className="empty">
          <Icon name="text" size={28} />
          <p>Create subtitles</p>
          <p className="dim">Type them in here, or import a subtitle file. Each track can be exported as a subtitle file, and added to the timeline to put it in the video.</p>
          <div className="empty-actions">
            <Btn primary icon="plus" onClick={() => newSubtitleTrackAction()} testId="subtitle-create">New subtitle track</Btn>
            <ImportMenu />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="panel subtitles-panel" data-panel="subtitles">
      <TrackBar track={track} />
      <div className="sub-scroll-top">
        <div className="sub-row">
          <input className="sub-name" value={track.name} spellCheck={false} data-testid="subtitle-name"
            onChange={(e) => editSubtitleTrack(track.id, 'name', (t) => { t.name = e.target.value })} title="Track name" />
          <Select value={track.language} onChange={(v) => editSubtitleTrack(track.id, 'language', (t) => { t.language = v })}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
        </div>
        <div className="sub-row">
          <ImportMenu />
          <Btn small icon="export" onClick={() => setExporting(!exporting)} active={exporting} disabled={!track.cues.length} testId="subtitle-export">
            Export file
          </Btn>
          {!onTimeline && (
            <Toggle label="Show in preview" value={guide} onChange={(v) => set({ subtitleGuide: v })} />
          )}
        </div>
        {exporting && <ExportBox track={track} onClose={() => setExporting(false)} />}
        <StyleSection track={track} />
      </div>
      <div className="cue-toolbar">
        <span className="cue-count">{track.cues.length} subtitle{track.cues.length === 1 ? '' : 's'}</span>
        <span className="toolbar-spacer" />
        <Btn small icon="plus" primary onClick={() => void addCueAction()} title={`Add a subtitle at the playhead (${bindingFor('subtitles.add')})`} testId="cue-add">Add</Btn>
        <Btn small onClick={() => setCueEdgeAction('start')} title={`Set the selected subtitle's start to the playhead (${bindingFor('subtitles.setStart')})`}>Start ⇤</Btn>
        <Btn small onClick={() => setCueEdgeAction('end')} title={`Set the selected subtitle's end to the playhead (${bindingFor('subtitles.setEnd')})`}>⇥ End</Btn>
      </div>
      <CueList track={track} />
    </div>
  )
}

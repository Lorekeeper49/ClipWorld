// Subtitle editor: tracks, styling, a fast list of cues, import from files or videos, export to files,
// and putting a track on the timeline (which is what puts it into the exported video).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SubtitleStreamListing } from '@shared/ipc'
import type { SubtitleCue, SubtitleStyle, SubtitleTrack } from '@shared/model'
import { LANGUAGES, SUBTITLE_FORMATS, cueAt, formatTimecode, parseTimecode } from '@shared/subtitles'
import { subtitleFormatName, subtitleLanguageName } from '@shared/labels'
import { FontPicker } from '../components/FontPicker'
import { Btn, Color, Field, Icon, Section, Select, Slider, Toggle, useDismiss } from '../components/ui'
import { player, usePlayerTime } from '../engine/player'
import {
  addCueAction, addSubtitlesToTimelineAction, deleteCueAction, deleteSubtitleTrackAction, editSubtitleTrack,
  exportSubtitlesAction, importSubtitleFilesAction, importSubtitleStreamAction, newSubtitleTrackAction, setCueEdgeAction,
  timelineTimeOf, trackTimeAt, updateCueAction
} from '../state/actions'
import { t, tx, useT } from '../i18n'
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
        {tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
      </select>
      <Btn small icon="plus" title={t('subtitles.newTrack')} testId="subtitle-new-track" onClick={() => newSubtitleTrackAction()} />
      {track && (
        <Btn small icon="trash" title={t('subtitles.deleteTrack')}
          onClick={() => deleteSubtitleTrackAction(track.id)} />
      )}
      <span className="toolbar-spacer" />
      {track && (clipCount === 0 ? (
        <Btn small primary icon="film" testId="subtitle-to-timeline" disabled={!track.cues.length}
          title={t('subtitles.toTimelineHint')}
          onClick={() => addSubtitlesToTimelineAction(track.id)}>
          {t('subtitles.toTimeline')}
        </Btn>
      ) : (
        <span className="sub-on-timeline" title={t('subtitles.onTimelineHint')}>
          <Icon name="film" size={13} /> {clipCount > 1 ? t('subtitles.onTimelineClips', { count: clipCount }) : t('subtitles.onTimeline')}
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
      <Btn small icon="upload" onClick={() => setOpen(!open)} testId="subtitle-import">{t('subtitles.import')}</Btn>
      {open && (
        <div className="menu-pop sub-pop">
          <button type="button" className="menu-item" onClick={() => { setOpen(false); void importSubtitleFilesAction() }}>
            <span className="menu-check" />
            <span className="menu-label">{t('subtitles.importFile', { formats: 'SRT, VTT, ASS, SBV, TTML, SAMI, SUB, LRC' })}</span>
          </button>
          <div className="menu-sep" />
          {streams === null && <div className="sub-pop-note dim">{t('subtitles.searching')}</div>}
          {streams?.length === 0 && <div className="sub-pop-note dim">{t('subtitles.noStreams')}</div>}
          {streams?.map((v) => v.list.map((s) => (
            <button type="button" key={`${v.mediaId}:${s.index}`} className="menu-item" disabled={!s.text}
              title={s.text ? undefined : t('subtitles.pictureBased')}
              onClick={() => {
                setOpen(false)
                void importSubtitleStreamAction(v.mediaId, s.index, s.title || t('subtitles.streamName', { name: v.name }), s.language)
              }}>
              <span className="menu-check" />
              <span className="menu-label">{v.name} — {s.title || t('subtitles.trackN', { n: s.index + 1 })} ({s.language}, {s.codec})</span>
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
      <Field label={t('export.format')}>
        <Select value={format} onChange={setFormat} testId="subtitle-format"
          options={SUBTITLE_FORMATS.map((f) => ({ value: f.id, label: subtitleFormatName(f.id) }))} />
      </Field>
      {onTimeline && (
        <Field label={t('subtitles.timing')}>
          <Select<'timeline' | 'original'> value={timing} onChange={setTiming}
            options={[
              { value: 'timeline', label: t('subtitles.timingTimeline') },
              { value: 'original', label: t('subtitles.timingOriginal') }
            ]} />
        </Field>
      )}
      <div className="sub-export-actions">
        <Btn small onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn small primary icon="export" testId="subtitle-export-save"
          onClick={() => void exportSubtitlesAction(track.id, format, onTimeline ? timing : 'original').then(onClose)}>
          {t('subtitles.save')}
        </Btn>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- style

function StyleSection({ track }: { track: SubtitleTrack }) {
  const st = track.style
  const up = <K extends keyof SubtitleStyle>(key: K, v: SubtitleStyle[K]) => editSubtitleTrack(track.id, `style.${key}`, (tr) => { tr.style[key] = v })
  return (
    <Section title={t('subtitles.style')} icon="text" defaultOpen={false}>
      <Field label={t('tools.text.font')}><FontPicker value={st.fontFamily} onChange={(f) => up('fontFamily', f)} /></Field>
      <Slider label={t('tools.text.size')} value={st.fontSize} min={12} max={200} step={1} unit="px" onChange={(v) => up('fontSize', v)} />
      <Field label={t('tools.text.style')}>
        <Btn small active={st.bold} onClick={() => up('bold', !st.bold)} title={t('tools.text.bold')}><b>B</b></Btn>
        <Btn small active={st.italic} onClick={() => up('italic', !st.italic)} title={t('tools.text.italic')}><i>I</i></Btn>
        <span className="toolbar-sep" />
        {(['left', 'center', 'right'] as const).map((al) => (
          <Btn small key={al} active={st.align === al} onClick={() => up('align', al)} title={t(`tools.text.alignTitle.${al}`)}>{t(`tools.text.align.${al}`)}</Btn>
        ))}
      </Field>
      <Color label={t('subtitles.textColor')} value={st.fill} onChange={(v) => up('fill', v)} />
      <Color label={t('tools.text.outline')} value={st.outline} onChange={(v) => up('outline', v)} />
      <Slider label={t('tools.text.outlineWidth')} value={st.outlineWidth} min={0} max={20} step={0.5} unit="px" onChange={(v) => up('outlineWidth', v)} />
      <Toggle label={t('subtitles.box')} value={st.box} onChange={(v) => up('box', v)} />
      {st.box && (
        <>
          <Color label={t('subtitles.boxColor')} value={st.boxColor} onChange={(v) => up('boxColor', v)} />
          <Slider label={t('subtitles.boxOpacity')} value={st.boxOpacity} min={0} max={1} step={0.01} display={100} unit="%" onChange={(v) => up('boxOpacity', v)} />
        </>
      )}
      <Field label={t('subtitles.position')}>
        <Select<SubtitleStyle['position']> value={st.position} onChange={(v) => up('position', v)}
          options={(['bottom', 'middle', 'top'] as const).map((value) => ({ value, label: t(`subtitles.positions.${value}`) }))} />
      </Field>
      {st.position !== 'middle' && (
        <Slider label={t('subtitles.margin')} value={st.margin} min={0} max={0.4} step={0.005} display={100} unit="%" onChange={(v) => up('margin', v)} />
      )}
      <Slider label={t('subtitles.lineWidth')} value={st.maxWidth} min={0.2} max={1} step={0.01} display={100} unit="%" onChange={(v) => up('maxWidth', v)} />
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
  const shown = (time: number) => (onTimeline ? timelineTimeOf(project, track, time) : time)
  const toTrack = (time: number) => (onTimeline ? trackTimeAt(project, track, time) : time)
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
      <span className="cue-index" title={overlap ? t('subtitles.overlap') : t('subtitles.jump')}>
        {overlap ? <Icon name="warn" size={12} /> : index + 1}
      </span>
      <div className="cue-times">
        <TimeInput value={shown(cue.start)} testId="cue-start" title={t('tools.start')}
          onCommit={(v) => updateCueAction(track.id, cue.id, { start: toTrack(v) })} />
        <TimeInput value={shown(cue.end)} testId="cue-end" title={t('tools.end')}
          onCommit={(v) => updateCueAction(track.id, cue.id, { end: toTrack(v) })} />
      </div>
      <textarea
        ref={textRef}
        className="cue-text"
        value={cue.text}
        placeholder={t('subtitles.placeholder')}
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
      <Btn small icon="trash" title={t('subtitles.deleteCue')} onClick={() => deleteCueAction(track.id, cue.id)} />
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
          <p className="dim">{tx('subtitles.emptyList', { keys: <b>{bindingFor('subtitles.add')}</b>, add: <b>{t('subtitles.add')}</b> })}</p>
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
  useT()
  const tracks = useStore((s) => s.project.subtitles)
  const activeId = useStore((s) => s.activeSubtitleTrack)
  const guide = useStore((s) => s.subtitleGuide)
  const exportRequest = useStore((s) => s.subtitleExportRequest)
  const track = tracks.find((tr) => tr.id === activeId) ?? tracks[0]
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
          <p>{t('subtitles.emptyTitle')}</p>
          <p className="dim">{t('subtitles.emptyHint')}</p>
          <div className="empty-actions">
            <Btn primary icon="plus" onClick={() => newSubtitleTrackAction()} testId="subtitle-create">{t('subtitles.newTrack')}</Btn>
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
            onChange={(e) => editSubtitleTrack(track.id, 'name', (tr) => { tr.name = e.target.value })} title={t('subtitles.trackName')} />
          <Select value={track.language} testId="subtitle-language" onChange={(v) => editSubtitleTrack(track.id, 'language', (tr) => { tr.language = v })}
            options={[...LANGUAGES, ...(LANGUAGES.includes(track.language) ? [] : [track.language])].map((code) => ({ value: code, label: subtitleLanguageName(code) }))} />
        </div>
        <div className="sub-row">
          <ImportMenu />
          <Btn small icon="export" onClick={() => setExporting(!exporting)} active={exporting} disabled={!track.cues.length} testId="subtitle-export">
            {t('subtitles.exportFile')}
          </Btn>
          {!onTimeline && (
            <Toggle label={t('subtitles.guide')} value={guide} onChange={(v) => set({ subtitleGuide: v })} />
          )}
        </div>
        {exporting && <ExportBox track={track} onClose={() => setExporting(false)} />}
        <StyleSection track={track} />
      </div>
      <div className="cue-toolbar">
        <span className="cue-count">{t('subtitles.count', { count: track.cues.length })}</span>
        <span className="toolbar-spacer" />
        <Btn small icon="plus" primary onClick={() => void addCueAction()} title={t('subtitles.addHint', { keys: bindingFor('subtitles.add') })} testId="cue-add">{t('subtitles.add')}</Btn>
        <Btn small onClick={() => setCueEdgeAction('start')} title={t('subtitles.setStartHint', { keys: bindingFor('subtitles.setStart') })}>{t('subtitles.setStart')}</Btn>
        <Btn small onClick={() => setCueEdgeAction('end')} title={t('subtitles.setEndHint', { keys: bindingFor('subtitles.setEnd') })}>{t('subtitles.setEnd')}</Btn>
      </div>
      <CueList track={track} />
    </div>
  )
}

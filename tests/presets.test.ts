// Preset logic: what a preset saves, how its media is matched in another project, and how it is placed.
import { describe, expect, test } from 'vitest'
import { makeEffect } from '@shared/effects'
import { type MediaItem, type Project, makeSubtitleTrack, newProject, uid } from '@shared/model'
import { applyPreset, makePreset, matchPresetMedia, parsePreset, presetLength } from '@shared/presets'
import { addSubtitleClip, addTextClip, placeMedia } from '@shared/timeline-ops'

function media(name: string, kind: MediaItem['kind'] = 'video', audio = 1): MediaItem {
  return {
    id: uid('m'), kind, name, path: `C:\\Footage\\${name}`, relPath: `Footage/${name}`, size: 1000, mtimeMs: 0,
    duration: kind === 'image' ? 0 : 10, width: 1920, height: 1080, fps: 30, animated: false, hasAlpha: false,
    audioStreams: Array.from({ length: kind === 'image' ? 0 : audio }, (_, i) => ({ index: i, codec: 'aac', channels: 2, sampleRate: 48000, title: `Audio ${i + 1}` }))
  }
}

/** A project with a video (two audio tracks, linked), a text clip with a mask image, a subtitle clip and an unrelated clip. */
function source() {
  const p = newProject()
  const take = media('take.mp4', 'video', 2)
  const mask = media('mask.png', 'image')
  const other = media('other.mp4')
  p.media.push(take, mask, other)
  const videoIds = placeMedia(p, take, 5)
  const textId = addTextClip(p, 7, { content: 'Title' })
  const text = p.clips.find((c) => c.id === textId)!
  const fx = makeEffect('imageMask')
  fx.params.image = mask.id
  text.effects.push(fx, makeEffect('blur'))
  const subs = makeSubtitleTrack('Lines')
  subs.cues.push({ id: 'q1', start: 6, end: 8, text: 'Hello' })
  p.subtitles.push(subs)
  const subId = addSubtitleClip(p, subs.id)!
  const otherIds = placeMedia(p, other, 30)
  return { p, take, mask, other, videoIds, textId, subId, otherIds }
}

describe('saving', () => {
  test('a preset keeps the selected clips, the clips linked to them, and what they use', () => {
    const { p, take, mask, videoIds, textId, subId } = source()
    const preset = makePreset(p, [videoIds[0], textId, subId], 'Intro')!
    expect(preset.name).toBe('Intro')
    // The video brings its two linked audio clips.
    expect(preset.clips.length).toBe(1 + 2 + 1 + 1)
    expect(preset.media.map((m) => m.name).sort()).toEqual([mask.name, take.name].sort())
    expect(preset.media.every((m) => m.relPath === undefined)).toBe(true)
    expect(preset.subtitles.map((s) => s.name)).toEqual(['Lines'])
    expect(preset.origin).toBe(5)
    expect(presetLength(preset)).toBeCloseTo(10)
  })

  test('nothing selected makes no preset', () => {
    expect(makePreset(newProject(), [], 'x')).toBeNull()
  })

  test('survives being written to disk and read back', () => {
    const { p, videoIds } = source()
    const preset = makePreset(p, videoIds, 'Take')!
    expect(parsePreset(JSON.parse(JSON.stringify(preset)))).toEqual(preset)
    expect(parsePreset({ hello: 1 })).toBeNull()
    expect(parsePreset({ ...preset, version: 99 })).toBeNull()
  })
})

describe('using a preset in another project', () => {
  test('files are matched by path, ignoring case and slash direction', () => {
    const { p, videoIds, textId } = source()
    const preset = makePreset(p, [...videoIds, textId], 'Intro')!
    const q = newProject()
    const already = { ...media('take.mp4'), id: 'm-here', path: 'c:/footage/TAKE.mp4' }
    q.media.push(already)
    const { found, needed } = matchPresetMedia(q, preset)
    expect([...found.values()]).toEqual(['m-here'])
    expect(needed.map((m) => m.name)).toEqual(['mask.png'])
  })

  test('clips land at the playhead keeping their spacing, links, effects and subtitles', () => {
    const { p, take, mask, videoIds, textId, subId } = source()
    const preset = makePreset(p, [videoIds[0], textId, subId], 'Intro')!
    const q: Project = newProject()
    const takeHere = { ...take, id: 'm-take' }
    const maskHere = { ...mask, id: 'm-mask' }
    q.media.push(takeHere, maskHere)
    const map = new Map([[take.id, takeHere.id], [mask.id, maskHere.id]])
    const created = applyPreset(q, preset, 100, map)
    expect(created.length).toBe(5)
    const placed = q.clips.filter((c) => created.includes(c.id))
    // Original starts 5 (video), 7 (text), 6 (subtitles) -> 100, 102, 101.
    expect(placed.filter((c) => c.type === 'video').map((c) => c.start)).toEqual([100])
    expect(placed.find((c) => c.type === 'text')!.start).toBe(102)
    expect(placed.find((c) => c.type === 'subtitles')!.start).toBe(101)
    // The video and its audio are linked to each other, with a new link id.
    const video = placed.find((c) => c.type === 'video')!
    const audio = placed.filter((c) => c.type === 'audio')
    expect(video.linkId).toBeTruthy()
    expect(audio.every((c) => c.linkId === video.linkId && c.mediaId === 'm-take')).toBe(true)
    expect(video.linkId).not.toBe(p.clips.find((c) => c.id === videoIds[0])!.linkId)
    // The mask points at this project's copy of the image; effects get new ids.
    const text = placed.find((c) => c.type === 'text')!
    expect(text.effects.map((e) => e.type)).toEqual(['imageMask', 'blur'])
    expect(text.effects[0].params.image).toBe('m-mask')
    // Subtitles come along as a new track.
    expect(q.subtitles.length).toBe(1)
    const sub = placed.find((c) => c.type === 'subtitles')!
    expect(sub.subtitleTrackId).toBe(q.subtitles[0].id)
    expect(q.subtitles[0].id).not.toBe(p.subtitles[0].id)
    expect(q.subtitles[0].cues[0].text).toBe('Hello')
  })

  test('clips whose file was not imported are left out, and a missing mask image is cleared', () => {
    const { p, take, videoIds, textId } = source()
    const preset = makePreset(p, [videoIds[0], textId], 'Intro')!
    const q = newProject()
    q.media.push({ ...take, id: 'm-take' })
    const created = applyPreset(q, preset, 0, new Map([[take.id, 'm-take']]))
    expect(created.length).toBe(4)
    expect(q.clips.find((c) => c.type === 'text')!.effects[0].params.image).toBe('')
    // With none of its files, only the text clip is placed.
    const r = newProject()
    expect(applyPreset(r, preset, 0, new Map()).length).toBe(1)
  })

  test('applying twice makes independent copies', () => {
    const { p, textId } = source()
    const preset = makePreset(p, [textId], 'Title')!
    const q = newProject()
    const a = applyPreset(q, preset, 0, new Map())
    const b = applyPreset(q, preset, 0, new Map())
    expect(new Set([...a, ...b]).size).toBe(2)
    // The second copy cannot overlap the first on the same track.
    const [ca, cb] = [a[0], b[0]].map((id) => q.clips.find((c) => c.id === id)!)
    expect(ca.trackId).not.toBe(cb.trackId)
    expect(ca.effects[0].id).not.toBe(cb.effects[0].id)
  })
})

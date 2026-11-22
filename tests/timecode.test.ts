/*
 * Copyright (C) 2026 Lorekeeper49
 *
 * This file is part of ClipWorld.
 *
 * ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
 * General Public License as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with ClipWorld. If not,
 * see <https://www.gnu.org/licenses/>.
 */

// Reading times typed into the timeline's "go to" box, and placing a voiceover take.
import { describe, expect, it } from 'vitest'
import { type MediaItem, newProject } from '../src/shared/model'
import { formatTime, parseTime } from '../src/shared/timecode'
import { placeAudioClip } from '../src/shared/timeline-ops'

describe('parseTime', () => {
  it('reads seconds', () => {
    expect(parseTime('90')).toBe(90)
    expect(parseTime('12.5')).toBe(12.5)
    expect(parseTime('12,5')).toBe(12.5)
    expect(parseTime(' .5 ')).toBe(0.5)
  })

  it("reads the preview's mm:ss:ff and hh:mm:ss:ff, counting frames at the project's rate", () => {
    expect(parseTime('01:30:15', 30)).toBeCloseTo(90.5)
    expect(parseTime('00:00:12', 24)).toBeCloseTo(0.5)
    expect(parseTime('01:00:00:00', 30)).toBe(3600)
    expect(parseTime('1:02:03:06', 60)).toBeCloseTo(3723.1)
  })

  it('reads mm:ss, and fields that run over', () => {
    expect(parseTime('1:30')).toBe(90)
    expect(parseTime('0:90')).toBe(90)
    expect(parseTime('2:05.25')).toBe(125.25)
  })

  it('accepts full-width colons and commas typed with a Japanese keyboard', () => {
    expect(parseTime('１:３０'.normalize('NFKC'))).toBe(90)
    expect(parseTime('01：30：15')).toBeCloseTo(90.5)
  })

  it('turns down anything else', () => {
    for (const bad of ['', 'abc', '-5', '1:2:3:4:5', '1::2', '1.5:20', '12s', '1e3']) expect(parseTime(bad), bad).toBeNull()
  })

  it('reads back what the preview shows', () => {
    for (const t of [0, 1 / 30, 59.9, 61.5, 3599.9667, 3725.5]) {
      const shown = formatTime(t, 30)
      expect(parseTime(shown, 30), shown).toBeCloseTo(Math.floor(t * 30 + 1e-6) / 30, 6)
    }
  })
})

describe('placeAudioClip', () => {
  const take: MediaItem = {
    id: 'vo', kind: 'audio', name: 'Voiceover.wav', path: 'Voiceover.wav', size: 1, mtimeMs: 0, duration: 10, width: 0, height: 0, fps: 0,
    animated: false, hasAlpha: false, audioStreams: [{ index: 0, codec: 'pcm_s16le', channels: 1, sampleRate: 48000, title: '' }]
  }

  it('skips the lead-in and lands on a free audio track', () => {
    const p = newProject()
    p.media.push(take)
    const first = placeAudioClip(p, take, 2, 0.3, 'Voiceover')
    const c = p.clips.find((x) => x.id === first)!
    expect([c.start, c.srcIn, c.duration, c.name]).toEqual([2, 0.3, 9.7, 'Voiceover'])
    // A second take over the same time goes on another track.
    const secondId = placeAudioClip(p, take, 3, 0)
    const second = p.clips.find((x) => x.id === secondId)!
    expect(second.trackId).not.toBe(c.trackId)
    expect(p.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
  })
})

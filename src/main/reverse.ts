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

// Reversed clips for an export: each clip's source is rendered backwards, piece by piece, into files the
// export then reads as one stream. One piece is reversed at a time (ffmpeg keeps whatever it reverses in
// memory), so a clip of any length needs only a few hundred megabytes. No Electron imports.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reversePieceChains, reversePieceInput, reversePieceSize, reverseRate } from '@shared/filtergraph'
import { CONTAINER_MAP, type ExportSettings } from '@shared/formats'
import { reversePieces } from '@shared/loop'
import { type Clip, type MediaItem, type Project, reversible } from '@shared/model'
import { ffmpeg } from './ffmpeg'

interface Work {
  clip: Clip
  media: MediaItem
  kind: 'v' | 'a'
}

/** The reversed clips an export will use, and which of their streams. */
function reversedWork(p: Project, settings: ExportSettings): Work[] {
  const container = CONTAINER_MAP[settings.container]
  const hidden = new Set(p.tracks.filter((t) => t.hidden).map((t) => t.id))
  const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id))
  const out: Work[] = []
  for (const c of p.clips) {
    const media = p.media.find((m) => m.id === c.mediaId)
    if (!c.reverse || !media || !reversible(c, media)) continue
    if (c.type === 'video' && container?.video.length && !hidden.has(c.trackId)) out.push({ clip: c, media, kind: 'v' })
    if (
      c.type === 'audio' && container?.audio.length && !muted.has(c.trackId) && !c.muted && c.volume > 0 &&
      media.audioStreams.some((a) => a.index === c.audioStream)
    ) {
      out.push({ clip: c, media, kind: 'a' })
    }
  }
  return out
}

/** How much reversing an export needs, in seconds of source (for splitting the progress bar). */
export function reversedSeconds(p: Project, settings: ExportSettings): number {
  return reversedWork(p, settings).reduce((sum, w) => sum + w.clip.duration * w.clip.speed, 0)
}

const ffconcatPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`

/**
 * Renders every reversed clip's pieces into `dir` and returns, by clip id, the ffconcat list of each
 * reversed stream (assets.reversed). `encoders` decides how pictures are kept: lossy-but-transparent RGB
 * H.264 when available, otherwise lossless FFV1.
 */
export async function renderReversed(
  p: Project, settings: ExportSettings, dir: string, encoders: string[],
  onProgress: (fraction: number) => void, signal?: AbortSignal
): Promise<Record<string, { v?: string; a?: string }>> {
  const work = reversedWork(p, settings)
  const jobs: { file: string; args: string[]; seconds: number }[] = []
  const lists: Record<string, { v?: string; a?: string }> = {}
  work.forEach((w, n) => {
    const rate = reverseRate(w.media, w.kind)
    const pieces = reversePieces(w.clip, w.media.duration, rate, reversePieceSize(w.media, w.kind))
    const rows = ['ffconcat version 1.0']
    pieces.forEach((pc, k) => {
      const file = join(dir, `reverse_${n}_${w.kind}_${String(k).padStart(5, '0')}.nut`)
      const args = ['-loglevel', 'error', '-y', '-threads', '4', ...reversePieceInput(w.kind, w.media, pc.src, pc.count)]
      if (pc.mix) args.push('-threads', '4', ...reversePieceInput(w.kind, w.media, pc.mix.src, pc.count))
      const input = (i: number) => (w.kind === 'v' ? `[${i}:v]` : `[${i}:a:${w.clip.audioStream}]`)
      let counter = 0
      const chains = reversePieceChains(w.kind, w.media, pc, input(0), pc.mix ? input(1) : null, '[out]', () => `[r${counter++}]`)
      args.push('-filter_complex', chains.join(';'), '-map', '[out]')
      if (w.kind === 'a') args.push('-c:a', 'pcm_f32le')
      else if (!w.media.hasAlpha && encoders.includes('libx264rgb')) args.push('-c:v', 'libx264rgb', '-preset', 'veryfast', '-crf', '10')
      else args.push('-c:v', 'ffv1', '-level', '3')
      args.push('-f', 'nut', file)
      jobs.push({ file, args, seconds: pc.count / rate })
      rows.push(`file ${ffconcatPath(file)}`, `duration ${(pc.count / rate).toFixed(9)}`)
    })
    const list = join(dir, `reverse_${n}_${w.kind}.ffconcat`)
    writeFileSync(list, rows.join('\n') + '\n', 'utf8')
    lists[w.clip.id] = { ...lists[w.clip.id], [w.kind]: list }
  })
  const total = jobs.reduce((s, j) => s + j.seconds, 0) || 1
  let done = 0
  let next = 0
  // A failed piece stops the other runs too.
  const stop = new AbortController()
  const sig = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  // Two at a time: each run decodes from the keyframe before its piece, so a little overlap pays off.
  await Promise.all(
    Array.from({ length: Math.min(2, jobs.length) }, async () => {
      while (next < jobs.length && !sig.aborted) {
        const job = jobs[next++]
        try {
          await ffmpeg(job.args, { signal: sig })
        } catch (err) {
          stop.abort()
          throw err
        }
        done += job.seconds
        onProgress(Math.min(1, done / total))
      }
    })
  )
  if (signal?.aborted) throw new Error('cancelled')
  return lists
}

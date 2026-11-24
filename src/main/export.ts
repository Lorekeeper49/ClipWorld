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

// Runs an export: prepares assets, writes the filter script, spawns ffmpeg. No Electron imports.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EFFECT_MAP, encodeWav, n, reverbImpulse } from '@shared/effects'
import { type Caps, type ExportAssets, buildExport } from '@shared/filtergraph'
import type { ExportSettings } from '@shared/formats'
import { type Project, projectDuration } from '@shared/model'
import { ffmpegProgress } from './ffmpeg'
import { renderReversed, reversedSeconds } from './reverse'

export interface ExportJob {
  project: Project
  settings: ExportSettings
  outPath: string
  /** Directory for intermediate files; removed when the job ends. */
  tmpDir: string
  caps: Caps
  /** Assets rasterised by the renderer (text, overlays). Reverb responses are generated here. */
  assets?: Partial<ExportAssets>
  /** Subtitle clips to burn in, with their cue images already written to disk. */
  subtitleClips?: SubtitleClipAsset[]
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  keepTmp?: boolean
}

export interface SubtitleClipAsset {
  clipId: string
  /** Frame size (project pixels) and raster scale of the cue images. */
  w: number
  h: number
  k: number
  /** Clip length on the timeline, seconds. */
  duration: number
  /** Fully transparent image of the same size, shown between cues. */
  gap: string
  /** Cue images in clip-local timeline seconds. */
  cues: { image: string; start: number; end: number }[]
}

const ffconcatPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
const sec = (v: number) => v.toFixed(6)

/**
 * Writes the ffconcat list that plays a subtitle clip as one image stream: each cue's image for its
 * duration and the transparent gap image in between, covering exactly the clip's length. A later cue
 * cuts an overlapping earlier one short.
 */
export function writeSubtitleList(file: string, a: SubtitleClipAsset): void {
  const rows = ['ffconcat version 1.0']
  const push = (image: string, d: number) => {
    if (d <= 1e-6) return
    rows.push(`file ${ffconcatPath(image)}`, `duration ${sec(d)}`)
  }
  const cues = a.cues
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(a.duration, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((x, y) => x.start - y.start)
  let t = 0
  let last = a.gap
  cues.forEach((c, i) => {
    const end = Math.min(c.end, cues[i + 1]?.start ?? Infinity)
    if (c.start > t) push(a.gap, c.start - t)
    const from = Math.max(t, c.start)
    push(c.image, end - from)
    t = Math.max(t, end)
    last = c.image
  })
  if (a.duration > t) {
    push(a.gap, a.duration - t)
    last = a.gap
  }
  // The concat demuxer ignores the duration of the final entry, so the last file is listed again.
  rows.push(`file ${ffconcatPath(last)}`)
  writeFileSync(file, rows.join('\n') + '\n', 'utf8')
}

export async function runExport(job: ExportJob): Promise<{ args: string[]; filter: string }> {
  mkdirSync(job.tmpDir, { recursive: true })
  try {
    const assets: ExportAssets = {
      text: job.assets?.text ?? {},
      overlays: job.assets?.overlays ?? {},
      irs: { ...(job.assets?.irs ?? {}) },
      subtitles: { ...(job.assets?.subtitles ?? {}) },
      pluginFilters: job.assets?.pluginFilters ?? {}
    }
    for (const s of job.subtitleClips ?? []) {
      const list = join(job.tmpDir, `subs_${s.clipId}.ffconcat`)
      writeSubtitleList(list, s)
      assets.subtitles[s.clipId] = { path: list, w: s.w, h: s.h, k: s.k }
    }
    for (const c of job.project.clips) {
      if (c.type !== 'audio') continue
      for (const e of c.effects) {
        if (!e.enabled || e.type !== 'reverb' || !EFFECT_MAP.reverb) continue
        const file = join(job.tmpDir, `ir_${e.id}.wav`)
        writeFileSync(file, encodeWav(reverbImpulse(n(e, 'size'), n(e, 'mix'))))
        assets.irs[e.id] = file
      }
    }
    // Reversed clips are rendered backwards first; the progress bar shares out the time by seconds of work.
    const progress = job.onProgress ?? (() => {})
    const reversing = reversedSeconds(job.project, job.settings)
    const share = reversing > 0 ? reversing / (reversing + projectDuration(job.project)) : 0
    if (reversing > 0) {
      assets.reversed = await renderReversed(job.project, job.settings, job.tmpDir, job.caps.encoders, (f) => progress(f * share), job.signal)
    }
    const built = buildExport(job.project, job.settings, assets, job.caps)
    const script = join(job.tmpDir, 'graph.txt')
    writeFileSync(script, built.filter, 'utf8')
    const args = ['-y', ...built.inputArgs, '-/filter_complex', script, ...built.outputArgs, job.outPath]
    await ffmpegProgress(args, built.duration, (f) => progress(share + (1 - share) * f), job.signal)
    return { args, filter: built.filter }
  } catch (err) {
    if (job.signal?.aborted) rmSync(job.outPath, { force: true })
    throw err
  } finally {
    if (!job.keepTmp) rmSync(job.tmpDir, { recursive: true, force: true })
  }
}

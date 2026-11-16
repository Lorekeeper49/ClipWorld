// Runs an export: prepares assets, writes the filter script, spawns ffmpeg. No Electron imports.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EFFECT_MAP, encodeWav, n, reverbImpulse } from '@shared/effects'
import { type Caps, type ExportAssets, buildExport } from '@shared/filtergraph'
import type { ExportSettings } from '@shared/formats'
import type { Project } from '@shared/model'
import { ffmpegProgress } from './ffmpeg'

export interface ExportJob {
  project: Project
  settings: ExportSettings
  outPath: string
  /** Directory for intermediate files; removed when the job ends. */
  tmpDir: string
  caps: Caps
  /** Assets rasterised by the renderer (text, overlays). Reverb responses are generated here. */
  assets?: Partial<ExportAssets>
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  keepTmp?: boolean
}

export async function runExport(job: ExportJob): Promise<{ args: string[]; filter: string }> {
  mkdirSync(job.tmpDir, { recursive: true })
  try {
    const assets: ExportAssets = {
      text: job.assets?.text ?? {},
      overlays: job.assets?.overlays ?? {},
      irs: { ...(job.assets?.irs ?? {}) }
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
    const built = buildExport(job.project, job.settings, assets, job.caps)
    const script = join(job.tmpDir, 'graph.txt')
    writeFileSync(script, built.filter, 'utf8')
    const args = ['-y', ...built.inputArgs, '-/filter_complex', script, ...built.outputArgs, job.outPath]
    await ffmpegProgress(args, built.duration, job.onProgress ?? (() => {}), job.signal)
    return { args, filter: built.filter }
  } catch (err) {
    if (job.signal?.aborted) rmSync(job.outPath, { force: true })
    throw err
  } finally {
    if (!job.keepTmp) rmSync(job.tmpDir, { recursive: true, force: true })
  }
}

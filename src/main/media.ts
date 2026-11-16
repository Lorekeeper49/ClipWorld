// Prepares preview assets for imported media: extracted audio tracks, waveform peaks, thumbnails
// and proxies. Results are cached on disk keyed by the source file's path, size and mtime.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Filmstrip, type MediaCache, PEAKS_PER_SECOND } from '@shared/ipc'
import type { MediaItem } from '@shared/model'
import { ffmpeg, ffmpegProgress } from './ffmpeg'
import { allowFile, allowRoot, mediaUrl } from './protocol'

type Emit = (mediaId: string, patch: Partial<MediaCache>) => void

let cacheRoot = ''
let emit: Emit = () => {}
const states = new Map<string, MediaCache>()
const items = new Map<string, MediaItem>()

export function initMediaCache(root: string, onUpdate: Emit): void {
  cacheRoot = root
  emit = onUpdate
  mkdirSync(root, { recursive: true })
  allowRoot(root)
}

// ---------------------------------------------------------------- job queue

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0
const MAX_PARALLEL = 2
const inFlight = new Set<string>()

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift()!
    running++
    job().finally(() => {
      running--
      pump()
    })
  }
}

/** Runs `work` unless `out` already exists. Work writes to a temp file that is renamed on success. */
function cached(out: string, work: (tmp: string) => Promise<void>, front = false): Promise<boolean> {
  if (existsSync(out)) return Promise.resolve(true)
  if (inFlight.has(out)) return Promise.resolve(false)
  inFlight.add(out)
  return new Promise((resolve) => {
    const job: Job = async () => {
      const dot = out.lastIndexOf('.')
      const tmp = `${out.slice(0, dot)}.part${out.slice(dot)}`
      try {
        await work(tmp)
        renameSync(tmp, out)
        resolve(true)
      } catch (err) {
        rmSync(tmp, { force: true })
        console.error(`[media] ${out}:`, (err as Error).message)
        resolve(false)
      } finally {
        inFlight.delete(out)
      }
    }
    if (front) queue.unshift(job)
    else queue.push(job)
    pump()
  })
}

// ---------------------------------------------------------------- helpers

function dirFor(m: MediaItem): string {
  const key = createHash('sha1').update(`${m.path}|${m.size}|${Math.round(m.mtimeMs)}`).digest('hex').slice(0, 20)
  const dir = join(cacheRoot, key)
  mkdirSync(dir, { recursive: true })
  return dir
}

function update(id: string, patch: Partial<MediaCache>): void {
  const cur = states.get(id)
  if (!cur) return
  const next: MediaCache = {
    ...cur,
    ...patch,
    audioUrls: { ...cur.audioUrls, ...(patch.audioUrls ?? {}) },
    peakUrls: { ...cur.peakUrls, ...(patch.peakUrls ?? {}) }
  }
  states.set(id, next)
  emit(id, patch)
}

const q = ['-loglevel', 'error', '-y']

async function extractAudio(m: MediaItem, index: number, out: string): Promise<void> {
  const s = m.audioStreams[index]
  const copy = s.codec === 'aac' && s.channels <= 2
  await ffmpeg([
    ...q, '-i', m.path, '-map', `0:a:${index}`, '-vn', '-sn', '-dn',
    ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
    '-movflags', '+faststart', '-f', 'mp4', out
  ])
}

/** One byte per 1/PEAKS_PER_SECOND s: the peak absolute amplitude of a mono mixdown. */
async function writePeaks(m: MediaItem, index: number, out: string): Promise<void> {
  const rate = 8000
  const window = rate / PEAKS_PER_SECOND
  const peaks: number[] = []
  let carry: Buffer | null = null
  let count = 0
  let peak = 0
  await ffmpeg(
    [...q, '-i', m.path, '-map', `0:a:${index}`, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
    {
      binary: (chunk) => {
        const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
        const usable = buf.length - (buf.length % 2)
        for (let i = 0; i < usable; i += 2) {
          const v = Math.abs(buf.readInt16LE(i))
          if (v > peak) peak = v
          if (++count === window) {
            peaks.push(Math.min(255, Math.round((peak / 32768) * 255)))
            count = 0
            peak = 0
          }
        }
        carry = usable < buf.length ? buf.subarray(usable) : null
      }
    }
  )
  if (count > 0) peaks.push(Math.min(255, Math.round((peak / 32768) * 255)))
  writeFileSync(out, Buffer.from(peaks))
}

function filmstripLayout(m: MediaItem): Filmstrip & { interval: number } {
  const tileH = 54
  const tileW = Math.max(2, Math.round((tileH * (m.width || 16)) / (m.height || 9) / 2) * 2)
  const count = Math.max(1, Math.min(120, Math.ceil(m.duration / 2)))
  return { url: '', count, tileW, tileH, interval: m.duration / count }
}

async function writeFilmstrip(m: MediaItem, out: string): Promise<void> {
  const f = filmstripLayout(m)
  // Long files: decode keyframes only, which is plenty for thumbnails and far faster.
  const fast = m.duration > 120 ? ['-skip_frame', 'nokey'] : []
  await ffmpeg([
    ...q, ...fast, '-i', m.path, '-map', '0:v:0', '-an', '-sn',
    '-vf', `fps=${f.count}/${m.duration.toFixed(3)},scale=${f.tileW}:${f.tileH},tile=${f.count}x1`,
    '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', out
  ])
}

async function writePoster(m: MediaItem, out: string): Promise<void> {
  const at = Math.min(1, m.duration * 0.1)
  await ffmpeg([
    ...q, '-ss', at.toFixed(3), '-i', m.path, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=320:-2', '-q:v', '4', '-f', 'mjpeg', out
  ])
}

// ---------------------------------------------------------------- public API

/** Starts preparing a media item. Safe to call repeatedly; finished work is reused from the cache. */
export function prepareMedia(m: MediaItem): void {
  items.set(m.id, m)
  let stat
  try {
    stat = statSync(m.path)
  } catch {
    states.set(m.id, { sourceUrl: '', audioUrls: {}, peakUrls: {}, missing: true })
    emit(m.id, states.get(m.id)!)
    return
  }
  allowFile(m.path)
  const dir = dirFor(m)
  const sourceUrl = mediaUrl(m.path, stat.mtimeMs)
  states.set(m.id, { sourceUrl, audioUrls: {}, peakUrls: {}, missing: false })
  emit(m.id, states.get(m.id)!)

  if (m.kind === 'image') {
    update(m.id, { posterUrl: sourceUrl })
    if (m.animated) void makeProxy(m)
    return
  }

  for (const s of m.audioStreams) {
    const audio = join(dir, `audio_${s.index}.m4a`)
    void cached(audio, (tmp) => extractAudio(m, s.index, tmp), true).then((ok) => {
      if (ok) update(m.id, { audioUrls: { [s.index]: mediaUrl(audio) } })
    })
    const peaks = join(dir, `peaks_${s.index}.bin`)
    void cached(peaks, (tmp) => writePeaks(m, s.index, tmp)).then((ok) => {
      if (ok) update(m.id, { peakUrls: { [s.index]: mediaUrl(peaks) } })
    })
  }

  if (m.kind === 'video') {
    const poster = join(dir, 'poster.jpg')
    void cached(poster, (tmp) => writePoster(m, tmp), true).then((ok) => {
      if (ok) update(m.id, { posterUrl: mediaUrl(poster) })
    })
    const strip = join(dir, 'filmstrip.jpg')
    void cached(strip, (tmp) => writeFilmstrip(m, tmp)).then((ok) => {
      if (!ok) return
      const { count, tileW, tileH } = filmstripLayout(m)
      update(m.id, { filmstrip: { url: mediaUrl(strip), count, tileW, tileH } })
    })
    // A proxy made in an earlier session is used straight away.
    const proxy = join(dir, 'proxy.mp4')
    if (existsSync(proxy)) update(m.id, { proxyUrl: mediaUrl(proxy), proxyState: 'ready' })
  }
}

/**
 * Builds a proxy the preview can decode: seek-friendly H.264 for video, VP9 with alpha for GIFs.
 * Requested by the renderer when Chromium cannot play the original.
 */
export async function makeProxy(m: MediaItem): Promise<void> {
  const dir = dirFor(m)
  const alpha = m.kind === 'image'
  const out = join(dir, alpha ? 'proxy.webm' : 'proxy.mp4')
  if (existsSync(out)) {
    update(m.id, { proxyUrl: mediaUrl(out), proxyState: 'ready' })
    return
  }
  if (inFlight.has(out)) return
  update(m.id, { proxyState: 'pending', proxyProgress: 0 })
  let last = 0
  const ok = await cached(
    out,
    (tmp) =>
      ffmpegProgress(
        alpha
          ? [...q, '-i', m.path, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
              '-auto-alt-ref', '0', '-row-mt', '1', '-cpu-used', '5', '-f', 'webm', tmp]
          : [...q, '-i', m.path, '-map', '0:v:0', '-an', '-sn', '-vf', "scale=-2:'min(720,ih)',format=yuv420p",
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '30', '-movflags', '+faststart', '-f', 'mp4', tmp],
        m.duration,
        (f) => {
          if (f - last >= 0.02) {
            last = f
            update(m.id, { proxyProgress: f })
          }
        }
      ),
    true
  )
  update(m.id, ok ? { proxyUrl: mediaUrl(out), proxyState: 'ready', proxyProgress: 1 } : { proxyState: 'error' })
}

export function requestProxy(mediaId: string): void {
  const m = items.get(mediaId)
  if (m) void makeProxy(m)
}

export function forgetMedia(mediaId: string): void {
  items.delete(mediaId)
  states.delete(mediaId)
}

// Prepares preview assets for imported media: extracted audio tracks, waveform peaks, thumbnails
// and fast-seek preview copies. Results are cached on disk keyed by the source file's path, size and
// mtime. Large sources are read as few times as possible: all audio tracks come out of one pass,
// waveforms are computed from the (small) extracted tracks, and thumbnails of long videos are
// grabbed with keyframe seeks instead of a full read.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, sep } from 'node:path'
import { type Filmstrip, type MediaCache, PEAKS_PER_SECOND, type ProxyChunks, chunkName } from '@shared/ipc'
import type { MediaItem } from '@shared/model'
import { ffmpeg, ffmpegProgress } from './ffmpeg'
import { probeKeyframeInterval } from './probe'
import { SCHEME, allowFile, allowRoot, mediaUrl } from './protocol'

type Emit = (mediaId: string, patch: Partial<MediaCache>) => void

let cacheRoot = ''
let emit: Emit = () => {}
const states = new Map<string, MediaCache>()
const items = new Map<string, MediaItem>()
/** Aborts every background ffmpeg process when the app quits. */
let bgAbort = new AbortController()

export function initMediaCache(root: string, onUpdate: Emit): void {
  cacheRoot = root
  emit = onUpdate
  mkdirSync(root, { recursive: true })
  allowRoot(root)
}

export function stopBackgroundWork(): void {
  bgAbort.abort()
  bgAbort = new AbortController()
}

// ---------------------------------------------------------------- job queue (small jobs)

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0
const MAX_PARALLEL = 3
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

const partName = (out: string): string => {
  const dot = out.lastIndexOf('.')
  return `${out.slice(0, dot)}.part${out.slice(dot)}`
}

/**
 * Deletes a cache file or folder. On Windows a file that was just closed can stay locked for a moment
 * (antivirus, indexing, sync clients), so this retries, and a leftover never fails the job.
 */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  } catch (err) {
    console.warn(`[media] could not remove ${path}:`, (err as Error).message)
  }
}

/** Runs `work` unless `out` already exists. Work writes to a temp file that is renamed on success. */
function cached(out: string, work: (tmp: string) => Promise<void>, front = false): Promise<boolean> {
  if (existsSync(out)) return Promise.resolve(true)
  if (inFlight.has(out)) return Promise.resolve(false)
  inFlight.add(out)
  return new Promise((resolve) => {
    const job: Job = async () => {
      const tmp = partName(out)
      try {
        await work(tmp)
        renameSync(tmp, out)
        resolve(true)
      } catch (err) {
        remove(tmp)
        if (!bgAbort.signal.aborted) console.error(`[media] ${out}:`, (err as Error).message)
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
const bg = () => ({ lowPriority: true, signal: bgAbort.signal })
const audioPath = (dir: string, index: number) => join(dir, `audio_${index}.m4a`)

/** Extracts every missing audio track in a single read of the source file. */
async function extractAllAudio(m: MediaItem, dir: string): Promise<void> {
  const missing = m.audioStreams.filter((s) => !existsSync(audioPath(dir, s.index)))
  if (!missing.length) return
  const args = [...q, '-i', m.path]
  for (const s of missing) {
    const copy = s.codec === 'aac' && s.channels <= 2
    args.push(
      '-map', `0:a:${s.index}`, '-vn', '-sn', '-dn',
      ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
      '-movflags', '+faststart', '-f', 'mp4', partName(audioPath(dir, s.index))
    )
  }
  let last = 0
  try {
    await ffmpegProgress(args, m.duration, (f) => {
      if (f - last >= 0.01 || f === 1) {
        last = f
        update(m.id, { audioProgress: f })
      }
    }, bgAbort.signal, true)
    for (const s of missing) renameSync(partName(audioPath(dir, s.index)), audioPath(dir, s.index))
  } finally {
    for (const s of missing) remove(partName(audioPath(dir, s.index)))
  }
}

/** One byte per 1/PEAKS_PER_SECOND s: the peak absolute amplitude of a mono mixdown. */
async function writePeaks(input: string, out: string): Promise<void> {
  const rate = 8000
  const window = rate / PEAKS_PER_SECOND
  const peaks: number[] = []
  let carry: Buffer | null = null
  let count = 0
  let peak = 0
  await ffmpeg(
    [...q, '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'],
    {
      // Normal priority: waveforms are short jobs the timeline needs, and must not starve behind
      // the low-priority preview-chunk encoders.
      signal: bgAbort.signal,
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

function filmstripLayout(m: MediaItem): Filmstrip {
  const tileH = 54
  const tileW = Math.max(2, Math.round((tileH * (m.width || 16)) / (m.height || 9) / 2) * 2)
  const count = Math.max(1, Math.min(120, Math.ceil(m.duration / 2)))
  return { url: '', count, tileW, tileH }
}

/** Long videos: grab each tile with a keyframe seek (reads a few MB each) instead of reading the whole file. */
const SEEK_FILMSTRIP_AFTER = 600

async function writeFilmstrip(m: MediaItem, out: string): Promise<void> {
  const f = filmstripLayout(m)
  if (m.duration <= SEEK_FILMSTRIP_AFTER) {
    await ffmpeg([
      ...q, ...(m.duration > 120 ? ['-skip_frame', 'nokey'] : []), '-i', m.path, '-map', '0:v:0', '-an', '-sn',
      '-vf', `fps=${f.count}/${m.duration.toFixed(3)},scale=${f.tileW}:${f.tileH},tile=${f.count}x1`,
      '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', out
    ], bg())
    return
  }
  const tiles = join(out + '.tiles')
  remove(tiles)
  mkdirSync(tiles, { recursive: true })
  try {
    const grab = async (i: number) => {
      const t = ((i + 0.5) * m.duration) / f.count
      await ffmpeg([
        ...q, '-noaccurate_seek', '-ss', t.toFixed(3), '-i', m.path, '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale=${f.tileW}:${f.tileH}`, '-q:v', '5', join(tiles, `${String(i).padStart(4, '0')}.jpg`)
      ], bg()).catch(async () => {
        // Past the last keyframe or unreadable: a black tile keeps the strip aligned.
        await ffmpeg([...q, '-f', 'lavfi', '-i', `color=c=black:s=${f.tileW}x${f.tileH}`, '-frames:v', '1',
          join(tiles, `${String(i).padStart(4, '0')}.jpg`)], bg())
      })
    }
    let next = 0
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < f.count && !bgAbort.signal.aborted) await grab(next++)
      })
    )
    await ffmpeg([
      ...q, '-framerate', '1', '-i', join(tiles, '%04d.jpg'), '-vf', `tile=${f.count}x1`, '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', out
    ], bg())
  } finally {
    remove(tiles)
  }
}

async function writePoster(m: MediaItem, out: string): Promise<void> {
  const at = Math.min(1, m.duration * 0.1)
  await ffmpeg([
    ...q, '-noaccurate_seek', '-ss', at.toFixed(3), '-i', m.path, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=320:-2', '-q:v', '4', '-f', 'mjpeg', out
  ], bg())
}

// ---------------------------------------------------------------- fast-seek preview chunks
//
// The browser's decoder always restarts at the previous keyframe when it seeks, so sources with
// keyframes seconds apart (screen and game recordings) take hundreds of milliseconds per seek. The
// preview copy is 720p with a keyframe every 0.25 s, cut into fixed-length chunks so the part being
// edited is built first and finished chunks survive a restart.

export const CHUNK_SECONDS = 60
const CHUNK_FORMAT = 2
/** Measured: 0.5 s seeks as fast as 0.25 s in the preview and makes a noticeably smaller copy. */
const CHUNK_KEYFRAME_SECONDS = 0.5
/**
 * Decoding the source on the CPU is the bottleneck, so extra parallel chunks add little throughput
 * (measured 10× → 13× real time for 1 → 3 workers) but make each chunk arrive 2–3× later. Two workers,
 * plus preemption for the chunk under the playhead, keeps the part being edited quick to appear.
 */
const CHUNK_WORKERS = cpus().length >= 12 ? 2 : 1
let chunkEncoder: 'libx264' | 'h264_nvenc' = 'libx264'

/**
 * Picks the chunk encoder from the encoders that passed the startup test encode. NVENC measured
 * about 25% faster than x264 superfast per chunk here. Intel Quick Sync measured slower than x264
 * (frames are decoded on the CPU either way), and decoding on the GPU too was slower still.
 */
export function setChunkEncoders(usable: string[]): void {
  chunkEncoder = usable.includes('h264_nvenc') ? 'h264_nvenc' : 'libx264'
}

function chunkEncoderArgs(gop: string): string[] {
  if (chunkEncoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p2', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-g', gop, '-bf', '0', '-forced-idr', '1']
  }
  return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '23', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-bf', '0']
}

/** Whether seeking in this video is slow enough to be worth a preview copy. */
export function needsChunks(m: MediaItem): boolean {
  if (m.kind !== 'video' || m.duration <= 0) return false
  return (m.keyframeInterval ?? 0) > 1.0 || m.width * m.height > 2560 * 1440
}

interface ChunkJob {
  m: MediaItem
  dir: string
  count: number
  done: Set<number>
  /** Chunks being built, with the controller that cancels each one. */
  running: Map<number, AbortController>
  failed: Set<number>
  focus: number
  focusAt: number
  required: boolean
  /** Waits for the audio pass so the two don't compete for the disk (unless the preview needs it now). */
  waitForAudio: boolean
}

const chunkJobs = new Map<string, ChunkJob>()
let chunkRunning = 0

function chunkState(job: ChunkJob): ProxyChunks {
  return {
    seconds: CHUNK_SECONDS,
    count: job.count,
    prefix: `${SCHEME}://local/${encodeURIComponent(job.dir + sep)}`,
    done: [...job.done].sort((a, b) => a - b),
    required: job.required
  }
}

function startChunks(m: MediaItem, required: boolean): void {
  let job = chunkJobs.get(m.id)
  if (job) {
    if (required && !job.required) {
      job.required = true
      job.waitForAudio = false
      update(m.id, { chunks: chunkState(job) })
      pumpChunks()
    }
    return
  }
  const dir = join(dirFor(m), 'chunks')
  mkdirSync(dir, { recursive: true })
  // Chunks made with different settings are thrown away.
  const metaFile = join(dir, 'format.json')
  const meta = { format: CHUNK_FORMAT, seconds: CHUNK_SECONDS }
  try {
    if (JSON.stringify(JSON.parse(readFileSync(metaFile, 'utf8'))) !== JSON.stringify(meta)) throw new Error('stale')
  } catch {
    remove(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(metaFile, JSON.stringify(meta))
  }
  const done = new Set<number>()
  for (const f of readdirSync(dir)) {
    const match = /^(\d{5})\.mp4$/.exec(f)
    if (match) done.add(Number(match[1]))
    else if (f.includes('.part.')) remove(join(dir, f))
  }
  const count = Math.max(1, Math.ceil(m.duration / CHUNK_SECONDS - 1e-6))
  const audioPending = m.audioStreams.some((s) => !existsSync(audioPath(dirFor(m), s.index)))
  job = {
    m, dir, count, done, running: new Map(), failed: new Set(), focus: 0, focusAt: 0, required,
    waitForAudio: !required && audioPending
  }
  chunkJobs.set(m.id, job)
  update(m.id, { chunks: chunkState(job) })
  pumpChunks()
}

const focusChunk = (job: ChunkJob): number => Math.min(job.count - 1, Math.max(0, Math.floor(job.focus / CHUNK_SECONDS)))

/** How far chunk k is from where the user is working: ahead of the playhead is cheaper than behind. */
function chunkCost(job: ChunkJob, k: number): number {
  const fk = focusChunk(job)
  return k >= fk ? k - fk : (fk - k) * 3
}

/** Next chunk to build: the one under the focus, then the ones after it, then the ones before. */
function nextChunk(job: ChunkJob): number | undefined {
  let best: number | undefined
  let bestCost = Infinity
  for (let k = 0; k < job.count; k++) {
    if (job.done.has(k) || job.running.has(k) || job.failed.has(k)) continue
    const cost = chunkCost(job, k)
    if (cost < bestCost) {
      bestCost = cost
      best = k
    }
  }
  return best
}

/**
 * When the user jumps somewhere whose chunk is not built or building and every worker is busy,
 * cancel the least useful running chunk so the one under the playhead starts now. The cancelled
 * chunk is simply built again later.
 */
function preemptFor(job: ChunkJob): void {
  const fk = focusChunk(job)
  if (job.done.has(fk) || job.running.has(fk) || job.failed.has(fk) || job.waitForAudio) return
  if (chunkRunning < CHUNK_WORKERS) return
  let victim: { ctrl: AbortController; cost: number } | undefined
  for (const j of chunkJobs.values()) {
    for (const [k, ctrl] of j.running) {
      // Other videos' chunks are always less useful than the one being looked at.
      const cost = j === job ? chunkCost(j, k) : Infinity
      if (cost > 1 && (!victim || cost > victim.cost)) victim = { ctrl, cost }
    }
  }
  victim?.ctrl.abort()
}

function pumpChunks(): void {
  while (chunkRunning < CHUNK_WORKERS && !bgAbort.signal.aborted) {
    // Most recently focused video first; a video the preview cannot play without chunks before others.
    const jobs = [...chunkJobs.values()]
      .filter((j) => !j.waitForAudio)
      .sort((a, b) => Number(b.required) - Number(a.required) || b.focusAt - a.focusAt)
    let picked: { job: ChunkJob; k: number } | undefined
    for (const job of jobs) {
      const k = nextChunk(job)
      if (k !== undefined) {
        picked = { job, k }
        break
      }
    }
    if (!picked) return
    const { job, k } = picked
    const ctrl = new AbortController()
    job.running.set(k, ctrl)
    chunkRunning++
    void buildChunk(job, k, ctrl.signal).finally(() => {
      job.running.delete(k)
      chunkRunning--
      pumpChunks()
    })
  }
}

async function buildChunk(job: ChunkJob, k: number, cancel: AbortSignal): Promise<void> {
  const { m } = job
  const out = join(job.dir, chunkName(k))
  const tmp = partName(out)
  const start = k * CHUNK_SECONDS
  const length = Math.min(CHUNK_SECONDS, m.duration - start)
  const gop = String(Math.max(1, Math.round((m.fps || 30) * CHUNK_KEYFRAME_SECONDS)))
  const signal = AbortSignal.any([cancel, bgAbort.signal])
  try {
    await ffmpeg([
      ...q, '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', m.path, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', "scale=-2:'min(720,ih)':flags=bilinear,format=yuv420p",
      ...chunkEncoderArgs(gop),
      '-movflags', '+faststart', '-f', 'mp4', tmp
    ], { lowPriority: true, signal })
    renameSync(tmp, out)
    job.done.add(k)
    update(m.id, { chunks: chunkState(job) })
  } catch (err) {
    remove(tmp)
    if (signal.aborted) return
    console.error(`[media] preview chunk ${k} of ${m.name}:`, (err as Error).message)
    job.failed.add(k)
    if (job.failed.size >= 3 && job.done.size === 0) update(m.id, { chunks: { ...chunkState(job), failed: true } })
  }
}

export function setProxyFocus(mediaId: string, sourceTime: number): void {
  const job = chunkJobs.get(mediaId)
  if (!job || !Number.isFinite(sourceTime)) return
  job.focus = Math.max(0, sourceTime)
  job.focusAt = Date.now()
  preemptFor(job)
  pumpChunks()
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
  const known = states.get(m.id)
  states.set(m.id, { sourceUrl, audioUrls: {}, peakUrls: {}, missing: false })
  emit(m.id, states.get(m.id)!)

  if (m.kind === 'image') {
    update(m.id, { posterUrl: sourceUrl })
    if (m.animated) void makeAlphaProxy(m)
    return
  }

  // Audio: one pass over the source for every track, then waveforms from the small extracted files.
  if (m.audioStreams.length) {
    const key = `${dir}|audio`
    const finish = () => {
      for (const s of m.audioStreams) {
        const audio = audioPath(dir, s.index)
        if (!existsSync(audio)) continue
        update(m.id, { audioUrls: { [s.index]: mediaUrl(audio) } })
        const peaks = join(dir, `peaks_${s.index}.bin`)
        void cached(peaks, (tmp) => writePeaks(audio, tmp)).then((ok) => {
          if (ok) update(m.id, { peakUrls: { [s.index]: mediaUrl(peaks) } })
        })
      }
      const job = chunkJobs.get(m.id)
      if (job?.waitForAudio) {
        job.waitForAudio = false
        pumpChunks()
      }
    }
    if (m.audioStreams.every((s) => existsSync(audioPath(dir, s.index)))) finish()
    else if (!inFlight.has(key)) {
      inFlight.add(key)
      update(m.id, { audioProgress: 0 })
      extractAllAudio(m, dir)
        .catch((err) => {
          if (!bgAbort.signal.aborted) console.error(`[media] audio of ${m.name}:`, (err as Error).message)
        })
        .finally(() => {
          inFlight.delete(key)
          update(m.id, { audioProgress: 1 })
          finish()
        })
    }
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
    const existing = chunkJobs.get(m.id)
    if (existing) {
      existing.m = m
      update(m.id, { chunks: chunkState(existing) })
    } else if (m.keyframeInterval === undefined && !known) {
      // Projects saved before keyframe spacing was recorded: measure it now.
      void probeKeyframeInterval(m.path, m.duration).then((ki) => {
        const withKi = { ...m, keyframeInterval: ki }
        items.set(m.id, withKi)
        if (needsChunks(withKi)) startChunks(withKi, false)
      })
    } else if (needsChunks(m)) {
      startChunks(m, false)
    }
  }
}

/** Animated images become VP9-with-alpha video so they play like any other clip. */
async function makeAlphaProxy(m: MediaItem): Promise<void> {
  const out = join(dirFor(m), 'proxy.webm')
  if (existsSync(out)) {
    update(m.id, { proxyUrl: mediaUrl(out), proxyState: 'ready' })
    return
  }
  if (inFlight.has(out)) return
  update(m.id, { proxyState: 'pending', proxyProgress: 0 })
  const ok = await cached(
    out,
    (tmp) =>
      ffmpegProgress(
        [...q, '-i', m.path, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32',
          '-auto-alt-ref', '0', '-row-mt', '1', '-cpu-used', '5', '-f', 'webm', tmp],
        m.duration,
        (f) => update(m.id, { proxyProgress: f }),
        bgAbort.signal,
        true
      ),
    true
  )
  update(m.id, ok ? { proxyUrl: mediaUrl(out), proxyState: 'ready', proxyProgress: 1 } : { proxyState: 'error' })
}

/** The preview cannot decode this video's original, so it needs the chunked copy to show anything. */
export function requestProxy(mediaId: string): void {
  const m = items.get(mediaId)
  if (!m) return
  if (m.kind === 'image') void makeAlphaProxy(m)
  else startChunks(m, true)
}

export function forgetMedia(mediaId: string): void {
  items.delete(mediaId)
  states.delete(mediaId)
  chunkJobs.delete(mediaId)
}

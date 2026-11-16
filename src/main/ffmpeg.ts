// ffmpeg / ffprobe process helpers. No Electron imports, so tests can use this module directly.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import type { Caps } from '@shared/filtergraph'

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

let paths: FfmpegPaths | null = null

export function setFfmpegPaths(p: FfmpegPaths | null): void {
  paths = p
  capsCache = null
}

export function getFfmpegPaths(): FfmpegPaths {
  if (!paths) throw new Error('ffmpeg was not found. Run "npm run fetch-ffmpeg" or set its location in settings.')
  return paths
}

export const hasFfmpeg = (): boolean => !!paths

/** Looks for ffmpeg + ffprobe in the given directories. */
export function findFfmpeg(dirs: string[]): FfmpegPaths | null {
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const d of dirs) {
    if (!d) continue
    const ffmpeg = join(d, 'ffmpeg' + exe)
    const ffprobe = join(d, 'ffprobe' + exe)
    if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe }
  }
  return null
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  /** Collect stdout as a Buffer instead of text. */
  binary?: (chunk: Buffer) => void
  cwd?: string
  /** Run below normal priority so background work never competes with the UI and playback. */
  lowPriority?: boolean
}

/** Runs a binary with an argument array (never through a shell). */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    if (opts.lowPriority && child.pid) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        /* not permitted: run at normal priority */
      }
    }
    let stdout = ''
    let stderr = ''
    const onAbort = () => child.kill()
    if (opts.signal) {
      if (opts.signal.aborted) child.kill()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (d: Buffer) => {
      if (opts.binary) opts.binary(d)
      else {
        const text = d.toString()
        if (opts.onStdout) opts.onStdout(text)
        else stdout += text
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export class FfmpegError extends Error {
  constructor(message: string, public stderr: string) {
    super(message)
  }
}

/** Last meaningful lines of ffmpeg's stderr, for error messages. */
export function tail(stderr: string, lines = 6): string {
  return stderr.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n')
}

export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(getFfmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', ...args], opts)
  if (opts.signal?.aborted) throw new FfmpegError('Cancelled', '')
  if (r.code !== 0) throw new FfmpegError(`ffmpeg failed (exit ${r.code})\n${tail(r.stderr)}`, r.stderr)
  return r
}

export async function ffprobeJson(file: string): Promise<any> {
  const r = await run(getFfmpegPaths().ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ])
  if (r.code !== 0) throw new FfmpegError(`Could not read ${file}\n${tail(r.stderr)}`, r.stderr)
  return JSON.parse(r.stdout)
}

/** Runs ffmpeg reporting progress 0..1 from `-progress` output. */
export async function ffmpegProgress(
  args: string[], duration: number, onProgress: (fraction: number) => void, signal?: AbortSignal, lowPriority = false
): Promise<void> {
  let buf = ''
  await ffmpeg(['-progress', 'pipe:1', '-nostats', ...args], {
    signal,
    lowPriority,
    onStdout: (chunk) => {
      buf += chunk
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
        if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration))
      }
    }
  })
  onProgress(1)
}

let capsCache: Caps | null = null

/** Encoders and filters this ffmpeg build offers. */
export async function capabilities(): Promise<Caps> {
  if (capsCache) return capsCache
  const { ffmpeg: bin } = getFfmpegPaths()
  const [enc, fil] = await Promise.all([
    run(bin, ['-hide_banner', '-encoders']),
    run(bin, ['-hide_banner', '-filters'])
  ])
  const encoders: string[] = []
  for (const line of enc.stdout.split(/\r?\n/)) {
    const m = /^\s*[VAS][.\w]{5}\s+(\S+)/.exec(line)
    if (m && m[1] !== '=') encoders.push(m[1])
  }
  const filters: string[] = []
  for (const line of fil.stdout.split(/\r?\n/)) {
    const m = /^\s*[.\w]{2,3}\s+(\S+)\s+\S+->\S+/.exec(line)
    if (m) filters.push(m[1])
  }
  capsCache = { encoders, filters }
  return capsCache
}

/**
 * Hardware encoders are listed even when no matching GPU is present, so each one is tried on a
 * tiny encode. Returns the caps with unusable hardware encoders removed.
 */
export async function usableCapabilities(): Promise<Caps> {
  const caps = await capabilities()
  const hw = caps.encoders.filter((e) => /_(nvenc|qsv|amf)$/.test(e) && /^(h264|hevc|av1)_/.test(e))
  const bin = getFfmpegPaths().ffmpeg
  const results = await Promise.all(
    hw.map(async (e) => {
      const r = await run(bin, [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2',
        '-c:v', e, '-pix_fmt', e.endsWith('_nvenc') ? 'yuv420p' : 'nv12', '-f', 'null', '-'
      ]).catch(() => ({ code: 1 }))
      return [e, r.code === 0] as const
    })
  )
  const bad = new Set(results.filter(([, ok]) => !ok).map(([e]) => e))
  return { encoders: caps.encoders.filter((e) => !bad.has(e)), filters: caps.filters }
}

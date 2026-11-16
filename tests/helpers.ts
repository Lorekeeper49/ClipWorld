import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ffmpeg, findFfmpeg, ffprobeJson, getFfmpegPaths, run, setFfmpegPaths } from '../src/main/ffmpeg'

export const ROOT = resolve(__dirname, '..')
export const TMP = join(ROOT, 'tests', '.tmp')

export function setupFfmpeg(): void {
  const found = findFfmpeg([join(ROOT, 'vendor', 'ffmpeg')])
  if (!found) throw new Error('vendor/ffmpeg is missing — run "npm run fetch-ffmpeg" first')
  setFfmpegPaths(found)
  mkdirSync(TMP, { recursive: true })
}

export interface Fixtures {
  video: string
  tone: string
  image: string
  gif: string
  overlay: string
}

/** Generates small synthetic media files once. */
export async function fixtures(): Promise<Fixtures> {
  const f: Fixtures = {
    video: join(TMP, 'src.mkv'),
    tone: join(TMP, 'tone.wav'),
    image: join(TMP, 'img.png'),
    gif: join(TMP, 'anim.gif'),
    overlay: join(TMP, 'overlay.png')
  }
  const q = ['-loglevel', 'error', '-y']
  if (!existsSync(f.video)) {
    await ffmpeg([
      ...q, '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
      '-f', 'lavfi', '-i', 'sine=f=880:d=6', '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata:s:a:0', 'title=Game', '-metadata:s:a:1', 'title=Mic', f.video
    ])
  }
  if (!existsSync(f.tone)) await ffmpeg([...q, '-f', 'lavfi', '-i', 'sine=f=1000:d=5', f.tone])
  if (!existsSync(f.image)) await ffmpeg([...q, '-f', 'lavfi', '-i', 'testsrc=s=400x300', '-frames:v', '1', f.image])
  if (!existsSync(f.gif)) await ffmpeg([...q, '-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=2', f.gif])
  if (!existsSync(f.overlay)) {
    await ffmpeg([...q, '-f', 'lavfi', '-i', 'color=c=red@0.5:s=200x100,format=rgba', '-frames:v', '1', f.overlay])
  }
  return f
}

export async function info(file: string): Promise<{ duration: number; video: any[]; audio: any[]; format: string }> {
  const j = await ffprobeJson(file)
  return {
    duration: Number(j.format.duration),
    video: j.streams.filter((s: any) => s.codec_type === 'video'),
    audio: j.streams.filter((s: any) => s.codec_type === 'audio'),
    format: j.format.format_name
  }
}

/** Mean volume in dB of an audio stream. */
export async function meanVolume(file: string, stream = 0): Promise<number> {
  const r = await run(getFfmpegPaths().ffmpeg, [
    '-hide_banner', '-nostdin', '-i', file, '-map', `0:a:${stream}`, '-af', 'volumedetect', '-f', 'null', '-'
  ])
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr)
  if (!m) throw new Error('volumedetect produced no output:\n' + r.stderr.slice(-500))
  return Number(m[1])
}

/** Average RGB of a frame at `time`, optionally of a crop region "w:h:x:y". */
export async function frameColor(file: string, time: number, crop?: string): Promise<[number, number, number]> {
  const chunks: Buffer[] = []
  await ffmpeg(
    ['-loglevel', 'error', '-ss', String(time), '-i', file, '-frames:v', '1',
      '-vf', `${crop ? `crop=${crop},` : ''}scale=1:1:flags=area,format=rgb24`, '-f', 'rawvideo', '-'],
    { binary: (c) => chunks.push(c) }
  )
  const b = Buffer.concat(chunks)
  return [b[0], b[1], b[2]]
}

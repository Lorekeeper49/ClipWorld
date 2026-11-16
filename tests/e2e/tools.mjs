// Paths to this system's bundled ffmpeg/ffprobe for the end-to-end scripts.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..', '..')
const exe = process.platform === 'win32' ? '.exe' : ''
const dir = [join(root, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`), join(root, 'vendor', 'ffmpeg')].find((d) =>
  existsSync(join(d, `ffmpeg${exe}`))
)
if (!dir) throw new Error('ffmpeg is missing — run "npm run fetch-ffmpeg" first')
export const ffmpeg = join(dir, `ffmpeg${exe}`)
export const ffprobe = join(dir, `ffprobe${exe}`)

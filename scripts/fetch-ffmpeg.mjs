// Downloads a current ffmpeg release build into vendor/ffmpeg/ (Windows x64).
// Source: gyan.dev, the Windows build linked from ffmpeg.org. Verified by SHA-256.
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'vendor', 'ffmpeg')
const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

if (process.platform !== 'win32') {
  console.error('fetch-ffmpeg only supports Windows. Install ffmpeg yourself and set its path in ClipWorld settings.')
  process.exit(1)
}
if (existsSync(join(dest, 'ffmpeg.exe')) && existsSync(join(dest, 'ffprobe.exe')) && !process.argv.includes('--force')) {
  console.log('ffmpeg already present in vendor/ffmpeg (use --force to re-download)')
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
const zipPath = join(dest, 'ffmpeg.zip')

console.log(`Downloading ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
const total = Number(res.headers.get('content-length') || 0)
let got = 0
let lastPct = -1
const counter = new TransformStream({
  transform(chunk, controller) {
    got += chunk.byteLength
    if (total) {
      const pct = Math.floor((got / total) * 10) * 10
      if (pct !== lastPct) {
        lastPct = pct
        console.log(`  ${pct}%  (${(got / 1048576).toFixed(0)} MB)`)
      }
    }
    controller.enqueue(chunk)
  }
})
await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(zipPath))

const shaRes = await fetch(url + '.sha256', { redirect: 'follow' })
if (!shaRes.ok) throw new Error(`Could not fetch checksum: HTTP ${shaRes.status}`)
const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase()
const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
if (expected !== actual) {
  rmSync(zipPath, { force: true })
  throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`)
}
console.log('Checksum OK')

// Windows ships bsdtar, which reads zip archives.
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const extractDir = join(dest, '_extract')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
const r = spawnSync(tar, ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' })
if (r.status !== 0) throw new Error('Extraction failed')

const inner = readdirSync(extractDir)[0]
for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
  rmSync(join(dest, exe), { force: true })
  renameSync(join(extractDir, inner, 'bin', exe), join(dest, exe))
}
for (const f of ['LICENSE', 'README.txt']) {
  const p = join(extractDir, inner, f)
  if (existsSync(p)) {
    rmSync(join(dest, f), { force: true })
    renameSync(p, join(dest, f))
  }
}
rmSync(extractDir, { recursive: true, force: true })
rmSync(zipPath, { force: true })
console.log(`ffmpeg installed to ${dest}`)

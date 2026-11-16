// Downloads a current static ffmpeg + ffprobe into vendor/ffmpeg/<platform>-<arch>/, verified by SHA-256.
//   Windows x64:          gyan.dev "essentials" build (the Windows build linked from ffmpeg.org)
//   Linux x64 / arm64:    FFmpeg-Builds static GPL build (newest stable release branch)
// Usage: node scripts/fetch-ffmpeg.mjs [--platform win32|linux] [--arch x64|arm64] [--force]
// The platform/arch flags fetch binaries for another system, e.g. to package for Linux elsewhere.
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const platform = arg('platform') ?? process.platform
const arch = arg('arch') ?? process.arch
const force = process.argv.includes('--force')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`)
const exe = platform === 'win32' ? '.exe' : ''
const bins = [`ffmpeg${exe}`, `ffprobe${exe}`]

// Earlier versions kept the Windows binaries directly in vendor/ffmpeg: move them into place.
const legacy = join(root, 'vendor', 'ffmpeg')
if (platform === 'win32' && arch === 'x64' && !existsSync(join(dest, 'ffmpeg.exe')) && existsSync(join(legacy, 'ffmpeg.exe'))) {
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(legacy)) {
    if (/^(ffmpeg\.exe|ffprobe\.exe|LICENSE.*|README.*)$/i.test(f)) renameSync(join(legacy, f), join(dest, f))
  }
  console.log(`Moved the existing ffmpeg into ${dest}`)
}

if (bins.every((b) => existsSync(join(dest, b))) && !force) {
  console.log(`ffmpeg already present in ${dest} (use --force to re-download)`)
  process.exit(0)
}

async function download(url, file) {
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
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(file))
}

function verify(file, expected) {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (expected.toLowerCase() !== actual) {
    rmSync(file, { force: true })
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`)
  }
  console.log('Checksum OK')
}

/** Picks the download URL and its expected SHA-256 for the requested platform. */
async function source() {
  if (platform === 'win32' && arch === 'x64') {
    const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    const res = await fetch(url + '.sha256', { redirect: 'follow' })
    if (!res.ok) throw new Error(`Could not fetch checksum: HTTP ${res.status}`)
    return { url, sha256: (await res.text()).trim().split(/\s+/)[0], name: 'ffmpeg.zip' }
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const base = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest'
    const res = await fetch(`${base}/checksums.sha256`, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Could not fetch checksums: HTTP ${res.status}`)
    const target = arch === 'x64' ? 'linux64' : 'linuxarm64'
    const rows = (await res.text())
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((r) => r.length === 2)
    // Newest stable release branch (e.g. ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz); development build as a fallback.
    const stable = rows
      .map(([sha256, name]) => ({ sha256, name, v: new RegExp(`^ffmpeg-n(\\d+)\\.(\\d+)-latest-${target}-gpl-[\\d.]+\\.tar\\.xz$`).exec(name) }))
      .filter((r) => r.v)
      .sort((a, b) => Number(b.v[1]) - Number(a.v[1]) || Number(b.v[2]) - Number(a.v[2]))
    const pick = stable[0] ?? rows.map(([sha256, name]) => ({ sha256, name })).find((r) => r.name === `ffmpeg-master-latest-${target}-gpl.tar.xz`)
    if (!pick) throw new Error(`No ${target} build listed in ${base}/checksums.sha256`)
    return { url: `${base}/${pick.name}`, sha256: pick.sha256, name: pick.name }
  }
  throw new Error(
    `No bundled ffmpeg download for ${platform}-${arch}. Install ffmpeg with your package manager ` +
      '(e.g. "brew install ffmpeg" or "sudo apt install ffmpeg"); ClipWorld finds it on the PATH.'
  )
}

mkdirSync(dest, { recursive: true })
const src = await source()
const archive = join(dest, src.name)
await download(src.url, archive)
verify(archive, src.sha256)

// Windows ships bsdtar, which reads zip and xz; elsewhere the system tar does.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const extractDir = join(dest, '_extract')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
const r = spawnSync(tar, ['-xf', archive, '-C', extractDir], { stdio: 'inherit' })
if (r.status !== 0) throw new Error('Extraction failed')

const inner = join(extractDir, readdirSync(extractDir)[0])
for (const b of bins) {
  rmSync(join(dest, b), { force: true })
  renameSync(join(inner, 'bin', b), join(dest, b))
  if (exe === '') {
    try {
      chmodSync(join(dest, b), 0o755)
    } catch {
      /* Windows file systems have no execute bit; packaging for Linux should then happen on Linux */
    }
  }
}
for (const f of readdirSync(inner)) {
  if (/^(LICENSE|README)/i.test(f)) {
    rmSync(join(dest, f), { force: true })
    renameSync(join(inner, f), join(dest, f))
  }
}
rmSync(extractDir, { recursive: true, force: true })
rmSync(archive, { force: true })
console.log(`ffmpeg installed to ${dest}`)

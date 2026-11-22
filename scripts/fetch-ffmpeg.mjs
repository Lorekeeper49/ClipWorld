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

// Downloads the static ffmpeg + ffprobe that ClipWorld bundles into vendor/ffmpeg/<platform>-<arch>/,
// verified by SHA-256. Every platform uses the same FFmpeg-Builds build (static, GPL), pinned in
// scripts/ffmpeg-build.json, so each release can carry that build's complete source code
// (scripts/ffmpeg-source.sh) as the GPL asks. Next to the binaries it writes SOURCE.txt, which says
// where that source is.
//   Windows x64, Linux x64 and Linux arm64 are bundled; other systems use an ffmpeg on the PATH.
// Usage: node scripts/fetch-ffmpeg.mjs [--platform win32|linux] [--arch x64|arm64] [--force] [--update]
//   --platform/--arch  fetch binaries for another system, e.g. to package for Linux elsewhere
//   --force            download again even if the pinned build is already there
//   --update           pin the newest FFmpeg-Builds build of the newest stable FFmpeg first
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const lockFile = join(root, 'scripts', 'ffmpeg-build.json')
const dest = join(root, 'vendor', 'ffmpeg', `${platform}-${arch}`)
const exe = platform === 'win32' ? '.exe' : ''
const bins = [`ffmpeg${exe}`, `ffprobe${exe}`]
const BUILDER = 'FFmpeg-Builds/FFmpeg-Builds'
/** FFmpeg-Builds' name for each system ClipWorld bundles ffmpeg for. */
const TARGETS = { 'win32-x64': 'win64', 'linux-x64': 'linux64', 'linux-arm64': 'linuxarm64' }

async function github(path) {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`https://api.github.com/${path}`, { headers })
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`)
  return res.json()
}

/** Pins the newest FFmpeg-Builds build: its newest stable FFmpeg release branch, for every bundled system. */
async function updateLock() {
  const releases = await github(`repos/${BUILDER}/releases?per_page=20`)
  const release = releases.find((r) => !r.draft && /^autobuild-/.test(r.tag_name))
  if (!release) throw new Error(`No dated build found in ${BUILDER}`)
  const sums = release.assets.find((a) => a.name === 'checksums.sha256')
  if (!sums) throw new Error(`${release.tag_name} has no checksums.sha256`)
  const res = await fetch(sums.browser_download_url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Could not fetch checksums: HTTP ${res.status}`)
  const rows = (await res.text()).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((r) => r.length === 2)
  // e.g. ffmpeg-n9.0.2-61-gd59078794d-win64-gpl-9.0.zip
  const builds = new Map()
  for (const [sha256, name] of rows) {
    const m = /^ffmpeg-(n(\d+)\.(\d+)(?:\.\d+)*-\d+-g([0-9a-f]+))-([a-z0-9]+)-gpl-(\d+\.\d+)\.(?:zip|tar\.xz)$/.exec(name)
    if (!m) continue
    const [, version, major, minor, commit, target, addin] = m
    const b = builds.get(version) ?? { version, major: Number(major), minor: Number(minor), commit, addin, files: {} }
    b.files[target] = { name, sha256 }
    builds.set(version, b)
  }
  const complete = [...builds.values()]
    .filter((b) => Object.values(TARGETS).every((t) => b.files[t]))
    .sort((a, b) => b.major - a.major || b.minor - a.minor)
  const pick = complete[0]
  if (!pick) throw new Error(`${release.tag_name} has no stable GPL build for ${Object.values(TARGETS).join(', ')}`)
  let ref = (await github(`repos/${BUILDER}/git/ref/tags/${release.tag_name}`)).object
  if (ref.type === 'tag') ref = (await github(`repos/${BUILDER}/git/tags/${ref.sha}`)).object
  const ffmpegCommit = (await github(`repos/FFmpeg/FFmpeg/commits/${pick.commit}`)).sha
  const lock = {
    about: 'The ffmpeg build ClipWorld bundles. Change it with: node scripts/fetch-ffmpeg.mjs --update',
    builder: `https://github.com/${BUILDER}`,
    buildTag: release.tag_name,
    buildCommit: ref.sha,
    variant: 'gpl',
    addin: pick.addin,
    ffmpegVersion: pick.version,
    ffmpegCommit,
    files: Object.fromEntries(Object.entries(TARGETS).map(([key, target]) => [key, { target, ...pick.files[target] }]))
  }
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
  console.log(`Pinned FFmpeg ${lock.ffmpegVersion} from ${lock.buildTag} in ${lockFile}`)
}

if (process.argv.includes('--update')) await updateLock()
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const file = lock.files[`${platform}-${arch}`]
if (!file) {
  console.error(
    `No bundled ffmpeg download for ${platform}-${arch}. Install ffmpeg with your package manager ` +
      '(e.g. "brew install ffmpeg" or "sudo apt install ffmpeg"); ClipWorld finds it on the PATH.'
  )
  process.exit(1)
}

// Earlier versions kept the Windows binaries directly in vendor/ffmpeg: move them into place.
const legacy = join(root, 'vendor', 'ffmpeg')
if (platform === 'win32' && arch === 'x64' && !existsSync(join(dest, 'ffmpeg.exe')) && existsSync(join(legacy, 'ffmpeg.exe'))) {
  mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(legacy)) {
    if (/^(ffmpeg\.exe|ffprobe\.exe|LICENSE.*|README.*)$/i.test(f)) renameSync(join(legacy, f), join(dest, f))
  }
  console.log(`Moved the existing ffmpeg into ${dest}`)
}

// BUILD.json records which download is in the folder, so a changed pin downloads the new build.
const stampFile = join(dest, 'BUILD.json')
const stamp = (() => {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return null
  }
})()
if (bins.every((b) => existsSync(join(dest, b))) && stamp?.name === file.name && stamp?.sha256 === file.sha256 && !force) {
  console.log(`FFmpeg ${lock.ffmpegVersion} already present in ${dest} (use --force to download it again)`)
  process.exit(0)
}

async function download(url, path) {
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
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(path))
}

function verify(path, expected) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (expected.toLowerCase() !== actual) {
    rmSync(path, { force: true })
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`)
  }
  console.log('Checksum OK')
}

/** Where the GPL source of these binaries is: ClipWorld's release pages carry it (scripts/ffmpeg-source.sh). */
function sourceNotice() {
  const repo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository.url.replace(/\.git$/, '')
  const archive = `ffmpeg-source-${lock.buildTag}`
  return `ffmpeg${exe} and ffprobe${exe} in this folder are FFmpeg ${lock.ffmpegVersion}, built by FFmpeg-Builds
(${lock.builder}, build ${lock.buildTag}, file ${file.name}).
They are free software under the GNU General Public License, version 3: see LICENSE.txt.

Source code
-----------
Every ClipWorld release that includes these files has their complete source code attached on its
release page, as ${archive}.tar
(or, when it is too big for one file, ${archive}.tar.part00, .part01 and so on, to be joined in order):

  ${repo}/releases

It holds FFmpeg itself, the source code of every library built into these files, and the build
scripts used to make them. The same code is also available from its own authors:

  FFmpeg:         https://github.com/FFmpeg/FFmpeg/tree/${lock.ffmpegCommit}
  Build scripts:  ${lock.builder}/tree/${lock.buildCommit}
                  (scripts.d there names the exact version of every library)
`.replace(/\n/g, platform === 'win32' ? '\r\n' : '\n')
}

mkdirSync(dest, { recursive: true })
const url = `${lock.builder}/releases/download/${lock.buildTag}/${file.name}`
const archive = join(dest, file.name)
await download(url, archive)
verify(archive, file.sha256)

// Windows ships bsdtar, which reads zip and xz; elsewhere the system tar does.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const extractDir = join(dest, '_extract')
rmSync(extractDir, { recursive: true, force: true })
mkdirSync(extractDir, { recursive: true })
const r = spawnSync(tar, ['-xf', archive, '-C', extractDir], { stdio: 'inherit' })
if (r.status !== 0) throw new Error('Extraction failed')

// Clear out the previous build's files (including another builder's notes) before moving the new ones in.
for (const f of readdirSync(dest)) {
  if (/^(LICENSE|README|SOURCE|BUILD)/i.test(f) || bins.includes(f)) rmSync(join(dest, f), { force: true })
}
const inner = join(extractDir, readdirSync(extractDir)[0])
for (const b of bins) {
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
  if (/^(LICENSE|README)/i.test(f)) renameSync(join(inner, f), join(dest, f))
}
writeFileSync(join(dest, 'SOURCE.txt'), sourceNotice())
writeFileSync(stampFile, JSON.stringify({ buildTag: lock.buildTag, name: file.name, sha256: file.sha256 }, null, 2) + '\n')
rmSync(extractDir, { recursive: true, force: true })
rmSync(archive, { force: true })
console.log(`FFmpeg ${lock.ffmpegVersion} installed to ${dest}`)

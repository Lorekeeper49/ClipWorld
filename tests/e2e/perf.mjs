// Preview performance probe. Opens a project (or imports a media file) in the built app and measures
// media preparation time, seek latency, frame stepping and playback smoothness, first on the original
// file and then on the fast-seek preview chunks.
// Usage: node tests/e2e/perf.mjs <project.vcws | media file> [timeline seconds to seek to...]
// The app runs with a throwaway user-data directory, so the user's settings and cache are left alone.
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..', '..')
const input = process.argv[2]
if (!input) throw new Error('usage: node tests/e2e/perf.mjs <project.vcws | media file> [seconds...]')
const args = process.argv.slice(3).map(Number)
const seekTimes = args.length ? args : [30, 900, 3600, 7200, 9500]
const userData = join(tmpdir(), 'clipworld-perf-userdata')
// CW_PERF_KEEP=1 reuses the previous run's cache (skips the import cost when only measuring seeks).
if (!process.env.CW_PERF_KEEP) rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const app = await electron.launch({ args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`] })
app.process().stdout.on('data', (d) => {
  for (const l of String(d).split('\n')) if (l.includes('[proto]') && !l.includes('.m4a')) console.log(l)
})
app.process().stderr.on('data', (d) => {
  for (const l of String(d).split('\n')) if (l.includes('[media]')) console.log(l)
})
const page = await app.firstWindow()
await page.waitForSelector('.menubar', { timeout: 20000 })
const t0 = Date.now()
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`

if (/\.vcws$/i.test(input)) {
  await page.evaluate((p) => window.__cw.actions.openProjectAction(p), input)
} else {
  await page.evaluate(async (p) => {
    const [m] = await window.__cw.actions.importPaths([p])
    window.__cw.actions.addToTimeline(m.id, 0)
  }, resolve(input))
}
await page.waitForFunction(() => window.__cw.get().project.clips.length > 0, null, { timeout: 20000 })

await page.waitForFunction(() => {
  const s = window.__cw.get()
  return s.project.media.every((m) => {
    const c = s.mediaCache[m.id]
    return c && m.audioStreams.every((a) => c.audioUrls[a.index])
  })
}, null, { timeout: 1_800_000, polling: 500 })
console.log(`audio tracks extracted after ${since()}`)
await page.waitForFunction(() => {
  const s = window.__cw.get()
  return s.project.media.every((m) => {
    const c = s.mediaCache[m.id]
    return c && m.audioStreams.every((a) => c.peakUrls[a.index]) && (m.kind !== 'video' || c.filmstrip)
  })
}, null, { timeout: 1_800_000, polling: 500 })
console.log(`waveforms + thumbnails ready after ${since()}`)
const info = await page.evaluate(() => {
  const s = window.__cw.get()
  return s.project.media.map((m) => ({ name: m.name, keyframeInterval: m.keyframeInterval, playable: s.playable[m.id], chunks: s.mediaCache[m.id]?.chunks && { count: s.mediaCache[m.id].chunks.count, done: s.mediaCache[m.id].chunks.done.length } }))
})
console.log('media:', JSON.stringify(info))

/** Runs the seek / step / playback measurements in the page. */
async function measure(label, times, playAt) {
  const r = await page.evaluate(async ({ times, playAt }) => {
    const { player } = window.__cw
    const waitReady = async (limit = 20000) => {
      const start = performance.now()
      while (performance.now() - start < limit) {
        await new Promise((r) => requestAnimationFrame(r))
        if (player.ready()) {
          await new Promise((r) => requestAnimationFrame(r))
          if (player.ready()) return Math.round(performance.now() - start)
        }
      }
      return -1
    }
    const out = { seeks: [], steps: [], sources: [], playback: null }
    player.pause()
    for (const t of times) {
      player.seek(t)
      out.seeks.push(await waitReady())
      out.sources.push(Object.values(player.sources())[0] ?? 'none')
    }
    player.seek(times[Math.floor(times.length / 2)] + 1.5)
    await waitReady()
    for (let i = 0; i < 8; i++) {
      player.step(1)
      out.steps.push(await waitReady())
    }
    if (playAt !== undefined) {
      player.seek(playAt)
      await waitReady()
      let frames = 0
      let seeks = 0
      const counted = new Set()
      const hook = () => {
        for (const v of player.videos) {
          if (counted.has(v.el)) continue
          counted.add(v.el)
          v.el.addEventListener('seeking', () => player.playing && seeks++)
          const cb = () => {
            if (v.role === 'active') frames++
            v.el.requestVideoFrameCallback(cb)
          }
          v.el.requestVideoFrameCallback(cb)
        }
      }
      const wall0 = performance.now()
      const startTime = player.time
      player.play()
      let worst = 0
      let last = performance.now()
      const srcSeen = new Set()
      while (performance.now() - wall0 < 6000) {
        await new Promise((r) => requestAnimationFrame(r))
        hook()
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
        for (const v of player.videos) if (v.role === 'active' && v.clipId) srcSeen.add(v.clipId.split('#')[1])
      }
      const wall = (performance.now() - wall0) / 1000
      const advanced = player.time - startTime
      player.pause()
      out.playback = {
        from: playAt, videoFps: +(frames / wall).toFixed(1), timelineSpeed: +(advanced / wall).toFixed(2),
        seeksDuringPlay: seeks, worstFrameGapMs: Math.round(worst), sourcesUsed: [...srcSeen].join(',')
      }
    }
    return out
  }, { times, playAt })
  console.log(`\n== ${label}`)
  console.log('seek → frame shown (ms):', times.map((t, i) => `${t}s ${r.seeks[i]} (${r.sources[i]})`).join(', '))
  console.log('frame step (ms):', r.steps.join(', '))
  if (r.playback) console.log('playback:', JSON.stringify(r.playback))
}

// Source position (and chunk) under a timeline time, for waiting on specific chunks.
const chunkAt = (t) => page.evaluate((t) => {
  const s = window.__cw.get()
  const c = s.project.clips.find((x) => x.type === 'video' && t >= x.start && t < x.start + x.duration)
  if (!c) return null
  const ch = s.mediaCache[c.mediaId]?.chunks
  if (!ch) return null
  return { k: Math.floor((c.srcIn + (t - c.start) * c.speed) / ch.seconds), mediaId: c.mediaId, seconds: ch.seconds }
}, t)

await measure('original file (preview chunks still building)', seekTimes)

// Timeline time 2 s before a preview-chunk boundary inside the clip under the third test position,
// so the playback check crosses from one chunk file into the next.
const boundary = await page.evaluate((t) => {
  const s = window.__cw.get()
  const c = s.project.clips.find((x) => x.type === 'video' && t >= x.start && t < x.start + x.duration)
  const ch = c && s.mediaCache[c.mediaId]?.chunks
  if (!c || !ch) return t
  const src = c.srcIn + (t - c.start) * c.speed
  const edge = Math.ceil(src / ch.seconds) * ch.seconds
  return c.start + (edge - c.srcIn) / c.speed - 2
}, seekTimes[2])
console.log(`chunk boundary test starts at timeline ${boundary.toFixed(2)} s`)
for (const t of [...seekTimes, boundary, boundary + 3]) {
  const at = await chunkAt(t)
  if (!at) continue
  const start = Date.now()
  await page.evaluate((t) => window.__cw.player.seek(t), t)
  await page.waitForFunction(({ k, mediaId }) => window.__cw.get().mediaCache[mediaId]?.chunks?.done.includes(k), at, { timeout: 300_000, polling: 250 })
  console.log(`chunk ${at.k} (around ${t}s) ready ${((Date.now() - start) / 1000).toFixed(1)} s after the playhead moved there`)
}

await measure('preview chunks', seekTimes, boundary)
await app.evaluate(({ app }) => app.exit(0))

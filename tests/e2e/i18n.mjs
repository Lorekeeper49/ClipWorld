// Language UI test. Switches the app to the pseudo-language from the Language dialog, opens every window,
// menu and dialog, and fails on any text that is still plain English: that text is hard-coded somewhere
// instead of coming from src/locales. Then does the same in Japanese, and checks the choice is remembered
// after a restart. Run with: npm run build && node tests/e2e/i18n.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ffmpeg, root } from './tools.mjs'

const dir = join(tmpdir(), 'clipworld-i18n-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const shots = join(root, 'tests', '.tmp')
mkdirSync(shots, { recursive: true })
const gen = (name, args) => {
  const out = join(dir, name)
  const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', ...args, out])
  if (r.status !== 0) throw new Error(r.stderr.toString())
  return out
}
const files = {
  video: gen('clip.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']),
  image: gen('still.png', ['-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180', '-frames:v', '1'])
}
const dialogs = join(dir, 'dialogs.json')
writeFileSync(dialogs, JSON.stringify({ open: [], save: [] }))
const userData = join(tmpdir(), 'clipworld-i18n-userdata')
rmSync(userData, { recursive: true, force: true })

const step = (m) => console.log('•', m)
const check = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); console.log('  ✓', msg) }

async function launch() {
  const app = await electron.launch({
    args: [join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, CW_E2E_DIALOGS: dialogs }
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.waitForSelector('.menubar')
  return { app, page, errors }
}

// Words that are allowed to stay as they are in any language: product and format names, key names,
// units, and the brand.
const ALWAYS_OK = new Set([
  'ClipWorld', 'ffmpeg', 'npm', 'fetch', 'Ctrl', 'Shift', 'Alt', 'Space', 'Delete', 'Left', 'Right', 'Home', 'End', 'Escape',
  'Backspace', 'Enter', 'Tab', 'fps', 'kbps', 'kHz', 'vcws', 'mp4', 'mkv', 'png', 'aac', 'h264', 'MP4', 'MKV', 'MOV', 'GIF',
  'AVI', 'WebM', 'Ogg', 'WAV', 'FLAC', 'M4A', 'MP3', 'AAC', 'Opus', 'Vorbis', 'PCM', 'HEVC', 'VP9', 'AV1', 'Matroska',
  'QuickTime', 'Apple', 'ProRes', 'MPEG', 'Part', 'NVIDIA', 'NVENC', 'Intel', 'Quick', 'Sync', 'AMD', 'AMF', 'x264', 'x265',
  'libvpx', 'SVT', 'libaom', 'SubRip', 'srt', 'WebVTT', 'vtt', 'Advanced', 'SubStation', 'Alpha', 'ass', 'ssa', 'YouTube',
  'SubViewer', 'sbv', 'TTML', 'DFXP', 'ttml', 'SAMI', 'smi', 'MicroDVD', 'sub', 'LRC', 'lrc', 'txt', 'SRT', 'VTT', 'ASS',
  'SBV', 'SUB', 'DVD', 'Blu', 'ray', 'UHD', 'Web', 'Language'
])

/** Every visible piece of text, tooltip and placeholder, with where it was found. */
const collectText = (page) => page.evaluate(() => {
  const out = []
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const where = (el) => {
    const panel = el.closest('[data-panel]')?.getAttribute('data-panel') ?? el.closest('.modal')?.getAttribute('aria-label') ??
      (el.closest('.menubar') ? 'menu bar' : el.closest('.dv-tab') ? 'tab' : 'page')
    return `${panel} <${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}>`
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    const text = n.textContent.trim()
    // Subtitle language names come from the system (Intl), in the app's language when it has one.
    // dockview's screen-reader log keeps announcements made before a language switch, in the old language.
    if (!text || !el || el.closest('script, style, [data-i18n-ignore], [data-testid=subtitle-language], .dv-live-region')) continue
    if (el.tagName === 'OPTION' || visible(el)) out.push({ text, where: where(el) })
  }
  for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    if (!visible(el) || el.closest('[data-i18n-ignore]')) continue
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a)
      if (v) out.push({ text: v, where: `${where(el)} @${a}` })
    }
  }
  // Typed values (colours such as #ffffff are not words).
  for (const el of document.querySelectorAll('input[type=text], textarea')) {
    if (visible(el) && el.value && !/^#[0-9a-f]{3,8}$/i.test(el.value)) out.push({ text: el.value, where: `${where(el)} value` })
  }
  return out
})

/** Words of the user's own data (file, track and font names, subtitle text): never translated. */
const userWords = (page) => page.evaluate(() => {
  const s = window.__cw.get()
  const names = [
    ...s.project.media.flatMap((m) => [m.name, m.path, ...m.audioStreams.map((a) => `${a.title} ${a.codec}`), m.videoCodec ?? '']),
    ...s.project.clips.map((c) => `${c.name} ${c.text?.content ?? ''} ${c.text?.fontFamily ?? ''}`),
    ...s.project.tracks.map((t) => t.name),
    ...s.project.subtitles.flatMap((t) => [t.name, t.style.fontFamily, ...t.cues.map((c) => c.text)]),
    s.ffmpegVersion ?? '', ...s.fonts.slice(0, 2000)
  ]
  return [...new Set(names.join(' ').match(/[A-Za-z][A-Za-z0-9]*/g) ?? [])]
})

/**
 * Text that is plain English where it should not be. In the pseudo-language every message is inside [ ],
 * so anything English outside brackets is hard-coded. In a real translation, English words left over are
 * either hard-coded or missing from that language's file.
 */
async function untranslated(page, label) {
  const ok = new Set([...ALWAYS_OK, ...(await userWords(page))])
  const bad = []
  for (const { text, where } of await collectText(page)) {
    const outside = text.replace(/\[[^\]]*\]/g, ' ')
    const words = (outside.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !ok.has(w))
    if (words.length) bad.push(`${label}: ${where}: "${text.slice(0, 90)}"  (${[...new Set(words)].join(', ')})`)
  }
  return bad
}

/** Visits every window, menu and dialog, collecting leftovers on each. */
async function sweep(page, label) {
  const problems = []
  const scan = async (what) => problems.push(...(await untranslated(page, `${label} · ${what}`)))
  // Toasts shown before the language changed stay in the language they were shown in.
  await page.evaluate(() => window.__cw.set({ toasts: [] }))
  // Each dock group shows one tab at a time: click through every tab.
  const tabs = await page.locator('.dv-tab').count()
  for (let i = 0; i < tabs; i++) {
    await page.locator('.dv-tab').nth(i).click()
    await page.waitForTimeout(80)
    await scan(`tab ${i + 1}`)
  }
  // Open the collapsed Style section of the Subtitles window and the export box.
  await page.evaluate(() => window.__cw.showPanel('subtitles'))
  for (const head of await page.locator('[data-panel=subtitles] .section:not(:has(.section-body)) .section-head').all()) await head.click()
  if (!(await page.getByTestId('subtitle-export-box').count())) await page.getByTestId('subtitle-export').click()
  await scan('subtitles export')
  await page.getByTestId('subtitle-import').click()
  await page.waitForTimeout(300)
  await scan('subtitles import menu')
  await page.keyboard.press('Escape')
  for (const menu of ['file', 'edit', 'window', 'help']) {
    await page.getByTestId(`menu-${menu}`).click()
    await scan(`${menu} menu`)
    await page.keyboard.press('Escape')
  }
  for (const modal of ['export', 'shortcuts', 'about', 'language', 'close', 'presetImport']) {
    await page.evaluate((modal) => {
      const media = window.__cw.get().project.media
      // The preset question, listing one file that exists and one that has moved.
      const presetPrompt = { presetName: 'clip', files: media.map((item, i) => ({ item, exists: i === 0 })), answer: () => {} }
      window.__cw.set({ modal, pendingAfterClose: () => {}, presetPrompt })
    }, modal)
    await page.waitForSelector('.modal')
    await scan(`${modal} dialog`)
    await page.screenshot({ path: join(shots, `i18n-${label}-${modal}.png`) })
    await page.evaluate(() => window.__cw.set({ modal: null, pendingAfterClose: null, presetPrompt: null }))
  }
  // Every page of the Settings window.
  await page.evaluate(() => window.__cw.set({ modal: 'settings' }))
  for (const p of ['general', 'timeline', 'shortcuts']) {
    await page.getByTestId(`settings-page-${p}`).click()
    await scan(`settings: ${p}`)
  }
  await page.evaluate(() => window.__cw.set({ modal: null }))
  // Every toast and status message is a message too; trigger a few.
  await page.evaluate(async (f) => {
    const a = window.__cw.actions
    window.__cw.player.seek(30)
    a.splitAction()
    await a.importPaths([f.image])
  }, files)
  await page.waitForTimeout(100)
  await scan('toasts')
  return problems
}

// ---------------------------------------------------------------- run

let { app, page, errors } = await launch()

step('set up a project that shows every kind of clip')
await page.evaluate(async (f) => {
  const { actions, edit, get, set } = window.__cw
  const items = await actions.importPaths([f.video, f.image])
  actions.addToTimeline(items[0].id, 0)
  actions.addToTimeline(items[1].id, 4)
  actions.addTextAction()
  const trackId = actions.newSubtitleTrackAction()
  window.__cw.player.seek(1)
  await actions.addCueAction()
  const cue = get().project.subtitles[0].cues[0]
  actions.updateCueAction(trackId, cue.id, { text: 'Hello there' })
  actions.addSubtitlesToTimelineAction(trackId)
  const video = get().project.clips.find((c) => c.type === 'video')
  edit((p) => {
    const c = p.clips.find((x) => x.id === video.id)
    for (const type of ['colorMask', 'imageMask', 'differenceMask', 'blur', 'dropShadow']) c.effects.push({ id: type, type, enabled: true, params: {} })
    c.transform.animate = true
    c.zoom.enabled = true
    // A partial loop into an outro, so the Properties window shows every loop setting and its warning.
    c.loop = { start: 1, end: 2, count: 1.5, intro: true, outro: true, crossfade: 0.4 }
  })
  set({ selection: [video.id] })
  // A saved preset, so the Presets section shows one.
  await window.__cw.presets.savePresetAction('clip')
}, files)
await page.waitForFunction(() => window.__cw.get().project.media.every((m) => window.__cw.get().mediaCache[m.id]?.posterUrl || m.kind === 'audio'), null, { timeout: 30000 }).catch(() => {})

step('English has no pseudo-language text and the Language dialog opens from the Edit menu')
check(await page.evaluate(() => document.documentElement.lang) === 'en', 'starts in English on an English system')
await page.getByTestId('menu-edit').click()
await page.getByTestId('menu-language').click()
check(await page.locator('[data-testid=language-option]').count() >= 4, 'lists System default, English, Japanese and the pseudo-language')
check(await page.locator('[data-language=ja]').innerText().then((s) => s.includes('日本語')), 'Japanese is listed by its own name')

step('pseudo-language: nothing is hard-coded')
await page.locator('[data-language=en-XA] input').check()
check(await page.evaluate(() => document.documentElement.lang) === 'en-XA', 'switched to the pseudo-language')
check(/^\[/.test(await page.locator('.dv-tab').first().innerText()), 'window tabs are retitled straight away')
await page.keyboard.press('Escape')
const pseudo = await sweep(page, 'pseudo')
await page.screenshot({ path: join(shots, 'i18n-pseudo.png') })

step('Japanese: everything is translated')
await page.evaluate(() => window.__cw.set({ modal: 'language' }))
await page.locator('[data-language=ja] input').check()
check(await page.evaluate(() => document.documentElement.lang) === 'ja', 'switched to Japanese')
check(await page.getByTestId('menu-edit').innerText() === '編集', 'menus are in Japanese')
await page.keyboard.press('Escape')
const japanese = await sweep(page, 'ja')
await page.screenshot({ path: join(shots, 'i18n-ja.png') })

const problems = [...pseudo, ...japanese]
if (problems.length) {
  console.log(`\n${problems.length} untranslated texts:\n` + [...new Set(problems)].join('\n'))
  await app.evaluate(({ app }) => app.exit(0))
  process.exit(1)
}
check(true, 'no hard-coded or untranslated text in any window, menu or dialog')

step('the choice is remembered after a restart')
await page.evaluate(() => window.__cw.set({ dirty: false }))
await page.waitForTimeout(600) // settings are written shortly after a change
await app.evaluate(({ app }) => app.exit(0))
;({ app, page, errors } = await launch())
check(await page.evaluate(() => document.documentElement.lang) === 'ja', 'still Japanese after restarting')
check(await page.getByTestId('menu-file').innerText() === 'ファイル', 'menus are in Japanese after restarting')
await page.evaluate(() => window.__cw.set({ modal: 'language' }))
await page.locator('[data-language=system] input').check()
check(await page.evaluate(() => document.documentElement.lang) === 'en', 'System default goes back to English on an English system')

await app.evaluate(({ app }) => app.exit(0))
rmSync(dir, { recursive: true, force: true })
const real = errors.filter((e) => !/Autofill|DevTools/.test(e))
if (real.length) { console.log('Renderer errors:\n' + real.join('\n')); process.exit(1) }
console.log('\nAll language UI checks passed.')

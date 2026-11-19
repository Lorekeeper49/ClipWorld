// Translation catalogue checks. These are what make it safe to merge a translation without reading it:
// every message the code asks for exists in English, and every translation file only has messages English
// has, with the same {{placeholders}} and plural forms that are valid for its language.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { EASE_NAMES } from '@shared/easing'
import { EFFECTS } from '@shared/effects'
import { AUDIO_CODECS, CONTAINERS, VIDEO_CODECS } from '@shared/formats'
import {
  PSEUDO_LANGUAGE, SOURCE_LANGUAGE, completeness, flatten, languages, messagesFor, pseudoize, resolveLanguage, setLanguage, t
} from '@shared/i18n'
import { SUBTITLE_FORMATS } from '@shared/subtitles'

const ROOT = join(__dirname, '..')
const en = flatten(messagesFor(SOURCE_LANGUAGE)!)
const PLURAL = /_(zero|one|two|few|many|other)$/
const base = (k: string) => k.replace(PLURAL, '')
const enBase = new Set(Object.keys(en).map(base))
const has = (key: string) => enBase.has(key)
const placeholders = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort()

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('English messages', () => {
  test('every message key written in the code exists', () => {
    const missing: string[] = []
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\b(t|tx)\(\s*'([\w.]+)'/g)) if (!has(m[2])) missing.push(`${m[2]}  (${file.slice(ROOT.length + 1)})`)
      // The menu bar names shortcut actions with a('<action id>').
      if (file.endsWith('MenuBar.tsx')) for (const m of src.matchAll(/\ba\('([\w.]+)'\)/g)) if (!has(`actions.${m[1]}`)) missing.push(`actions.${m[1]}`)
    }
    expect(missing).toEqual([])
  })

  test('everything named by id has a message', () => {
    // The shortcut list lives in renderer code that needs a browser, so read its ids from the source.
    const shortcutSrc = readFileSync(join(ROOT, 'src', 'renderer', 'state', 'shortcuts.ts'), 'utf8')
    const SHORTCUTS = [...shortcutSrc.matchAll(/\{ id: '([\w.]+)', group: '(\w+)'/g)].map((m) => ({ id: m[1], group: m[2] }))
    expect(SHORTCUTS.length).toBeGreaterThan(20)
    const keys: string[] = []
    for (const e of EFFECTS) {
      keys.push(`effects.${e.type}.name`, `effects.groups.${e.group}`)
      for (const p of e.params) {
        keys.push(`effects.${e.type}.params.${p.key}`)
        for (const o of p.options ?? []) keys.push(`effects.${e.type}.options.${p.key}.${o.value}`)
      }
      if (e.kind === 'mask') keys.push(`tools.mask.hints.${e.type}`)
    }
    for (const e of EASE_NAMES) keys.push(`easing.${e}`)
    for (const c of CONTAINERS) keys.push(`formats.containers.${c.id}`)
    for (const v of Object.values(VIDEO_CODECS)) {
      keys.push(`formats.video.${v.id}`)
      for (const enc of v.encoders) keys.push(`formats.encoders.${enc.id}`)
    }
    for (const a of Object.values(AUDIO_CODECS)) keys.push(`formats.audio.${a.id}`)
    for (const f of SUBTITLE_FORMATS) keys.push(`subtitleFormats.${f.id}`)
    for (const p of ['media', 'subtitles', 'preview', 'tools', 'properties', 'metadata', 'audio', 'timeline']) keys.push(`panels.${p}`)
    for (const k of ['video', 'audio', 'image', 'text', 'subtitles']) keys.push(`properties.kinds.${k}`)
    for (const k of ['general', 'timeline', 'shortcuts']) keys.push(`settings.pages.${k}`)
    for (const m of ['file', 'edit', 'window', 'help']) keys.push(`menu.${m}`)
    for (const k of ['video', 'audio', 'image', 'animated']) keys.push(`metadata.kinds.${k}`)
    for (const k of ['vertical', 'portrait', 'square']) keys.push(`metadata.presets.${k}`)
    for (const k of ['draft', 'good', 'high', 'veryHigh', 'maximum']) keys.push(`export.qualities.${k}`)
    for (const k of ['left', 'center', 'right']) keys.push(`tools.text.align.${k}`, `tools.text.alignTitle.${k}`)
    for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) keys.push(`tools.transform.fields.${k}`)
    for (const k of ['bottom', 'middle', 'top']) keys.push(`subtitles.positions.${k}`)
    for (const w of ['image', 'imageOrVideo']) for (const k of ['choose', 'missing', 'unusable']) keys.push(`tools.picker.${w}.${k}`)
    for (const g of ['File', 'Edit', 'Playback', 'Timeline', 'Subtitles']) keys.push(`shortcuts.groups.${g}`)
    for (const s of SHORTCUTS) keys.push(`actions.${s.id}`, `shortcuts.groups.${s.group}`)
    expect(keys.filter((k) => !has(k))).toEqual([])
  })

  test('no message is empty, and plural forms come in English pairs', () => {
    expect(Object.entries(en).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([])
    const plural = Object.keys(en).filter((k) => PLURAL.test(k))
    for (const k of plural) {
      expect(en[`${base(k)}_one`], `${base(k)}_one`).toBeDefined()
      expect(en[`${base(k)}_other`], `${base(k)}_other`).toBeDefined()
    }
  })
})

describe('translation files', () => {
  const codes = readdirSync(join(ROOT, 'src', 'locales')).map((f) => f.replace(/\.json$/, '')).filter((c) => c !== SOURCE_LANGUAGE)

  test.each(codes)('%s is valid', (code) => {
    // Parses (a syntax error would have failed the import already) and only uses English's keys.
    const msgs = flatten(messagesFor(code)!)
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories as string[]
    const problems: string[] = []
    for (const [key, text] of Object.entries(msgs)) {
      const b = base(key)
      if (!enBase.has(b)) {
        problems.push(`${key}: not in English (renamed or removed?)`)
        continue
      }
      if (!text.trim()) problems.push(`${key}: empty`)
      const m = PLURAL.exec(key)
      if (m && !categories.includes(m[1])) problems.push(`${key}: "${m[1]}" is not a plural form in ${code} (use ${categories.join(', ')})`)
      // Placeholders must match English (the plural form's English, or the plain message's).
      const english = en[key] ?? en[`${b}_other`] ?? en[b]
      const want = placeholders(english).filter((p) => p !== 'count')
      const got = placeholders(text).filter((p) => p !== 'count')
      if (want.join() !== got.join()) problems.push(`${key}: placeholders {{${got.join('}}, {{')}}} should be {{${want.join('}}, {{')}}}`)
    }
    expect(problems).toEqual([])
  })

  test('the language list includes every file, English first and the pseudo-language last', () => {
    const list = languages()
    expect(list[0]).toBe(SOURCE_LANGUAGE)
    expect(list[list.length - 1]).toBe(PSEUDO_LANGUAGE)
    for (const c of codes) expect(list).toContain(c)
  })

  test('completeness counts plural forms once', () => {
    expect(completeness(SOURCE_LANGUAGE)).toBe(1)
    for (const c of codes) {
      const v = completeness(c)
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('runtime', () => {
  test('placeholders, plurals and English fallback', () => {
    setLanguage('en')
    expect(t('common.audioTracks', { count: 1 })).toBe('1 audio track')
    expect(t('common.audioTracks', { count: 3 })).toBe('3 audio tracks')
    expect(t('close.message', { name: 'Trip' })).toBe('“Trip” has changes that have not been saved.')
    // A message without plural forms is used for any count.
    expect(t('export.separate', { count: 3 })).toBe('Keep 3 separate tracks')
  })

  test('the pseudo-language keeps placeholders and marks every message', () => {
    expect(pseudoize('Removed {{name}}')).toMatch(/^\[Ŕéɱöṽéđ \{\{name\}\} ~+\]$/)
    setLanguage(PSEUDO_LANGUAGE)
    const s = t('toasts.removed', { name: 'clip.mp4' })
    expect(s.startsWith('[')).toBe(true)
    expect(s).toContain('clip.mp4')
    expect(t('common.audioTracks', { count: 2 })).toContain('2')
    setLanguage('en')
  })

  test('picks the chosen language, else the best system language, else English', () => {
    const others = languages().filter((c) => c !== SOURCE_LANGUAGE && c !== PSEUDO_LANGUAGE)
    expect(resolveLanguage(undefined, ['xx-YY'])).toBe('en')
    expect(resolveLanguage('system', [])).toBe('en')
    expect(resolveLanguage('zz', ['en-GB'])).toBe('en')
    expect(resolveLanguage(PSEUDO_LANGUAGE, ['ja-JP'])).toBe(PSEUDO_LANGUAGE)
    for (const c of others) {
      expect(resolveLanguage(undefined, [`${c}-XX`, 'en-US'])).toBe(c)
      expect(resolveLanguage('system', ['xx', c])).toBe(c)
      expect(resolveLanguage('en', [c])).toBe('en')
    }
  })
})

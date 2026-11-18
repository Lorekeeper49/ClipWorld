// Translations. Every piece of text the app shows lives in src/locales/<language>.json (i18next JSON v4:
// nested keys, {{placeholders}}, plural forms as key_one / key_other / ...). English is the source and
// the fallback: anything a translation lacks is shown in English, so a half-finished language still works.
// Used by both the renderer and the main process.
import i18next, { type TOptions } from 'i18next'

const files = import.meta.glob<Record<string, unknown>>('../locales/*.json', { eager: true, import: 'default' })

type Messages = { [key: string]: string | Messages }

export const SOURCE_LANGUAGE = 'en'
/**
 * The pseudo-language: English with accented letters, about 40% longer, in brackets. Text that still shows
 * plain English is hard-coded somewhere, and text that gets cut off will not fit longer languages.
 */
export const PSEUDO_LANGUAGE = 'en-XA'

const resources: Record<string, Messages> = {}
for (const [path, data] of Object.entries(files)) {
  const code = /([^/\\]+)\.json$/.exec(path)![1]
  resources[code] = data as Messages
}
if (!resources[SOURCE_LANGUAGE]) throw new Error('src/locales/en.json is missing')

const ACCENTS: Record<string, string> = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž'
}

/** Turns one English message into its pseudo-language version, leaving {{placeholders}} alone. */
export function pseudoize(text: string): string {
  const parts = text.split(/(\{\{[^}]*\}\}|\$t\([^)]*\))/)
  const body = parts.map((p, i) => (i % 2 ? p : p.replace(/[a-zA-Z]/g, (ch) => ACCENTS[ch] ?? ch))).join('')
  const letters = text.replace(/\{\{[^}]*\}\}/g, '').length
  return `[${body}${letters > 3 ? ' ' + '~'.repeat(Math.ceil(letters * 0.4)) : ''}]`
}

function mapMessages(m: Messages, fn: (s: string) => string): Messages {
  const out: Messages = {}
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === 'string' ? fn(v) : mapMessages(v, fn)
  return out
}
resources[PSEUDO_LANGUAGE] = mapMessages(resources[SOURCE_LANGUAGE], pseudoize)

/** Flattens messages to "a.b.c" keys. */
export function flatten(m: Messages, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(m)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else flatten(v, key, out)
  }
  return out
}

/** Every language with a file, English first, then the pseudo-language last. */
export function languages(): string[] {
  const real = Object.keys(resources).filter((c) => c !== SOURCE_LANGUAGE && c !== PSEUDO_LANGUAGE).sort()
  return [SOURCE_LANGUAGE, ...real, PSEUDO_LANGUAGE]
}

export function messagesFor(code: string): Messages | undefined {
  return resources[code]
}

/** A plural key's base name ("clips_one" -> "clips"). */
const PLURAL = /_(zero|one|two|few|many|other)$/
const baseKey = (k: string) => k.replace(PLURAL, '')

/** How much of the app a language covers, 0..1 (plural forms count once). */
export function completeness(code: string): number {
  if (code === SOURCE_LANGUAGE || code === PSEUDO_LANGUAGE) return 1
  const src = new Set(Object.keys(flatten(resources[SOURCE_LANGUAGE])).map(baseKey))
  const have = new Set(Object.keys(flatten(resources[code] ?? {})).map(baseKey).filter((k) => src.has(k)))
  return src.size ? have.size / src.size : 0
}

/** A language's name in that language ("日本語"), for the language picker. */
export function languageName(code: string, inLanguage = code): string {
  if (code === PSEUDO_LANGUAGE) return 'Pseudo-language'
  try {
    const name = new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code)
    if (name) return name.charAt(0).toLocaleUpperCase(inLanguage) + name.slice(1)
  } catch {
    // Unknown to this Intl build: fall through.
  }
  return code
}

/**
 * The language to show: the user's choice if a file exists for it, otherwise the first of the system's
 * preferred languages we have (matching "ja-JP" to "ja", "pt-BR" to "pt-BR" then "pt"), otherwise English.
 */
export function resolveLanguage(preference: string | undefined, system: readonly string[]): string {
  const have = new Set(Object.keys(resources))
  if (preference && preference !== 'system' && have.has(preference)) return preference
  for (const tag of system) {
    if (have.has(tag) && tag !== PSEUDO_LANGUAGE) return tag
    const base = tag.split('-')[0]
    if (have.has(base)) return base
  }
  return SOURCE_LANGUAGE
}

const i18n = i18next.createInstance()
void i18n.init({
  resources: Object.fromEntries(Object.entries(resources).map(([k, v]) => [k, { translation: v }])),
  lng: SOURCE_LANGUAGE,
  fallbackLng: SOURCE_LANGUAGE,
  initAsync: false,
  // React and native dialogs both escape text themselves.
  interpolation: { escapeValue: false },
  returnNull: false
})

export function setLanguage(code: string): void {
  void i18n.changeLanguage(code)
}

export function currentLanguage(): string {
  return i18n.language
}

/** Looks up a message. Missing keys show the key itself, which the tests catch. */
export function t(key: string, options?: TOptions): string {
  return i18n.t(key, options as never) as unknown as string
}

/** Whether a message exists (in the current language or in English). */
export function hasMessage(key: string): boolean {
  return i18n.exists(key)
}

/** Formats a number for the current language (decimal separators, digit grouping). */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  const lang = i18n.language === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : i18n.language
  return new Intl.NumberFormat(lang, options).format(n)
}

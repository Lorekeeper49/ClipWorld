// Display names for things defined as data (effects, easing curves, export formats, subtitle formats).
// The names themselves are messages in src/locales, keyed by each item's id.
import type { EaseName } from './model'
import type { EffectDef, ParamDef } from './effects'
import { currentLanguage, t } from './i18n'

export const effectName = (def: EffectDef): string => t(`effects.${def.type}.name`)
export const effectGroupName = (group: string): string => t(`effects.groups.${group}`)
export const paramName = (def: EffectDef, p: ParamDef): string => t(`effects.${def.type}.params.${p.key}`)
export const optionName = (def: EffectDef, p: ParamDef, value: string): string => t(`effects.${def.type}.options.${p.key}.${value}`)

/** "Bounce · In-out" for 'easeInOutBounce'; "Linear" for 'linear'. */
export function easeName(e: EaseName): string {
  const m = /^ease(InOut|In|Out)(\w+)$/.exec(e)
  if (!m) return t(`easing.${e}`)
  return t('easing.named', { family: t(`easing.families.${m[2]}`), kind: t(`easing.kinds.${m[1]}`) })
}

export const containerName = (id: string): string => t(`formats.containers.${id}`)
export const videoCodecName = (id: string): string => t(`formats.video.${id}`)
export const audioCodecName = (id: string): string => t(`formats.audio.${id}`)
export const encoderName = (id: string): string => t(`formats.encoders.${id}`)
export const subtitleFormatName = (id: string): string => t(`subtitleFormats.${id}`)

/** A subtitle language's name ("jpn" -> "Japanese", or "日本語" when the app is in Japanese). */
export function subtitleLanguageName(iso: string): string {
  if (iso === 'und') return t('subtitles.languageUnspecified')
  try {
    const lang = currentLanguage() === 'en-XA' ? 'en' : currentLanguage()
    const name = new Intl.DisplayNames([lang], { type: 'language' }).of(iso)
    if (name && name !== iso) return name
  } catch {
    // Not a code Intl knows.
  }
  return iso
}

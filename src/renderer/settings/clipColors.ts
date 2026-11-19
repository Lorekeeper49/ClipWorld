// Clip colours on the timeline: one per kind of clip, chosen in Settings ▸ Timeline. They are CSS
// variables, so every place that shows a clip's colour (timeline, Media window icons) follows along.
import type { AppSettings } from '@shared/ipc'

export const CLIP_KINDS = ['video', 'audio', 'image', 'text', 'subtitles'] as const
export type ClipKind = (typeof CLIP_KINDS)[number]

export const DEFAULT_CLIP_COLORS: Record<ClipKind, string> = {
  video: '#3f5fd6',
  audio: '#1d8f7a',
  image: '#b9822e',
  text: '#9a55d6',
  subtitles: '#8a6a1e'
}

const CSS_VAR: Record<ClipKind, string> = {
  video: '--clip-video',
  audio: '--clip-audio',
  image: '--clip-image',
  text: '--clip-text',
  subtitles: '--clip-subs'
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

export function clipColor(settings: AppSettings, kind: ClipKind): string {
  const c = settings.clipColors?.[kind]
  return isHex(c) ? c : DEFAULT_CLIP_COLORS[kind]
}

/** Whether a colour is light enough that marks drawn on it (waveforms, subtitle blocks) should be dark. */
export function isLight(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4
}

/** Ink for marks drawn over a clip of this colour. */
export const inkOn = (hex: string, alpha = 0.78): string => (isLight(hex) ? `rgba(0,0,0,${Math.min(0.7, alpha)})` : `rgba(255,255,255,${alpha})`)

export function applyClipColors(settings: AppSettings): void {
  const root = document.documentElement.style
  for (const kind of CLIP_KINDS) root.setProperty(CSS_VAR[kind], clipColor(settings, kind))
}

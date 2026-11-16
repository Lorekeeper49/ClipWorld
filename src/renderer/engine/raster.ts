// Canvas rasterisation shared by the live preview and the export: text and overlay effects
// (gradient, vignette). The export sends these exact pixels to ffmpeg as PNGs.
import { n, parseColor, s } from '@shared/effects'
import { type EffectInstance, REF_HEIGHT, type SubtitleStyle, type TextProps } from '@shared/model'

const LINE_HEIGHT = 1.2

function fontString(t: TextProps, px: number): string {
  const family = /["',]/.test(t.fontFamily) ? t.fontFamily : `"${t.fontFamily}"`
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${px}px ${family}, "Segoe UI", sans-serif`
}

let measureCtx: CanvasRenderingContext2D | null = null

export interface TextMetricsResult {
  /** Layer size in project pixels. */
  w: number
  h: number
  lines: string[]
  lineWidths: number[]
  pad: number
  fontPx: number
}

/** Measures a text clip for a project of frame height `H`. */
export function measureText(t: TextProps, H: number): TextMetricsResult {
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  const scale = H / REF_HEIGHT
  const fontPx = Math.max(1, t.fontSize * scale)
  const outline = Math.max(0, t.outlineWidth * scale)
  measureCtx.font = fontString(t, fontPx)
  const lines = (t.content || ' ').split(/\r?\n/)
  const lineWidths = lines.map((l) => measureCtx!.measureText(l || ' ').width)
  const pad = Math.ceil(outline + fontPx * 0.18)
  return {
    w: Math.max(2, Math.ceil(Math.max(...lineWidths) + pad * 2)),
    h: Math.max(2, Math.ceil(lines.length * fontPx * LINE_HEIGHT + pad * 2)),
    lines,
    lineWidths,
    pad,
    fontPx
  }
}

/** Draws a text clip onto a new canvas of (w*k) x (h*k) pixels. */
export function rasterText(t: TextProps, H: number, k: number): { canvas: HTMLCanvasElement; w: number; h: number } {
  const m = measureText(t, H)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(m.w * k))
  canvas.height = Math.max(2, Math.round(m.h * k))
  const ctx = canvas.getContext('2d')!
  ctx.scale(canvas.width / m.w, canvas.height / m.h)
  ctx.font = fontString(t, m.fontPx)
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  const outline = Math.max(0, t.outlineWidth * (H / REF_HEIGHT))
  const inner = m.w - m.pad * 2
  m.lines.forEach((line, i) => {
    const lw = m.lineWidths[i]
    const x = m.pad + (t.align === 'left' ? 0 : t.align === 'right' ? inner - lw : (inner - lw) / 2)
    const y = m.pad + (i + 0.5) * m.fontPx * LINE_HEIGHT
    if (outline > 0) {
      ctx.strokeStyle = t.outline
      ctx.lineWidth = outline * 2
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = t.fill
    ctx.fillText(line, x, y)
  })
  return { canvas, w: m.w, h: m.h }
}

/** Splits text into lines no wider than `maxW`, breaking at spaces (or inside words that don't fit). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width <= maxW || !line) {
        // A single word wider than the line is broken by characters.
        while (!line && ctx.measureText(word).width > maxW && word.length > 1) {
          let cut = word.length - 1
          while (cut > 1 && ctx.measureText(word.slice(0, cut)).width > maxW) cut--
          out.push(word.slice(0, cut))
          word = word.slice(cut)
        }
        line = line ? `${line} ${word}` : word
      } else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Draws one subtitle cue onto a full-frame transparent canvas of (W*k) x (H*k) pixels, positioned and
 * styled by the track's style. The preview and the export both use this, so they match exactly.
 */
export function rasterSubtitle(text: string, st: SubtitleStyle, W: number, H: number, k: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(W * k))
  canvas.height = Math.max(2, Math.round(H * k))
  const trimmed = text.trim()
  if (!trimmed) return canvas
  const ctx = canvas.getContext('2d')!
  ctx.scale(canvas.width / W, canvas.height / H)
  const scale = H / REF_HEIGHT
  const fontPx = Math.max(1, st.fontSize * scale)
  const outline = Math.max(0, st.outlineWidth * scale)
  const family = /["',]/.test(st.fontFamily) ? st.fontFamily : `"${st.fontFamily}"`
  ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${fontPx}px ${family}, "Segoe UI", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  const maxW = Math.max(fontPx, Math.min(1, Math.max(0.1, st.maxWidth)) * W)
  const rows = wrapLines(ctx, trimmed, maxW)
  const lineH = fontPx * 1.25
  const blockH = rows.length * lineH
  const margin = Math.min(0.45, Math.max(0, st.margin)) * H
  const top = st.position === 'top' ? margin : st.position === 'middle' ? (H - blockH) / 2 : H - margin - blockH
  const left = (W - maxW) / 2
  const padX = fontPx * 0.35
  const padY = fontPx * 0.08
  rows.forEach((row, i) => {
    const w = ctx.measureText(row).width
    const x = st.align === 'left' ? left : st.align === 'right' ? left + maxW - w : (W - w) / 2
    const y = top + (i + 0.5) * lineH
    if (st.box && row) {
      ctx.fillStyle = rgba(st.boxColor, Math.min(1, Math.max(0, st.boxOpacity)))
      ctx.fillRect(x - padX, y - lineH / 2 - padY, w + padX * 2, lineH + padY * 2)
    }
    if (outline > 0) {
      ctx.strokeStyle = st.outline
      ctx.lineWidth = outline * 2
      ctx.strokeText(row, x, y)
    }
    ctx.fillStyle = st.fill
    ctx.fillText(row, x, y)
  })
  return canvas
}

/** Draws an overlay effect (gradient or vignette) covering a w x h rectangle. */
export function drawOverlayEffect(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, e: EffectInstance, w: number, h: number): void {
  ctx.save()
  if (e.type === 'gradient') {
    const a = (n(e, 'angle') * Math.PI) / 180
    const dx = Math.sin(a)
    const dy = -Math.cos(a)
    const len = Math.abs(w * dx) + Math.abs(h * dy)
    const cx = w / 2
    const cy = h / 2
    const g = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2)
    g.addColorStop(0, s(e, 'color1'))
    g.addColorStop(1, s(e, 'color2'))
    ctx.globalAlpha = Math.min(1, Math.max(0, n(e, 'opacity')))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  } else if (e.type === 'vignette') {
    const amount = Math.min(1, Math.max(0, n(e, 'amount')))
    const size = Math.min(1, Math.max(0, n(e, 'size')))
    // An ellipse matching the frame: work in a space where the frame spans -1..1 on both axes,
    // so the corners sit at radius sqrt(2).
    ctx.translate(w / 2, h / 2)
    ctx.scale(w / 2, h / 2)
    const g = ctx.createRadialGradient(0, 0, Math.SQRT2 * size * 0.95, 0, 0, Math.SQRT2)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `rgba(0,0,0,${amount})`)
    ctx.fillStyle = g
    ctx.fillRect(-1, -1, 2, 2)
  }
  ctx.restore()
}

export function rasterOverlay(e: EffectInstance, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(w))
  canvas.height = Math.max(2, Math.round(h))
  drawOverlayEffect(canvas.getContext('2d')!, e, canvas.width, canvas.height)
  return canvas
}

export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('Could not encode image')
  return new Uint8Array(await blob.arrayBuffer())
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseColor(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

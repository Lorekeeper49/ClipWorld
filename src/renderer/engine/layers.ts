// Renders one clip's layer for the preview: effects, zoom and drop shadow, in the same order the
// export's filter graph applies them (see shared/filtergraph.ts).
import { zoomAt } from '@shared/easing'
import { EFFECT_MAP, b, cssFilter, n, parseColor, s } from '@shared/effects'
import type { Clip, EffectInstance } from '@shared/model'
import { rasterOverlay, rgba } from './raster'

type Ctx = CanvasRenderingContext2D

export class Scratch {
  private canvases: HTMLCanvasElement[] = []
  get(i: number, w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
    let c = this.canvases[i]
    if (!c) {
      c = document.createElement('canvas')
      this.canvases[i] = c
    }
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.shadowColor = 'transparent'
    ctx.imageSmoothingEnabled = true
    ctx.clearRect(0, 0, w, h)
    return { canvas: c, ctx }
  }
}

const scratch = new Scratch()

// ---------------------------------------------------------------- overlay cache

const overlayCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>()

function overlayFor(e: EffectInstance, w: number, h: number): HTMLCanvasElement {
  const key = `${JSON.stringify(e.params)}|${w}x${h}`
  const hit = overlayCache.get(e.id)
  if (hit && hit.key === key) return hit.canvas
  const canvas = rasterOverlay(e, w, h)
  overlayCache.set(e.id, { key, canvas })
  if (overlayCache.size > 64) overlayCache.delete(overlayCache.keys().next().value!)
  return canvas
}

// ---------------------------------------------------------------- sharpen (SVG convolution)

let svgDefs: SVGDefsElement | null = null
const sharpenIds = new Map<number, string>()

function sharpenFilter(amount: number): string {
  const a = Math.round(Math.min(2, Math.max(0, amount)) * 100) / 100
  let id = sharpenIds.get(a)
  if (id) return id
  if (!svgDefs) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svgDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    svg.appendChild(svgDefs)
    document.body.appendChild(svg)
  }
  id = `cw-sharpen-${sharpenIds.size}`
  const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter')
  f.setAttribute('id', id)
  f.setAttribute('color-interpolation-filters', 'sRGB')
  f.setAttribute('x', '0')
  f.setAttribute('y', '0')
  f.setAttribute('width', '100%')
  f.setAttribute('height', '100%')
  const conv = document.createElementNS('http://www.w3.org/2000/svg', 'feConvolveMatrix')
  conv.setAttribute('order', '3')
  conv.setAttribute('preserveAlpha', 'true')
  conv.setAttribute('edgeMode', 'duplicate')
  conv.setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`)
  f.appendChild(conv)
  svgDefs.appendChild(f)
  sharpenIds.set(a, id)
  return id
}

// ---------------------------------------------------------------- film grain

let noiseTile: HTMLCanvasElement | null = null

function getNoiseTile(): HTMLCanvasElement {
  if (noiseTile) return noiseTile
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(256, 256)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.random() * 255
    img.data[i + 1] = Math.random() * 255
    img.data[i + 2] = Math.random() * 255
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  noiseTile = c
  return c
}

// ---------------------------------------------------------------- chroma key (WebGL)

interface KeyGl {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  tex: WebGLTexture
  u: Record<string, WebGLUniformLocation | null>
}
let keyGl: KeyGl | null | undefined

function initKeyGl(): KeyGl | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true })
  if (!gl) return null
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vs, 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.0,1.0);}')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  // Mirrors ffmpeg's chromakey: distance in the U/V plane, averaged over a 3x3 neighbourhood.
  gl.shaderSource(fs, `precision mediump float;
uniform sampler2D tex;uniform vec2 texel;uniform vec2 key;uniform float sim;uniform float blend;varying vec2 uv;
vec2 toUV(vec3 c){return vec2(-0.148*c.r-0.291*c.g+0.439*c.b,0.439*c.r-0.368*c.g-0.071*c.b)+128.0/255.0;}
void main(){vec4 c=texture2D(tex,uv);float diff=0.0;
for(int x=-1;x<=1;x++){for(int y=-1;y<=1;y++){vec2 d=toUV(texture2D(tex,uv+vec2(float(x),float(y))*texel).rgb)-key;diff+=sqrt(dot(d,d)/2.0);}}
diff/=9.0;float a=blend>0.0001?clamp((diff-sim)/blend,0.0,1.0):(diff>sim?1.0:0.0);a*=c.a;gl_FragColor=vec4(c.rgb*a,a);}`)
  gl.compileShader(fs)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const u: KeyGl['u'] = {}
  for (const name of ['texel', 'key', 'sim', 'blend']) u[name] = gl.getUniformLocation(prog, name)
  return { canvas, gl, tex, u }
}

function chromaKey(src: HTMLCanvasElement, e: EffectInstance): HTMLCanvasElement | null {
  if (keyGl === undefined) keyGl = initKeyGl()
  if (!keyGl) return null
  const { canvas, gl, tex, u } = keyGl
  if (canvas.width !== src.width || canvas.height !== src.height) {
    canvas.width = src.width
    canvas.height = src.height
  }
  gl.viewport(0, 0, canvas.width, canvas.height)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  const [r, g, bl] = parseColor(s(e, 'color'))
  gl.uniform2f(u.texel, 1 / canvas.width, 1 / canvas.height)
  gl.uniform2f(u.key, (-0.16874 * r - 0.33126 * g + 0.5 * bl + 128) / 255, (0.5 * r - 0.41869 * g - 0.08131 * bl + 128) / 255)
  gl.uniform1f(u.sim, Math.min(1, Math.max(0.01, n(e, 'similarity'))))
  gl.uniform1f(u.blend, Math.min(1, Math.max(0, n(e, 'smoothness'))))
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return canvas
}

// ---------------------------------------------------------------- masks
//
// Masks produce a canvas whose alpha is the mask (1 shows, 0 hides), which is then multiplied into the
// layer with 'destination-in'. The colour and difference masks use the same formula as ffmpeg's
// colorkey: diff = |rgb - key| / sqrt(3) on 0..1 channels, then (diff - tolerance) / softness.

interface GlFilter {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  textures: WebGLTexture[]
  u: Record<string, WebGLUniformLocation | null>
}

function makeGlFilter(fragment: string, uniforms: string[], inputs: number): GlFilter | null {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true })
  if (!gl) return null
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vs, 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.0,1.0);}')
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fs, `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
${fragment}`)
  gl.compileShader(fs)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('mask shader failed', gl.getShaderInfoLog(fs))
    return null
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const textures: WebGLTexture[] = []
  for (let i = 0; i < inputs; i++) {
    const tex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(prog, `tex${i}`), i)
    textures.push(tex)
  }
  const u: GlFilter['u'] = {}
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name)
  return { canvas, gl, textures, u }
}

function runGlFilter(f: GlFilter, sources: CanvasImageSource[], w: number, h: number, set: (gl: WebGLRenderingContext, u: GlFilter['u']) => void): HTMLCanvasElement {
  const { canvas, gl, textures, u } = f
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  sources.forEach((src, i) => {
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, textures[i])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource)
  })
  set(gl, u)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  return canvas
}

const KEY_RAMP = 'float ramp(float diff){return blend>0.0001?clamp((diff-sim)/blend,0.0,1.0):(diff>sim?1.0:0.0);}'
let colorGl: GlFilter | null | undefined
let diffGl: GlFilter | null | undefined

/** Mask that hides one colour (alpha 0 where the layer is that colour). */
function colorMaskCanvas(src: HTMLCanvasElement, e: EffectInstance): HTMLCanvasElement | null {
  if (colorGl === undefined) {
    colorGl = makeGlFilter(
      `uniform sampler2D tex0;uniform vec3 key;uniform float sim;uniform float blend;varying vec2 uv;${KEY_RAMP}
void main(){vec3 d=texture2D(tex0,uv).rgb-key;float m=ramp(sqrt(dot(d,d)/3.0));gl_FragColor=vec4(m);}`,
      ['key', 'sim', 'blend'], 1
    )
  }
  if (!colorGl) return null
  const [r, g, bl] = parseColor(s(e, 'color'))
  return runGlFilter(colorGl, [src], src.width, src.height, (gl, u) => {
    gl.uniform3f(u.key, r / 255, g / 255, bl / 255)
    gl.uniform1f(u.sim, Math.min(1, Math.max(0.00001, n(e, 'tolerance'))))
    gl.uniform1f(u.blend, Math.min(1, Math.max(0, n(e, 'softness'))))
  })
}

/** Mask that hides whatever matches the reference picture (difference mask). */
export function differenceMaskCanvas(src: HTMLCanvasElement, reference: CanvasImageSource, e: EffectInstance): HTMLCanvasElement | null {
  if (diffGl === undefined) {
    diffGl = makeGlFilter(
      `uniform sampler2D tex0;uniform sampler2D tex1;uniform float sim;uniform float blend;varying vec2 uv;${KEY_RAMP}
void main(){vec3 d=texture2D(tex0,uv).rgb-texture2D(tex1,uv).rgb;float m=ramp(sqrt(dot(d,d)/3.0));gl_FragColor=vec4(m);}`,
      ['sim', 'blend'], 2
    )
  }
  if (!diffGl) return null
  return runGlFilter(diffGl, [src, reference], src.width, src.height, (gl, u) => {
    gl.uniform1f(u.sim, Math.min(1, Math.max(0.00001, n(e, 'tolerance'))))
    gl.uniform1f(u.blend, Math.min(1, Math.max(0, n(e, 'softness'))))
  })
}

const imageMasks = new Map<string, HTMLCanvasElement>()

/** Mask from an image stretched over the layer: its brightness (or transparency) becomes the mask. */
function imageMaskCanvas(img: HTMLImageElement, mode: string, w: number, h: number): HTMLCanvasElement {
  const key = `${img.src}|${w}x${h}|${mode}`
  let hit = imageMasks.get(key)
  if (hit) return hit
  hit = document.createElement('canvas')
  hit.width = w
  hit.height = h
  const ctx = hit.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  const px = data.data
  for (let i = 0; i < px.length; i += 4) {
    // Same weights as the export (colorchannelmixer 0.299/0.587/0.114).
    const v = mode === 'alpha' ? px[i + 3] : Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])
    px[i] = px[i + 1] = px[i + 2] = 255
    px[i + 3] = v
  }
  ctx.putImageData(data, 0, 0)
  imageMasks.set(key, hit)
  if (imageMasks.size > 16) imageMasks.delete(imageMasks.keys().next().value!)
  return hit
}

/**
 * Multiplies `target`'s alpha by a mask canvas after the mask's invert and feather. Feathering extends
 * the mask's edges before blurring, like ffmpeg's gblur, so the frame border stays solid.
 */
export function applyMask(
  target: { canvas: HTMLCanvasElement; ctx: Ctx }, mask: CanvasImageSource, e: EffectInstance, featherPx: number, sc: Scratch
): void {
  const w = target.canvas.width
  const h = target.canvas.height
  let m: CanvasImageSource = mask
  if (b(e, 'invert')) {
    const inv = sc.get(6, w, h)
    inv.ctx.fillStyle = '#fff'
    inv.ctx.fillRect(0, 0, w, h)
    inv.ctx.globalCompositeOperation = 'destination-out'
    inv.ctx.drawImage(m, 0, 0, w, h)
    inv.ctx.globalCompositeOperation = 'source-over'
    m = inv.canvas
  }
  if (featherPx > 0.05) {
    const ext = Math.ceil(featherPx * 3)
    const pad = sc.get(8, w + ext * 2, h + ext * 2)
    const src = m
    pad.ctx.drawImage(src, 0, 0, 1, h, 0, ext, ext, h)
    pad.ctx.drawImage(src, w - 1, 0, 1, h, w + ext, ext, ext, h)
    pad.ctx.drawImage(src, 0, 0, w, 1, ext, 0, w, ext)
    pad.ctx.drawImage(src, 0, h - 1, w, 1, ext, h + ext, w, ext)
    pad.ctx.drawImage(src, 0, 0, 1, 1, 0, 0, ext, ext)
    pad.ctx.drawImage(src, w - 1, 0, 1, 1, w + ext, 0, ext, ext)
    pad.ctx.drawImage(src, 0, h - 1, 1, 1, 0, h + ext, ext, ext)
    pad.ctx.drawImage(src, w - 1, h - 1, 1, 1, w + ext, h + ext, ext, ext)
    pad.ctx.drawImage(src, ext, ext, w, h)
    const blurred = sc.get(7, w, h)
    blurred.ctx.filter = `blur(${featherPx}px)`
    blurred.ctx.drawImage(pad.canvas, -ext, -ext)
    blurred.ctx.filter = 'none'
    m = blurred.canvas
  }
  target.ctx.globalCompositeOperation = 'destination-in'
  target.ctx.drawImage(m, 0, 0, w, h)
  target.ctx.globalCompositeOperation = 'source-over'
}

/** What the layer renderer needs from the player: loaded images for image masks. */
export interface LayerEnv {
  image(mediaId: string): HTMLImageElement | null
}

// ---------------------------------------------------------------- layer rendering

export interface LayerResult {
  image: CanvasImageSource
  /** Extra margin around the layer (drop shadow), in canvas pixels. */
  pad: number
}

export function needsProcessing(clip: Clip): boolean {
  if (clip.zoom.enabled && (clip.zoom.start !== 1 || clip.zoom.end !== 1)) return true
  return clip.effects.some((e) => e.enabled && EFFECT_MAP[e.type]?.target === 'video' && e.type !== 'fadeIn' && e.type !== 'fadeOut')
}

/**
 * @param cw,ch  layer size in canvas pixels
 * @param pxRef  canvas pixels per reference pixel (REF_HEIGHT-based units such as blur radius)
 */
export function renderLayer(
  clip: Clip, source: CanvasImageSource, cw: number, ch: number, pxRef: number, local: number, env?: LayerEnv
): LayerResult {
  if (!needsProcessing(clip)) return { image: source, pad: 0 }

  let a = scratch.get(0, cw, ch)
  let bScratch = 1
  const other = () => {
    const next = scratch.get(bScratch, cw, ch)
    bScratch = bScratch === 1 ? 0 : 1
    return next
  }
  a.ctx.drawImage(source, 0, 0, cw, ch)

  // Colour and image masks come first, as in the export. (The difference mask is applied by the
  // player after placement, since it compares the placed clip with what is underneath.)
  for (const e of clip.effects) {
    if (!e.enabled) continue
    if (e.type === 'colorMask') {
      const m = colorMaskCanvas(a.canvas, e)
      if (m) applyMask(a, m, e, n(e, 'feather') * pxRef, scratch)
    } else if (e.type === 'imageMask') {
      const img = env?.image(s(e, 'image'))
      if (img) applyMask(a, imageMaskCanvas(img, s(e, 'mode'), cw, ch), e, n(e, 'feather') * pxRef, scratch)
    }
  }

  const effects = clip.effects.filter((e) => e.enabled && EFFECT_MAP[e.type]?.target === 'video')
  let i = 0
  while (i < effects.length) {
    const e = effects[i]
    const def = EFFECT_MAP[e.type]
    if (def.kind === 'css') {
      // Consecutive CSS-filter effects collapse into one filter pass.
      const parts: string[] = []
      let blurPx = 0
      while (i < effects.length && EFFECT_MAP[effects[i].type].kind === 'css') {
        const f = cssFilter(effects[i], pxRef)
        if (f) parts.push(f)
        if (effects[i].type === 'blur') blurPx = Math.max(blurPx, n(effects[i], 'radius') * pxRef)
        i++
      }
      if (!parts.length) continue
      const dst = other()
      if (blurPx > 0.05) {
        // Extend the edges before blurring so the frame border stays solid, as ffmpeg's gblur does.
        const ext = Math.ceil(blurPx * 3)
        const p = scratch.get(2, cw + ext * 2, ch + ext * 2)
        const src = a.canvas
        p.ctx.drawImage(src, 0, 0, 1, ch, 0, ext, ext, ch)
        p.ctx.drawImage(src, cw - 1, 0, 1, ch, cw + ext, ext, ext, ch)
        p.ctx.drawImage(src, 0, 0, cw, 1, ext, 0, cw, ext)
        p.ctx.drawImage(src, 0, ch - 1, cw, 1, ext, ch + ext, cw, ext)
        p.ctx.drawImage(src, 0, 0, 1, 1, 0, 0, ext, ext)
        p.ctx.drawImage(src, cw - 1, 0, 1, 1, cw + ext, 0, ext, ext)
        p.ctx.drawImage(src, 0, ch - 1, 1, 1, 0, ch + ext, ext, ext)
        p.ctx.drawImage(src, cw - 1, ch - 1, 1, 1, cw + ext, ch + ext, ext, ext)
        p.ctx.drawImage(src, ext, ext)
        dst.ctx.filter = parts.join(' ')
        dst.ctx.drawImage(p.canvas, -ext, -ext)
      } else {
        dst.ctx.filter = parts.join(' ')
        dst.ctx.drawImage(a.canvas, 0, 0)
      }
      dst.ctx.filter = 'none'
      a = dst
      continue
    }
    i++
    if (def.kind === 'overlay') {
      a.ctx.globalCompositeOperation = 'source-atop'
      a.ctx.drawImage(overlayFor(e, cw, ch), 0, 0, cw, ch)
      a.ctx.globalCompositeOperation = 'source-over'
      continue
    }
    switch (e.type) {
      case 'tint':
        a.ctx.globalCompositeOperation = 'source-atop'
        a.ctx.globalAlpha = Math.min(1, Math.max(0, n(e, 'amount')))
        a.ctx.fillStyle = s(e, 'color')
        a.ctx.fillRect(0, 0, cw, ch)
        a.ctx.globalAlpha = 1
        a.ctx.globalCompositeOperation = 'source-over'
        break
      case 'flip': {
        const h = b(e, 'horizontal')
        const v = b(e, 'vertical')
        if (!h && !v) break
        const dst = other()
        dst.ctx.setTransform(h ? -1 : 1, 0, 0, v ? -1 : 1, h ? cw : 0, v ? ch : 0)
        dst.ctx.drawImage(a.canvas, 0, 0)
        dst.ctx.setTransform(1, 0, 0, 1, 0, 0)
        a = dst
        break
      }
      case 'pixelate': {
        const block = Math.max(2, Math.round(n(e, 'size') * pxRef))
        const sw = Math.max(1, Math.round(cw / block))
        const sh = Math.max(1, Math.round(ch / block))
        const small = scratch.get(3, sw, sh)
        small.ctx.imageSmoothingQuality = 'high'
        small.ctx.drawImage(a.canvas, 0, 0, sw, sh)
        const dst = other()
        dst.ctx.imageSmoothingEnabled = false
        dst.ctx.drawImage(small.canvas, 0, 0, cw, ch)
        dst.ctx.imageSmoothingEnabled = true
        a = dst
        break
      }
      case 'sharpen': {
        if (n(e, 'amount') <= 0) break
        const dst = other()
        dst.ctx.filter = `url(#${sharpenFilter(n(e, 'amount'))})`
        dst.ctx.drawImage(a.canvas, 0, 0)
        dst.ctx.filter = 'none'
        a = dst
        break
      }
      case 'noise': {
        const amount = Math.min(1, Math.max(0, n(e, 'amount')))
        if (amount <= 0) break
        // Grain masked to the layer's own alpha, then blended so mid-grey leaves the picture unchanged.
        const g = scratch.get(4, cw, ch)
        g.ctx.drawImage(a.canvas, 0, 0)
        g.ctx.globalCompositeOperation = 'source-in'
        const pattern = g.ctx.createPattern(getNoiseTile(), 'repeat')!
        const ox = Math.floor(Math.random() * 256)
        const oy = Math.floor(Math.random() * 256)
        g.ctx.translate(-ox, -oy)
        g.ctx.fillStyle = pattern
        g.ctx.fillRect(ox, oy, cw, ch)
        g.ctx.setTransform(1, 0, 0, 1, 0, 0)
        a.ctx.globalCompositeOperation = 'overlay'
        a.ctx.globalAlpha = amount * 0.6
        a.ctx.drawImage(g.canvas, 0, 0)
        a.ctx.globalAlpha = 1
        a.ctx.globalCompositeOperation = 'source-over'
        break
      }
      case 'chromaKey': {
        const keyed = chromaKey(a.canvas, e)
        if (!keyed) break
        const dst = other()
        dst.ctx.drawImage(keyed, 0, 0)
        a = dst
        break
      }
    }
  }

  // Zoom about the focal point, clipped to the clip's own frame.
  const z = clip.zoom
  if (z.enabled && (z.start !== 1 || z.end !== 1)) {
    const zoom = zoomAt(z, local, clip.duration)
    const dst = other()
    const zw = cw * zoom
    const zh = ch * zoom
    dst.ctx.drawImage(a.canvas, (cw - zw) * z.focusX, (ch - zh) * z.focusY, zw, zh)
    a = dst
  }

  const shadow = effects.find((e) => e.type === 'dropShadow')
  if (shadow) {
    const sigma = n(shadow, 'blur') * pxRef
    const dist = n(shadow, 'distance') * pxRef
    const ang = (n(shadow, 'angle') * Math.PI) / 180
    const m = Math.ceil(3 * sigma + dist) + 2
    const p = scratch.get(5, cw + m * 2, ch + m * 2)
    p.ctx.shadowColor = rgba(s(shadow, 'color'), Math.min(1, Math.max(0, n(shadow, 'opacity'))))
    p.ctx.shadowBlur = sigma * 2
    p.ctx.shadowOffsetX = Math.cos(ang) * dist
    p.ctx.shadowOffsetY = Math.sin(ang) * dist
    p.ctx.drawImage(a.canvas, m, m)
    p.ctx.shadowColor = 'transparent'
    return { image: p.canvas, pad: m }
  }
  return { image: a.canvas, pad: 0 }
}

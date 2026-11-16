// Web Audio graph for the preview: one chain per playing audio clip (effects -> clip gain -> meter),
// all feeding a master gain that is the preview-only volume.
import { EFFECT_MAP, SAMPLE_RATE, n, reverbImpulse, semitoneRatio } from '@shared/effects'
import type { EffectInstance } from '@shared/model'

const WORKLETS = `
class CwPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }] }
  constructor() { super(); this.size = 16384; this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0; this.phase = 0; this.win = 2400 }
  read(ch, delay) {
    let pos = this.w - delay; while (pos < 0) pos += this.size
    const i0 = Math.floor(pos), f = pos - i0, b = this.buf[ch]
    return b[i0 % this.size] * (1 - f) + b[(i0 + 1) % this.size] * f
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0], r = params.ratio[0], len = out[0].length, W = this.win
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < 2; ch++) this.buf[ch][this.w] = inp.length ? (inp[ch] || inp[0])[i] : 0
      const pA = this.phase, pB = (pA + 0.5) % 1
      const gA = 0.5 - 0.5 * Math.cos(2 * Math.PI * pA), gB = 1 - gA
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = this.read(Math.min(ch, 1), pA * W) * gA + this.read(Math.min(ch, 1), pB * W) * gB
      this.phase += (1 - r) / W
      if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1
      this.w = (this.w + 1) % this.size
    }
    return true
  }
}
registerProcessor('cw-pitch', CwPitch)
class CwBitcrush extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
    { name: 'downsample', defaultValue: 1, minValue: 1, maxValue: 50, automationRate: 'k-rate' } ] }
  constructor() { super(); this.count = 0; this.held = [0, 0] }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0], levels = Math.pow(2, params.bits[0]) / 2, hold = Math.max(1, Math.round(params.downsample[0]))
    for (let i = 0; i < out[0].length; i++) {
      if (this.count % hold === 0) for (let ch = 0; ch < 2; ch++) { const v = inp.length ? (inp[ch] || inp[0])[i] : 0; this.held[ch] = Math.round(v * levels) / levels }
      this.count++
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = this.held[Math.min(ch, 1)]
    }
    return true
  }
}
registerProcessor('cw-bitcrush', CwBitcrush)
`

export interface EffectChain {
  input: AudioNode
  output: AudioNode
  signature: string
  dispose(): void
}

export class AudioEngine {
  ctx: AudioContext
  master: GainNode
  /** Bumped when the worklets finish loading, so chains built without them are rebuilt. */
  workletVersion = 0
  private irCache = new Map<string, AudioBuffer>()

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    const url = URL.createObjectURL(new Blob([WORKLETS], { type: 'application/javascript' }))
    this.ctx.audioWorklet
      .addModule(url)
      .then(() => {
        this.workletVersion = 1
      })
      .catch((err) => console.warn('Audio worklets unavailable', err))
      .finally(() => URL.revokeObjectURL(url))
  }

  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(Math.min(1, Math.max(0, v)), this.ctx.currentTime, 0.015)
  }

  signature(effects: EffectInstance[]): string {
    const active = effects.filter(
      (e) => e.enabled && EFFECT_MAP[e.type]?.target === 'audio' && e.type !== 'audioFadeIn' && e.type !== 'audioFadeOut'
    )
    return this.workletVersion + JSON.stringify(active.map((e) => [e.type, e.params]))
  }

  private impulse(seconds: number, mix: number): AudioBuffer {
    const key = `${seconds.toFixed(2)}|${mix.toFixed(3)}`
    let buf = this.irCache.get(key)
    if (!buf) {
      const [l, r] = reverbImpulse(seconds, mix, this.ctx.sampleRate)
      buf = this.ctx.createBuffer(2, l.length, this.ctx.sampleRate)
      buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0)
      buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1)
      this.irCache.set(key, buf)
      if (this.irCache.size > 12) this.irCache.delete(this.irCache.keys().next().value!)
    }
    return buf
  }

  /** Builds the effect chain for a clip. Fades are not part of the chain; they modulate the clip gain. */
  buildChain(effects: EffectInstance[]): EffectChain {
    const ctx = this.ctx
    const input = ctx.createGain()
    let tail: AudioNode = input
    const nodes: AudioNode[] = [input]
    const stoppable: OscillatorNode[] = []
    const link = (node: AudioNode) => {
      tail.connect(node)
      tail = node
      nodes.push(node)
    }
    for (const e of effects) {
      if (!e.enabled || EFFECT_MAP[e.type]?.target !== 'audio') continue
      switch (e.type) {
        case 'pitch': {
          const ratio = semitoneRatio(n(e, 'semitones'))
          if (!this.workletVersion || Math.abs(ratio - 1) < 1e-4) break
          const node = new AudioWorkletNode(ctx, 'cw-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
          node.parameters.get('ratio')!.value = ratio
          link(node)
          break
        }
        case 'distortion': {
          const drive = n(e, 'drive')
          const shaper = ctx.createWaveShaper()
          const curve = new Float32Array(4097)
          for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(drive * ((i / (curve.length - 1)) * 2 - 1))
          shaper.curve = curve
          link(shaper)
          const level = ctx.createGain()
          level.gain.value = n(e, 'level')
          link(level)
          break
        }
        case 'bitcrush': {
          if (!this.workletVersion) break
          const node = new AudioWorkletNode(ctx, 'cw-bitcrush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
          node.parameters.get('bits')!.value = n(e, 'bits')
          node.parameters.get('downsample')!.value = n(e, 'downsample')
          link(node)
          break
        }
        case 'echo': {
          // out = in + sum(g^k * in(t - k*d)): a delay line whose output is fed back through gain g.
          const delay = ctx.createDelay(4)
          delay.delayTime.value = Math.min(4, n(e, 'delay') / 1000)
          const fb = ctx.createGain()
          fb.gain.value = Math.min(0.9, Math.max(0, n(e, 'feedback')))
          const sum = ctx.createGain()
          tail.connect(sum)
          tail.connect(delay)
          delay.connect(fb)
          fb.connect(delay)
          fb.connect(sum)
          nodes.push(delay, fb, sum)
          tail = sum
          break
        }
        case 'reverb': {
          const conv = ctx.createConvolver()
          conv.normalize = false
          conv.buffer = this.impulse(n(e, 'size'), n(e, 'mix'))
          link(conv)
          break
        }
        case 'lowpass':
        case 'highpass': {
          const f = ctx.createBiquadFilter()
          f.type = e.type
          f.frequency.value = n(e, 'frequency')
          f.Q.value = -3.0103 // Web Audio takes Q in dB here; this is Q = 0.707, matching ffmpeg's default
          link(f)
          break
        }
        case 'bass':
        case 'treble': {
          const f = ctx.createBiquadFilter()
          f.type = e.type === 'bass' ? 'lowshelf' : 'highshelf'
          f.frequency.value = e.type === 'bass' ? 100 : 3000
          f.gain.value = n(e, 'gain')
          link(f)
          break
        }
        case 'tremolo': {
          const depth = Math.min(1, Math.max(0, n(e, 'depth')))
          const g = ctx.createGain()
          g.gain.value = 1 - depth / 2
          const osc = ctx.createOscillator()
          osc.frequency.value = n(e, 'rate')
          const amp = ctx.createGain()
          amp.gain.value = depth / 2
          osc.connect(amp)
          amp.connect(g.gain)
          osc.start()
          stoppable.push(osc)
          nodes.push(amp)
          link(g)
          break
        }
      }
    }
    return {
      input,
      output: tail,
      signature: this.signature(effects),
      dispose: () => {
        for (const o of stoppable) {
          try {
            o.stop()
          } catch {
            /* already stopped */
          }
        }
        for (const node of nodes) node.disconnect()
      }
    }
  }
}

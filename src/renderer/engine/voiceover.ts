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

// Voiceover recording. The microphone is recorded on the preview's own audio clock while the timeline
// plays, and samples go to disk as they arrive (see main/voiceover.ts). When the take stops it becomes a
// new audio clip placed so that what was said lines up with what was heard: the clip starts where the
// playhead was, minus the time sound takes to reach the speakers and to come back from the microphone.
import { MIN_CLIP_DURATION } from '@shared/model'
import { placeAudioClip } from '@shared/timeline-ops'
import { t } from '../i18n'
import { edit, get, set, toast } from '../state/store'
import { player } from './player'

const RECORDER = `
class CwRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.n = 0
    this.first = -1
    this.on = true
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }) } }
  }
  flush() {
    if (!this.n) return
    this.port.postMessage({ frame: this.first, data: this.buf.slice(0, this.n) })
    this.n = 0
    this.first = -1
  }
  process(inputs) {
    if (!this.on) return false
    const chans = inputs[0]
    if (chans && chans.length) {
      const len = chans[0].length
      for (let i = 0; i < len; i++) {
        let v = 0
        for (let c = 0; c < chans.length; c++) v += chans[c][i]
        if (this.first < 0) this.first = currentFrame + i
        this.buf[this.n++] = v / chans.length
        if (this.n === this.buf.length) this.flush()
      }
    }
    return true
  }
}
registerProcessor('cw-recorder', CwRecorder)
`

interface Take {
  id: string
  ctx: AudioContext
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  sink: GainNode
  rate: number
  /** Audio-clock frame of the first sample in the file, and of the next one expected. */
  firstFrame: number
  nextFrame: number
  /** Timeline time and audio-clock frame when the timeline started playing. */
  t0: number
  f0: number
  /** Seconds from the speakers to the ears and from the microphone to the recorder. */
  latency: number
  pending: Int16Array[]
  pendingFrames: number
  writes: Promise<void>
  failed: boolean
  lastLevel: number
  /** Loudest sample since the meter last updated. */
  peak: number
}

let take: Take | null = null
const loaded = new WeakSet<AudioContext>()

async function loadRecorder(ctx: AudioContext): Promise<void> {
  if (loaded.has(ctx)) return
  const url = URL.createObjectURL(new Blob([RECORDER], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    loaded.add(ctx)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The microphones available, for the picker. Names show once the user has allowed the microphone. */
export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || t('tools.voiceover.micNumber', { n: i + 1 }) }))
  } catch {
    return []
  }
}

export const isRecording = (): boolean => !!get().voiceover

function sendPending(tk: Take): void {
  if (!tk.pendingFrames) return
  const out = new Int16Array(tk.pendingFrames)
  let at = 0
  for (const part of tk.pending) {
    out.set(part, at)
    at += part.length
  }
  tk.pending = []
  tk.pendingFrames = 0
  const bytes = new Uint8Array(out.buffer)
  tk.writes = tk.writes.then(() => window.cw.voiceoverWrite(tk.id, bytes)).catch((err) => {
    if (!tk.failed) toast(t('tools.voiceover.writeFailed', { error: (err as Error).message }), 'error')
    tk.failed = true
  })
}

function onChunk(tk: Take, frame: number, data: Float32Array): void {
  if (tk.firstFrame < 0) {
    tk.firstFrame = frame
    tk.nextFrame = frame
  }
  // A gap (the microphone stalled) is filled with silence; an overlap is dropped, so time never slips.
  let from = 0
  if (frame > tk.nextFrame) {
    const gap = Math.min(frame - tk.nextFrame, tk.rate * 5)
    tk.pending.push(new Int16Array(gap))
    tk.pendingFrames += gap
    tk.nextFrame += gap
  } else if (frame < tk.nextFrame) {
    from = Math.min(data.length, tk.nextFrame - frame)
  }
  const n = data.length - from
  if (n > 0) {
    const pcm = new Int16Array(n)
    let peak = 0
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, data[from + i]))
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      const a = Math.abs(v)
      if (a > peak) peak = a
    }
    tk.pending.push(pcm)
    tk.pendingFrames += n
    tk.nextFrame += n
    // The level meter updates about ten times a second, showing the loudest moment in between.
    tk.peak = Math.max(tk.peak, peak)
    const now = performance.now()
    const vo = get().voiceover
    if (vo && now - tk.lastLevel > 100) {
      tk.lastLevel = now
      set({ voiceover: { ...vo, level: tk.peak } })
      tk.peak = 0
    }
  }
  if (tk.pendingFrames >= tk.rate / 4) sendPending(tk)
}

function release(tk: Take): void {
  for (const track of tk.stream.getTracks()) track.stop()
  try {
    tk.source.disconnect()
    tk.node.disconnect()
    tk.sink.disconnect()
  } catch {
    /* already disconnected */
  }
  player.monitorMuted = false
}

/**
 * Starts recording: asks for the microphone, waits until it is delivering sound, then plays the timeline
 * from the playhead. Shows a message and does nothing if the microphone can't be used.
 */
export async function startVoiceover(): Promise<void> {
  if (get().voiceover) return
  set({ voiceover: { phase: 'starting', startedAt: performance.now(), level: 0 } })
  let stream: MediaStream | null = null
  let id: string | null = null
  try {
    const ctx = await player.audioContext()
    await loadRecorder(ctx)
    const device = get().settings.voiceoverDevice
    // The voice exactly as the microphone hears it: no echo cancelling, noise removal or level riding.
    const constraints: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { ...constraints, deviceId: { exact: device } } : constraints })
    } catch (err) {
      // The chosen microphone was unplugged: use the default one.
      if (!device || (err as DOMException).name !== 'OverconstrainedError') throw err
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
    }
    const rate = ctx.sampleRate
    const begun = await window.cw.voiceoverBegin(get().projectPath, rate)
    id = begun.id
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'cw-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    // The recorder must be connected to the output to run, but nothing of the microphone is heard.
    const sink = ctx.createGain()
    sink.gain.value = 0
    source.connect(node)
    node.connect(sink)
    sink.connect(ctx.destination)
    const track = stream.getAudioTracks()[0]
    const tk: Take = {
      id, ctx, stream, source, node, sink, rate, firstFrame: -1, nextFrame: -1, t0: 0, f0: 0, latency: 0,
      pending: [], pendingFrames: 0, writes: Promise.resolve(), failed: false, lastLevel: 0, peak: 0
    }
    const first = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('tools.voiceover.noSound'))), 4000)
      node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array } | { done: true }>) => {
        if ('data' in e.data) {
          onChunk(tk, e.data.frame, e.data.data)
          clearTimeout(timer)
          resolve()
        }
      }
    })
    await first
    take = tk
    player.monitorMuted = get().settings.voiceoverMonitor === false
    player.play()
    tk.t0 = player.time
    tk.f0 = ctx.currentTime * rate
    const settings = track.getSettings() as MediaTrackSettings & { latency?: number }
    tk.latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (settings.latency ?? 0.01)
    set({ voiceover: { phase: 'recording', startedAt: performance.now(), level: 0 } })
  } catch (err) {
    if (stream) for (const tr of stream.getTracks()) tr.stop()
    if (id) void window.cw.voiceoverDiscard(id)
    take = null
    player.monitorMuted = false
    set({ voiceover: null })
    const e = err as DOMException
    const message =
      e.name === 'NotAllowedError' ? t('tools.voiceover.denied')
        : e.name === 'NotFoundError' ? t('tools.voiceover.noMic')
          : t('tools.voiceover.failed', { error: e.message || String(err) })
    toast(message, 'error')
  }
}

/** Stops recording and adds the take to the project as a new audio clip (selected). */
export async function stopVoiceover(): Promise<void> {
  const tk = take
  const vo = get().voiceover
  if (!tk || !vo || vo.phase !== 'recording') return
  take = null
  set({ voiceover: { ...vo, phase: 'saving' } })
  player.pause()
  try {
    // Let the recorder hand over what it still holds.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500)
      tk.node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array } | { done: true }>) => {
        if ('data' in e.data) onChunk(tk, e.data.frame, e.data.data)
        else {
          clearTimeout(timer)
          resolve()
        }
      }
      tk.node.port.postMessage('stop')
    })
    release(tk)
    sendPending(tk)
    await tk.writes
    if (tk.failed) {
      await window.cw.voiceoverDiscard(tk.id)
      return
    }
    const done = await window.cw.voiceoverEnd(tk.id, tk.rate)
    if (!done) return
    // What was recorded at audio-clock frame f was said while hearing timeline time t0 + (f - f0)/rate - latency.
    const srcIn = Math.max(0, (tk.f0 - tk.firstFrame) / tk.rate + tk.latency)
    if (done.duration - srcIn < Math.max(0.2, MIN_CLIP_DURATION)) {
      await window.cw.voiceoverRemove(done.path)
      toast(t('tools.voiceover.tooShort'))
      return
    }
    const { items, errors } = await window.cw.importMedia([done.path])
    const media = items[0]
    if (!media) {
      toast(errors[0] ?? t('tools.voiceover.failed', { error: '' }), 'error')
      return
    }
    let clipId = ''
    edit((p) => {
      p.media.push(media)
      clipId = placeAudioClip(p, media, tk.t0, srcIn, t('tools.voiceover.clipName'))
    })
    set({ selection: [clipId], selectedMediaId: media.id })
    toast(t('tools.voiceover.added', { name: media.name }))
  } catch (err) {
    toast(t('tools.voiceover.failed', { error: (err as Error).message }), 'error')
    await window.cw.voiceoverDiscard(tk.id).catch(() => {})
  } finally {
    release(tk)
    set({ voiceover: null })
  }
}

// Play/pause (Space, the preview's button) while recording stops the take rather than pausing under it.
player.toggleHook = () => {
  const vo = get().voiceover
  if (vo?.phase === 'recording') void stopVoiceover()
  return !!vo
}

/** Starts or stops recording. */
export function toggleVoiceover(): void {
  const vo = get().voiceover
  if (!vo) void startVoiceover()
  else if (vo.phase === 'recording') void stopVoiceover()
}

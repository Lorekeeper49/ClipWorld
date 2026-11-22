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

// Export formats: containers, the codecs each can hold, and encoder command lines.
import { lerp } from './easing'

export interface EncoderDef {
  /** ffmpeg encoder name. */
  id: string
  hardware?: boolean
}

export interface VideoCodecDef {
  id: string
  /** In order of preference; the first available one is the default. */
  encoders: EncoderDef[]
}

export interface AudioCodecDef {
  id: string
  encoder: string
  lossless?: boolean
}

export interface ContainerDef {
  id: string
  ext: string
  video: string[]
  audio: string[]
}

export const VIDEO_CODECS: Record<string, VideoCodecDef> = {
  h264: {
    id: 'h264',
    encoders: [
      { id: 'libx264' },
      { id: 'h264_nvenc', hardware: true },
      { id: 'h264_qsv', hardware: true },
      { id: 'h264_amf', hardware: true }
    ]
  },
  hevc: {
    id: 'hevc',
    encoders: [
      { id: 'libx265' },
      { id: 'hevc_nvenc', hardware: true },
      { id: 'hevc_qsv', hardware: true }
    ]
  },
  vp9: { id: 'vp9', encoders: [{ id: 'libvpx-vp9' }] },
  av1: {
    id: 'av1',
    encoders: [
      { id: 'av1_nvenc', hardware: true },
      { id: 'libsvtav1' },
      { id: 'libaom-av1' }
    ]
  },
  prores: { id: 'prores', encoders: [{ id: 'prores_ks' }] },
  mpeg4: { id: 'mpeg4', encoders: [{ id: 'mpeg4' }] },
  gif: { id: 'gif', encoders: [{ id: 'gif' }] }
}

export const AUDIO_CODECS: Record<string, AudioCodecDef> = {
  aac: { id: 'aac', encoder: 'aac' },
  mp3: { id: 'mp3', encoder: 'libmp3lame' },
  opus: { id: 'opus', encoder: 'libopus' },
  vorbis: { id: 'vorbis', encoder: 'libvorbis' },
  flac: { id: 'flac', encoder: 'flac', lossless: true },
  pcm: { id: 'pcm', encoder: 'pcm_s16le', lossless: true }
}

export const CONTAINERS: ContainerDef[] = [
  { id: 'mp4', ext: 'mp4', video: ['h264', 'hevc', 'av1'], audio: ['aac', 'mp3'] },
  { id: 'mkv', ext: 'mkv', video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'flac', 'mp3', 'pcm'] },
  { id: 'mov', ext: 'mov', video: ['h264', 'hevc', 'prores'], audio: ['aac', 'pcm'] },
  { id: 'webm', ext: 'webm', video: ['vp9', 'av1'], audio: ['opus', 'vorbis'] },
  { id: 'avi', ext: 'avi', video: ['h264', 'mpeg4'], audio: ['mp3', 'pcm'] },
  { id: 'gif', ext: 'gif', video: ['gif'], audio: [] },
  { id: 'mp3', ext: 'mp3', video: [], audio: ['mp3'] },
  { id: 'wav', ext: 'wav', video: [], audio: ['pcm'] },
  { id: 'flac', ext: 'flac', video: [], audio: ['flac'] },
  { id: 'ogg', ext: 'ogg', video: [], audio: ['vorbis', 'opus'] },
  { id: 'm4a', ext: 'm4a', video: [], audio: ['aac'] }
]

export const CONTAINER_MAP: Record<string, ContainerDef> = Object.fromEntries(CONTAINERS.map((c) => [c.id, c]))

export interface ExportSettings {
  container: string
  /** Video codec family id, e.g. 'h264'. Ignored for audio-only containers. */
  videoCodec: string
  /** ffmpeg encoder name, e.g. 'libx264'. */
  videoEncoder: string
  audioCodec: string
  /** 1..100, higher is better. */
  quality: number
  /** kbit/s for lossy audio codecs. */
  audioBitrate: number
  /** Mix every audio track into one, or keep one output stream per timeline audio track. */
  audioMode: 'mix' | 'separate'
  /** GIF only: transparency (see GifTransparency). */
  gif: GifTransparency
}

/**
 * A transparent GIF: what nothing covers (and the see-through parts of clips) stays see-through instead of
 * black, and optionally one color is made see-through too, like the Color mask. GIF pixels are either
 * fully see-through or solid, so anything more than half see-through becomes see-through.
 */
export interface GifTransparency {
  transparent: boolean
  /** Also make one color see-through. */
  key: boolean
  color: string
  /** 0..1, how different from `color` a pixel can be and still disappear. */
  tolerance: number
  /** 0..1, a ramp above the tolerance. */
  softness: number
  /** Pixels at REF_HEIGHT: rounds the edges of what disappears. */
  feather: number
}

export const defaultGifTransparency = (): GifTransparency =>
  ({ transparent: false, key: false, color: '#00ff00', tolerance: 0.15, softness: 0.05, feather: 0 })

export function defaultExportSettings(): ExportSettings {
  return {
    container: 'mp4', videoCodec: 'h264', videoEncoder: 'libx264', audioCodec: 'aac', quality: 75, audioBitrate: 192, audioMode: 'mix',
    gif: defaultGifTransparency()
  }
}

/** Makes settings self-consistent for the chosen container and the encoders this ffmpeg has. */
export function normalizeExportSettings(s: ExportSettings, available: string[]): ExportSettings {
  const has = (e: string) => available.includes(e)
  const out = { ...s }
  const c = CONTAINER_MAP[out.container] ?? CONTAINER_MAP.mp4
  out.container = c.id
  if (c.video.length) {
    const usable = c.video.filter((v) => VIDEO_CODECS[v].encoders.some((e) => has(e.id)))
    if (!usable.includes(out.videoCodec)) out.videoCodec = usable[0] ?? c.video[0]
    const encs = VIDEO_CODECS[out.videoCodec].encoders.filter((e) => has(e.id))
    if (!encs.some((e) => e.id === out.videoEncoder)) {
      out.videoEncoder = (encs.find((e) => !e.hardware) ?? encs[0])?.id ?? VIDEO_CODECS[out.videoCodec].encoders[0].id
    }
  }
  if (c.audio.length) {
    const usable = c.audio.filter((a) => has(AUDIO_CODECS[a].encoder))
    if (!usable.includes(out.audioCodec)) out.audioCodec = usable[0] ?? c.audio[0]
  }
  out.quality = Math.min(100, Math.max(1, Math.round(out.quality)))
  // Settings saved before GIF transparency existed have none.
  const g = { ...defaultGifTransparency(), ...(s.gif ?? {}) }
  const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  out.gif = {
    transparent: !!g.transparent,
    key: !!g.key,
    color: /^#[0-9a-f]{6}$/i.test(g.color) ? g.color.toLowerCase() : '#00ff00',
    tolerance: clamp(g.tolerance, 0.01, 1, 0.15),
    softness: clamp(g.softness, 0, 1, 0.05),
    feather: clamp(g.feather, 0, 200, 0)
  }
  return out
}

/** Pixel format the final filter should produce for an encoder. */
export function pixelFormatFor(encoder: string): string {
  if (encoder === 'prores_ks') return 'yuv422p10le'
  if (encoder.endsWith('_qsv') || encoder.endsWith('_amf')) return 'nv12'
  if (encoder === 'gif') return 'pal8'
  return 'yuv420p'
}

export function videoEncoderArgs(encoder: string, quality: number, container: string): string[] {
  const q = (worst: number, best: number) => String(Math.round(lerp(worst, best, (quality - 1) / 99)))
  const tag = container === 'mp4' || container === 'mov' ? ['-tag:v', 'hvc1'] : []
  switch (encoder) {
    case 'libx264': return ['-c:v', 'libx264', '-preset', 'medium', '-crf', q(36, 14)]
    case 'libx265': return ['-c:v', 'libx265', '-preset', 'medium', '-crf', q(38, 16), '-x265-params', 'log-level=error', ...tag]
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q(38, 16), '-b:v', '0']
    case 'hevc_nvenc': return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q(40, 18), '-b:v', '0', ...tag]
    case 'av1_nvenc': return ['-c:v', 'av1_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q(45, 20), '-b:v', '0']
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', q(36, 16)]
    case 'hevc_qsv': return ['-c:v', 'hevc_qsv', '-preset', 'medium', '-global_quality', q(38, 18), ...tag]
    case 'h264_amf': return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', q(36, 16), '-qp_p', q(38, 18)]
    case 'libvpx-vp9': return ['-c:v', 'libvpx-vp9', '-crf', q(48, 18), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
    case 'libsvtav1': return ['-c:v', 'libsvtav1', '-preset', '8', '-crf', q(50, 20)]
    case 'libaom-av1': return ['-c:v', 'libaom-av1', '-crf', q(50, 20), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1']
    case 'prores_ks': return ['-c:v', 'prores_ks', '-profile:v', String(Math.min(3, Math.floor((quality - 1) / 25))), '-vendor', 'apl0']
    case 'mpeg4': return ['-c:v', 'mpeg4', '-q:v', q(14, 2)]
    case 'gif': return ['-c:v', 'gif', '-loop', '0']
    default: return ['-c:v', encoder]
  }
}

export function audioEncoderArgs(codec: string, bitrate: number): string[] {
  const def = AUDIO_CODECS[codec]
  if (!def) return ['-c:a', 'aac', '-b:a', `${bitrate}k`]
  if (def.lossless) return ['-c:a', def.encoder]
  return ['-c:a', def.encoder, '-b:a', `${bitrate}k`]
}

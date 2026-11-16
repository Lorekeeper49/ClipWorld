// Export formats: containers, the codecs each can hold, and encoder command lines.
import { lerp } from './easing'

export interface EncoderDef {
  /** ffmpeg encoder name. */
  id: string
  label: string
  hardware?: boolean
}

export interface VideoCodecDef {
  id: string
  label: string
  /** In order of preference; the first available one is the default. */
  encoders: EncoderDef[]
}

export interface AudioCodecDef {
  id: string
  label: string
  encoder: string
  lossless?: boolean
}

export interface ContainerDef {
  id: string
  label: string
  ext: string
  video: string[]
  audio: string[]
}

export const VIDEO_CODECS: Record<string, VideoCodecDef> = {
  h264: {
    id: 'h264', label: 'H.264 (most compatible)',
    encoders: [
      { id: 'libx264', label: 'Software (x264)' },
      { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true },
      { id: 'h264_qsv', label: 'Intel Quick Sync', hardware: true },
      { id: 'h264_amf', label: 'AMD AMF', hardware: true }
    ]
  },
  hevc: {
    id: 'hevc', label: 'H.265 / HEVC',
    encoders: [
      { id: 'libx265', label: 'Software (x265)' },
      { id: 'hevc_nvenc', label: 'NVIDIA NVENC', hardware: true },
      { id: 'hevc_qsv', label: 'Intel Quick Sync', hardware: true }
    ]
  },
  vp9: { id: 'vp9', label: 'VP9', encoders: [{ id: 'libvpx-vp9', label: 'Software (libvpx)' }] },
  av1: {
    id: 'av1', label: 'AV1',
    encoders: [
      { id: 'av1_nvenc', label: 'NVIDIA NVENC', hardware: true },
      { id: 'libsvtav1', label: 'Software (SVT-AV1)' },
      { id: 'libaom-av1', label: 'Software (libaom, slow)' }
    ]
  },
  prores: { id: 'prores', label: 'Apple ProRes', encoders: [{ id: 'prores_ks', label: 'Software' }] },
  mpeg4: { id: 'mpeg4', label: 'MPEG-4 Part 2', encoders: [{ id: 'mpeg4', label: 'Software' }] },
  gif: { id: 'gif', label: 'Animated GIF', encoders: [{ id: 'gif', label: 'Software' }] }
}

export const AUDIO_CODECS: Record<string, AudioCodecDef> = {
  aac: { id: 'aac', label: 'AAC', encoder: 'aac' },
  mp3: { id: 'mp3', label: 'MP3', encoder: 'libmp3lame' },
  opus: { id: 'opus', label: 'Opus', encoder: 'libopus' },
  vorbis: { id: 'vorbis', label: 'Vorbis', encoder: 'libvorbis' },
  flac: { id: 'flac', label: 'FLAC (lossless)', encoder: 'flac', lossless: true },
  pcm: { id: 'pcm', label: 'PCM 16-bit (uncompressed)', encoder: 'pcm_s16le', lossless: true }
}

export const CONTAINERS: ContainerDef[] = [
  { id: 'mp4', label: 'MP4', ext: 'mp4', video: ['h264', 'hevc', 'av1'], audio: ['aac', 'mp3'] },
  { id: 'mkv', label: 'Matroska (MKV)', ext: 'mkv', video: ['h264', 'hevc', 'vp9', 'av1'], audio: ['aac', 'opus', 'flac', 'mp3', 'pcm'] },
  { id: 'mov', label: 'QuickTime (MOV)', ext: 'mov', video: ['h264', 'hevc', 'prores'], audio: ['aac', 'pcm'] },
  { id: 'webm', label: 'WebM', ext: 'webm', video: ['vp9', 'av1'], audio: ['opus', 'vorbis'] },
  { id: 'avi', label: 'AVI', ext: 'avi', video: ['h264', 'mpeg4'], audio: ['mp3', 'pcm'] },
  { id: 'gif', label: 'Animated GIF', ext: 'gif', video: ['gif'], audio: [] },
  { id: 'mp3', label: 'MP3 (audio only)', ext: 'mp3', video: [], audio: ['mp3'] },
  { id: 'wav', label: 'WAV (audio only)', ext: 'wav', video: [], audio: ['pcm'] },
  { id: 'flac', label: 'FLAC (audio only)', ext: 'flac', video: [], audio: ['flac'] },
  { id: 'ogg', label: 'Ogg (audio only)', ext: 'ogg', video: [], audio: ['vorbis', 'opus'] },
  { id: 'm4a', label: 'M4A (audio only)', ext: 'm4a', video: [], audio: ['aac'] }
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
}

export function defaultExportSettings(): ExportSettings {
  return { container: 'mp4', videoCodec: 'h264', videoEncoder: 'libx264', audioCodec: 'aac', quality: 75, audioBitrate: 192, audioMode: 'mix' }
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

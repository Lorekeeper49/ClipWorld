// Reads a media file with ffprobe and describes it as a MediaItem.
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { type AudioStreamInfo, type MediaItem, type MediaKind, uid } from '@shared/model'
import { ffprobeJson } from './ffmpeg'

const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|jpegxl_pipe|bmp_pipe|tiff_pipe|webp_pipe|gif|apng|ico|svg_pipe|psd_pipe|tga_pipe|dds_pipe|exr_pipe|qoi_pipe|avif|heif|jpegls_pipe|pam_pipe|ppm_pipe|pgm_pipe|sgi_pipe)(,|$)/
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.bmp', '.tif', '.tiff', '.webp', '.gif', '.apng', '.tga', '.ico', '.avif', '.heic', '.heif', '.jxl', '.psd', '.exr', '.dds', '.qoi'])
const ALPHA_FMT = /^(rgba|bgra|argb|abgr|ya\d|pal8|yuva|gbrap|rgba64|bgra64)/

function ratio(v: string | undefined): number {
  if (!v) return 0
  const [a, b] = v.split('/').map(Number)
  if (!Number.isFinite(a)) return 0
  if (b === undefined) return a
  return b ? a / b : 0
}

export async function probeMedia(path: string): Promise<MediaItem> {
  const info = await ffprobeJson(path)
  const stat = statSync(path)
  const streams: any[] = info.streams ?? []
  const format = info.format ?? {}
  const fmtName: string = format.format_name ?? ''
  const ext = extname(path).toLowerCase()

  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.filter((s) => s.codec_type === 'audio')
  if (!video && !audio.length) throw new Error(`${basename(path)} has no video, audio or image content`)

  let duration = Number(format.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Math.max(0, ...streams.map((s) => Number(s.duration)).filter((d) => Number.isFinite(d)))
  }

  const isImageContainer = IMAGE_FORMATS.test(fmtName) || (IMAGE_EXTS.has(ext) && !audio.length)
  let kind: MediaKind = 'audio'
  let animated = false
  if (video) {
    if (isImageContainer) {
      kind = 'image'
      const frames = Number(video.nb_frames)
      animated = (Number.isFinite(frames) ? frames > 1 : /(^|,)(gif|apng)(,|$)/.test(fmtName)) && duration > 0.05
      if (!animated) duration = 0
    } else {
      kind = 'video'
    }
  }

  let width = Number(video?.width) || 0
  let height = Number(video?.height) || 0
  const rotation = Number(
    video?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0
  )
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]
  const sar = ratio(video?.sample_aspect_ratio?.replace(':', '/'))
  if (sar > 0 && Math.abs(sar - 1) > 0.01) width = Math.round(width * sar)

  const audioStreams: AudioStreamInfo[] = audio.map((s, i) => {
    const tags = s.tags ?? {}
    const lang = tags.language && tags.language !== 'und' ? String(tags.language) : undefined
    let title: string = tags.title || ''
    if (!title && tags.handler_name && !/^(SoundHandler|Sound Media Handler|Core Media Audio)$/i.test(tags.handler_name)) {
      title = tags.handler_name
    }
    if (!title) title = `Audio ${i + 1}`
    return {
      index: i,
      codec: s.codec_name ?? 'unknown',
      channels: Number(s.channels) || 2,
      sampleRate: Number(s.sample_rate) || 48000,
      title: lang ? `${title} (${lang})` : title,
      language: lang
    }
  })

  return {
    id: uid('m'),
    kind,
    name: basename(path),
    path,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    duration,
    width,
    height,
    fps: video ? ratio(video.avg_frame_rate) || ratio(video.r_frame_rate) || 30 : 0,
    animated,
    hasAlpha: video ? ALPHA_FMT.test(video.pix_fmt ?? '') : false,
    videoCodec: video?.codec_name,
    colorSpace: video?.color_space,
    audioStreams: kind === 'image' ? [] : audioStreams
  }
}

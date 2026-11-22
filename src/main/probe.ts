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

// Reads a media file with ffprobe and describes it as a MediaItem.
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { type AudioStreamInfo, type MediaItem, type MediaKind, uid } from '@shared/model'
import { ffprobeJson, getFfmpegPaths, run } from './ffmpeg'
import { t } from '@shared/i18n'

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

/** Longest keyframe gap in the first 30 seconds of the video stream (packet flags only, no decoding). */
export async function probeKeyframeInterval(path: string, duration: number): Promise<number | undefined> {
  const window = Math.min(30, duration)
  if (window <= 0) return undefined
  const r = await run(getFfmpegPaths().ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `%+${window.toFixed(3)}`,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path
  ]).catch(() => null)
  if (!r || r.code !== 0) return undefined
  const keys = r.stdout
    .split(/\r?\n/)
    .filter((l) => /,K/.test(l))
    .map((l) => Number(l.split(',')[0]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (!keys.length) return undefined
  // A single keyframe in the window means the interval is at least the window length.
  if (keys.length === 1) return window
  let worst = 0
  for (let i = 1; i < keys.length; i++) worst = Math.max(worst, keys[i] - keys[i - 1])
  return worst
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
  if (!video && !audio.length) throw new Error(t('errors.noContent', { name: basename(path) }))

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
    if (!title) title = t('media.audioN', { n: i + 1 })
    return {
      index: i,
      codec: s.codec_name ?? 'unknown',
      channels: Number(s.channels) || 2,
      sampleRate: Number(s.sample_rate) || 48000,
      title: lang ? `${title} (${lang})` : title,
      language: lang
    }
  })

  const keyframeInterval = kind === 'video' ? await probeKeyframeInterval(path, duration) : undefined

  return {
    id: uid('m'),
    keyframeInterval,
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

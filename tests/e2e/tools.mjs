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

// Paths to this system's bundled ffmpeg/ffprobe for the end-to-end scripts.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..', '..')
const exe = process.platform === 'win32' ? '.exe' : ''
const dir = [join(root, 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`), join(root, 'vendor', 'ffmpeg')].find((d) =>
  existsSync(join(d, `ffmpeg${exe}`))
)
if (!dir) throw new Error('ffmpeg is missing — run "npm run fetch-ffmpeg" first')
export const ffmpeg = join(dir, `ffmpeg${exe}`)
export const ffprobe = join(dir, `ffprobe${exe}`)

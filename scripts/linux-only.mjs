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

// Linux packages must be built on Linux: Windows file systems drop the execute permission, so a Linux
// package made on Windows contains a launcher and ffmpeg that will not run, and the AppImage tools
// only run on Linux and macOS.
if (process.platform === 'win32') {
  console.error('Linux packages have to be built on Linux (or macOS). Copy the project there and run: bash build.sh appimage')
  process.exit(1)
}

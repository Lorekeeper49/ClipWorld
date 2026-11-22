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

// Writes SHA256SUMS.txt for every file in a folder (sha256sum format: "<hash>  <name>").
// Usage: node scripts/checksums.mjs <folder>
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '.')
const names = readdirSync(dir).filter((n) => n !== 'SHA256SUMS.txt' && statSync(join(dir, n)).isFile()).sort()
const rows = []
for (const n of names) {
  const hash = createHash('sha256')
  await new Promise((res, rej) => createReadStream(join(dir, n)).on('data', (d) => hash.update(d)).on('end', res).on('error', rej))
  rows.push(`${hash.digest('hex')}  ${n}`)
}
writeFileSync(join(dir, 'SHA256SUMS.txt'), rows.join('\n') + '\n')
console.log(rows.join('\n'))

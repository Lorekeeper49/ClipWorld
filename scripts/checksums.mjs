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

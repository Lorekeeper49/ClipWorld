// Packs an unpacked Linux build (dist/linux-unpacked) into a .tar.gz with correct Unix permissions.
// Windows file systems have no execute bit, so on Windows the archive is written by bsdtar from an mtree
// manifest that states every file's mode explicitly (programs and libraries 0755, everything else 0644).
// Elsewhere the files already carry their permissions and plain tar is used.
// Usage: node scripts/pack-linux-tar.mjs <unpacked dir> <output .tar.gz> <top-level folder name>
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const [srcArg, outArg, topArg] = process.argv.slice(2)
if (!srcArg || !outArg || !topArg) {
  console.error('usage: node scripts/pack-linux-tar.mjs <unpacked dir> <output .tar.gz> <top-level folder name>')
  process.exit(2)
}
const src = resolve(srcArg)
const out = resolve(outArg)
const top = topArg.replace(/[\\/]+$/, '')

if (process.platform !== 'win32') {
  // Permissions are real here: archive the folder as it is, under the requested name.
  const r = spawnSync('tar', ['-czf', out, '--owner=0', '--group=0', `--transform=s,^\\.,${top},`, '-C', src, '.'], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

/** ELF programs and shared libraries need the execute bit; detected by the file's first bytes. */
function isElf(file) {
  const fd = openSync(file, 'r')
  try {
    const b = Buffer.alloc(4)
    return readSync(fd, b, 0, 4, 0) === 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46
  } finally {
    closeSync(fd)
  }
}

/** mtree paths: anything but plain letters, digits and a few safe characters is written as \ooo octal. */
const vis = (s) =>
  [...Buffer.from(s, 'utf8')].map((b) => (/[A-Za-z0-9._\-+/]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('')

const lines = ['#mtree', `${vis(`./${top}`)} type=dir mode=0755 uid=0 gid=0 uname=root gname=root time=${Math.floor(Date.now() / 1000)}.0`]
let executables = 0
let files = 0
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = relative(src, full).split('\\').join('/')
    const st = statSync(full)
    const path = vis(`./${top}/${rel}`)
    const time = `time=${Math.floor(st.mtimeMs / 1000)}.0`
    if (st.isDirectory()) {
      lines.push(`${path} type=dir mode=0755 uid=0 gid=0 uname=root gname=root ${time}`)
      walk(full)
    } else {
      const exec = isElf(full)
      if (exec) executables++
      files++
      lines.push(`${path} type=file mode=${exec ? '0755' : '0644'} uid=0 gid=0 uname=root gname=root ${time} contents=${vis(full.split('\\').join('/'))}`)
    }
  }
}
walk(src)

const work = mkdtempSync(join(tmpdir(), 'clipworld-tar-'))
try {
  const spec = join(work, 'files.mtree')
  writeFileSync(spec, lines.join('\n') + '\n', 'utf8')
  rmSync(out, { force: true })
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  const r = spawnSync(tar, ['-czf', out, '--format', 'pax', `@${spec}`], { stdio: 'inherit', cwd: dirname(out) })
  if (r.status !== 0) throw new Error('bsdtar failed')
  console.log(`Packed ${files} files (${executables} marked executable) into ${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

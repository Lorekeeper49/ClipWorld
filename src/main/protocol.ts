// Serves local media to the renderer over cwmedia:// with HTTP Range support (needed for seeking).
import { protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export const SCHEME = 'cwmedia'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.ogv': 'video/ogg', '.ts': 'video/mp2t',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream'
}

const allowedFiles = new Set<string>()
const allowedRoots: string[] = []

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))

/** Only files registered here (imported media) or under an allowed root (the cache) are served. */
export function allowFile(path: string): void {
  allowedFiles.add(norm(path))
}
export function allowRoot(dir: string): void {
  allowedRoots.push(norm(dir) + sep)
}

export function mediaUrl(path: string, version?: number): string {
  return `${SCHEME}://local/${encodeURIComponent(path)}${version ? `?v=${Math.round(version)}` : ''}`
}

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

export function handleProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    let path: string
    try {
      path = decodeURIComponent(new URL(request.url).pathname.slice(1))
    } catch {
      return new Response('Bad request', { status: 400, headers: cors })
    }
    const key = norm(path)
    if (!allowedFiles.has(key) && !allowedRoots.some((r) => key.startsWith(r))) {
      return new Response('Forbidden', { status: 403, headers: cors })
    }
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return new Response('Not found', { status: 404, headers: cors })
    }
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const base = { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      let end = range[1] && range[2] ? Number(range[2]) : size - 1
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
      }
      start = Math.max(0, start)
      const rs = createReadStream(path, { start, end })
      if (process.env['CW_DEBUG_PROTOCOL']) {
        const t0 = performance.now()
        let bytes = 0
        rs.on('data', (c) => (bytes += c.length))
        rs.on('close', () =>
          console.log(`[proto] ${extname(path)} range ${start}-${range[2] || ''} served ${bytes} B in ${(performance.now() - t0).toFixed(0)} ms`)
        )
      }
      const stream = Readable.toWeb(rs) as unknown as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      })
    }
    if (size === 0) return new Response(null, { status: 200, headers: { ...base, 'Content-Length': '0' } })
    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
    return new Response(stream, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  })
}

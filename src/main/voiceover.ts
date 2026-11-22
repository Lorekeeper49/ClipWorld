// Voiceover recordings: the renderer streams 16-bit mono samples here while it records, and they are
// written straight to a WAV file, so a long take never has to fit in memory and survives a crash up to
// the last chunk. No Electron imports.
import { mkdirSync } from 'node:fs'
import { type FileHandle, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Take {
  file: FileHandle
  path: string
  bytes: number
  /** Writes in the order they arrived. */
  queue: Promise<void>
}

const takes = new Map<string, Take>()
let seq = 0

/** Where recordings go: a Voiceovers folder next to the project, or in Documents/ClipWorld before it is saved. */
export function voiceoverFolder(projectPath: string | null, documents: string): string {
  return projectPath ? join(dirname(projectPath), 'Voiceovers') : join(documents, 'ClipWorld', 'Voiceovers')
}

const stamp = (d: Date) => {
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

function header(bytes: number, rate: number, channels: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + bytes, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(bytes, 40)
  return h
}

/** Opens a new recording file and returns its id and path. */
export async function beginTake(folder: string, rate: number): Promise<{ id: string; path: string }> {
  mkdirSync(folder, { recursive: true })
  const base = `Voiceover ${stamp(new Date())}`
  let path = join(folder, `${base}.wav`)
  let file: FileHandle | null = null
  for (let i = 2; !file; i++) {
    try {
      // 'wx' fails if the file exists, so a take never overwrites another.
      file = await open(path, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i > 99) throw err
      path = join(folder, `${base} (${i}).wav`)
    }
  }
  // The sizes are filled in when the take ends; until then the header says "empty".
  await file.write(header(0, rate, 1), 0, 44, 0)
  const id = `take${++seq}`
  takes.set(id, { file, path, bytes: 0, queue: Promise.resolve() })
  return { id, path }
}

/** Appends samples (16-bit little-endian PCM) to a take. */
export function writeTake(id: string, data: Uint8Array): Promise<void> {
  const take = takes.get(id)
  if (!take) return Promise.resolve()
  take.queue = take.queue.then(async () => {
    await take.file.write(data, 0, data.length, 44 + take.bytes)
    take.bytes += data.length
  })
  return take.queue
}

/** Finishes a take: writes the final sizes and closes the file. Returns its path and length in seconds. */
export async function endTake(id: string, rate: number): Promise<{ path: string; duration: number } | null> {
  const take = takes.get(id)
  if (!take) return null
  takes.delete(id)
  await take.queue
  try {
    await take.file.write(header(take.bytes, rate, 1), 0, 44, 0)
  } finally {
    await take.file.close()
  }
  return { path: take.path, duration: take.bytes / 2 / rate }
}

/** Throws a take away (too short, or the recording failed). */
export async function discardTake(id: string): Promise<void> {
  const take = takes.get(id)
  if (take) {
    takes.delete(id)
    await take.queue.catch(() => {})
    await take.file.close().catch(() => {})
    await rm(take.path, { force: true })
  }
}

/** Removes a finished take's file (when it could not be added to the project). */
export const removeTakeFile = (path: string): Promise<void> => rm(path, { force: true })

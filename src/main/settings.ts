import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/ipc'

const file = () => join(app.getPath('userData'), 'settings.json')

const defaults: AppSettings = { shortcuts: {}, previewVolume: 1, recent: [] }
let current: AppSettings | null = null
let timer: NodeJS.Timeout | null = null

export function loadSettings(): AppSettings {
  if (current) return current
  try {
    current = { ...defaults, ...JSON.parse(readFileSync(file(), 'utf8')) }
  } catch {
    current = { ...defaults }
  }
  return current!
}

function flush(): void {
  if (!current) return
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch (err) {
    console.error('Could not save settings', err)
  }
}

export function saveSettings(patch: Partial<AppSettings>): void {
  current = { ...loadSettings(), ...patch }
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 300)
}

export function flushSettings(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
    flush()
  }
}

export function addRecent(path: string): void {
  const s = loadSettings()
  saveSettings({ recent: [path, ...s.recent.filter((r) => r !== path)].filter((r) => existsSync(r)).slice(0, 10) })
}

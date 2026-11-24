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

// One running plugin: a child process that speaks JSON-RPC 2.0, one message per line, on stdin/stdout.
// Requests go both ways: ClipWorld asks the plugin to run a command or give an effect's filter, and the
// plugin asks ClipWorld for the project or to make an edit. Anything the plugin writes to stderr is kept
// as its log. No Electron imports, so tests can run real plugins.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PLUGIN_API_VERSION, type PluginManifest, interpreterCandidates, pluginRuntime } from '@shared/plugins'

export interface PluginHandlers {
  /** A request from the plugin (getProject, askUser…). Throw to answer it with an error. */
  request(pluginId: string, method: string, params: unknown): Promise<unknown>
  /** A notification (a message without an id) from the plugin. */
  notify?(pluginId: string, method: string, params: unknown): void
  /** The process ended while it was meant to be running. */
  exited?(pluginId: string, message: string): void
}

/** How to start a plugin: the program and its arguments, or why it can't be started. */
export type LaunchSpec = { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string }

const found = new Map<string, string[] | null>()

/** The first interpreter of the kind that runs on this computer (remembered once found). */
function interpreter(kind: 'python' | 'lua'): string[] | null {
  if (found.has(kind)) return found.get(kind)!
  for (const c of interpreterCandidates(kind, process.platform)) {
    const r = spawnSync(c[0], [...c.slice(1), kind === 'lua' ? '-v' : '--version'], { timeout: 5000, windowsHide: true })
    if (r.status === 0) {
      found.set(kind, c)
      return c
    }
  }
  found.set(kind, null)
  return null
}

/**
 * How to start the plugin in `dir`. JavaScript and TypeScript use `node` (by default the Node.js inside
 * ClipWorld itself), Python and Lua the interpreter installed on the computer.
 */
export function launchSpec(manifest: PluginManifest, dir: string, node: { cmd: string; env: NodeJS.ProcessEnv }): LaunchSpec {
  if (manifest.apiVersion > PLUGIN_API_VERSION) {
    return { error: `Needs a newer ClipWorld (plugin API ${manifest.apiVersion}; this version has ${PLUGIN_API_VERSION})` }
  }
  const rt = pluginRuntime(manifest)
  const env = { ...process.env, CLIPWORLD_PLUGIN: manifest.id, CLIPWORLD_PLUGIN_DIR: dir, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  if (!rt) return { error: `Don't know how to run "${manifest.main}": use .js, .ts, .py or .lua, or give "command" in plugin.json` }
  if (rt.kind === 'node') return { cmd: node.cmd, args: [join(dir, rt.file)], env: { ...env, ...node.env } }
  if (rt.kind === 'command') return { cmd: rt.command[0], args: rt.command.slice(1), env }
  const found = interpreter(rt.kind)
  if (!found) {
    return {
      error: rt.kind === 'python'
        ? 'Python was not found. Install it from python.org (or your package manager), then restart the plugin.'
        : 'Lua was not found. Install Lua 5.3 or newer (lua.org or your package manager), then restart the plugin.'
    }
  }
  return { cmd: found[0], args: [...found.slice(1), join(dir, rt.file)], env }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const LOG_LINES = 300

export class PluginProcess {
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private stopping = false
  /** The plugin's recent stderr (and anything on stdout that isn't a message). */
  readonly log: string[] = []

  constructor(
    readonly id: string,
    private readonly dir: string,
    private readonly spec: { cmd: string; args: string[]; env: NodeJS.ProcessEnv },
    private readonly handlers: PluginHandlers
  ) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.stopping
  }

  private addLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      this.log.push(line)
      if (this.log.length > LOG_LINES) this.log.shift()
    }
  }

  /** Starts the process and says hello. Rejects if it can't start or doesn't answer in time. */
  async start(app: { version: string; language: string }, timeoutMs = 15000): Promise<void> {
    const child = spawn(this.spec.cmd, this.spec.args, { cwd: this.dir, env: this.spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.stderr!.on('data', (chunk: string) => this.addLog(chunk))
    child.stdin!.on('error', () => {})
    const failed = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`Could not start ${this.spec.cmd}: ${err.message}`)))
    })
    child.once('exit', (code, signal) => {
      const why = `The plugin stopped (${signal ?? `exit code ${code}`})`
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(new Error(why))
      }
      this.pending.clear()
      if (!this.stopping) {
        const last = this.log.slice(-3).join(' · ')
        this.handlers.exited?.(this.id, last ? `${why}: ${last}` : why)
      }
    })
    await Promise.race([
      failed,
      this.request('initialize', { apiVersion: PLUGIN_API_VERSION, app, plugin: { id: this.id, dir: this.dir } }, timeoutMs)
    ])
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        // print() left in a plugin: keep it in the log rather than failing.
        this.addLog(line)
        continue
      }
      if (msg.method) void this.onRequest(msg as { id?: number | string | null; method: string; params?: unknown })
      else if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (p.timer) clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || 'The plugin reported an error'))
        else p.resolve(msg.result ?? null)
      }
    }
  }

  private async onRequest(msg: { id?: number | string | null; method: string; params?: unknown }): Promise<void> {
    if (msg.id === undefined || msg.id === null) {
      this.handlers.notify?.(this.id, msg.method, msg.params)
      return
    }
    try {
      const result = await this.handlers.request(this.id, msg.method, msg.params ?? {})
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
    } catch (err) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: (err as Error)?.message ?? String(err) } })
    }
  }

  private send(msg: object): void {
    if (!this.child?.stdin?.writable) return
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  /** Asks the plugin something. `timeoutMs` 0 waits as long as it takes (commands may ask the user things). */
  request(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('The plugin is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject }
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`The plugin did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      }
      this.pending.set(id, p)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Asks the plugin to finish, then ends the process if it hasn't within a moment. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    this.stopping = true
    this.notify('shutdown', {})
    child.stdin?.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

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

// Plugins: reading plugin.json, how each language is started, conflicts between plugins, plugin effects
// in the export, and the real example plugins (JavaScript, TypeScript, Python, Lua) talking to ClipWorld.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { EFFECTS, EFFECT_MAP, makeEffect, setPluginEffects } from '@shared/effects'
import { newProject } from '@shared/model'
import {
  type PluginManifest, findConflicts, interpreterCandidates, parseManifest, parsePluginEffectType, pluginEffectDefs, pluginEffectType,
  pluginRuntime, pluginText
} from '@shared/plugins'
import { defaultExportSettings } from '@shared/formats'
import { placeMedia } from '@shared/timeline-ops'
import { runExport } from '../src/main/export'
import { ffmpeg, usableCapabilities } from '../src/main/ffmpeg'
import { probeMedia } from '../src/main/probe'
import { PluginProcess, launchSpec } from '../src/main/pluginProcess'
import { TMP, frameColor, setupFfmpeg } from './helpers'

const ROOT = join(__dirname, '..')
const EXAMPLES = join(ROOT, 'plugins', 'examples')
/** The Node.js inside Electron, as the app runs plugins (it runs TypeScript directly). */
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const NODE = { cmd: ELECTRON, env: { ELECTRON_RUN_AS_NODE: '1' } }
const hasLua = interpreterCandidates('lua', process.platform).some((c) => spawnSync(c[0], [...c.slice(1), '-v']).status === 0)

const manifest = (over: Record<string, unknown> = {}): PluginManifest => {
  const m = parseManifest({ id: 'a.b', name: 'A', main: 'main.js', ...over })
  if (typeof m === 'string') throw new Error(m)
  return m
}
const example = (name: string): PluginManifest => manifest(JSON.parse(readFileSync(join(EXAMPLES, name, 'plugin.json'), 'utf8')))

describe('plugin.json', () => {
  test('a minimal plugin', () => {
    const m = manifest()
    expect(m).toMatchObject({ id: 'a.b', version: '0.0.0', apiVersion: 1, conflicts: [], commands: [], effects: [] })
  })

  test('what is wrong is said plainly', () => {
    expect(parseManifest(null)).toMatch(/object/)
    expect(parseManifest({ id: 'bad id!', name: 'x', main: 'a.js' })).toMatch(/"id"/)
    expect(parseManifest({ id: 'a', main: 'a.js' })).toMatch(/"name"/)
    expect(parseManifest({ id: 'a', name: 'A' })).toMatch(/main/)
    expect(parseManifest({ id: 'a', name: 'A', main: 'a.js', commands: [{ id: 'x' }] })).toMatch(/commands\[0\] needs a "title"/)
    expect(parseManifest({ id: 'a', name: 'A', main: 'a.js', commands: [{ id: 'x', title: 'X' }, { id: 'x', title: 'Y' }] })).toMatch(/twice/)
    expect(parseManifest({ id: 'a', name: 'A', main: 'a.js', importers: [{ id: 'x', title: 'X', extensions: [] }] })).toMatch(/extensions/)
    expect(parseManifest({ id: 'a', name: 'A', main: 'a.js', effects: [{ id: 'x', title: 'X', params: [{ key: 's', type: 'select' }] }] })).toMatch(/options/)
  })

  test('every example is valid', () => {
    for (const name of ['hello-js', 'film-effects-ts', 'csv-python', 'clip-length-lua']) expect(typeof example(name).id).toBe('string')
  })

  test('text can be given per language', () => {
    expect(pluginText({ en: 'Hello', ja: 'こんにちは' }, 'ja')).toBe('こんにちは')
    expect(pluginText({ en: 'Hello', ja: 'こんにちは' }, 'ja-JP')).toBe('こんにちは')
    expect(pluginText({ en: 'Hello' }, 'fr')).toBe('Hello')
    expect(pluginText('Plain', 'ja')).toBe('Plain')
  })

  test('the file extension picks how a plugin runs', () => {
    expect(pluginRuntime(manifest({ main: 'main.mjs' }))?.kind).toBe('node')
    expect(pluginRuntime(manifest({ main: 'main.ts' }))?.kind).toBe('node')
    expect(pluginRuntime(manifest({ main: 'main.py' }))?.kind).toBe('python')
    expect(pluginRuntime(manifest({ main: 'main.lua' }))?.kind).toBe('lua')
    expect(pluginRuntime(manifest({ command: ['ruby', 'main.rb'] }))).toEqual({ kind: 'command', command: ['ruby', 'main.rb'] })
    expect(pluginRuntime(manifest({ main: 'main.rb' }))).toBeNull()
    expect(interpreterCandidates('python', 'win32')[0]).toEqual(['py', '-3'])
    expect(interpreterCandidates('python', 'linux')[0]).toEqual(['python3'])
  })

  test('plugins written for a newer ClipWorld are not started', () => {
    const spec = launchSpec(manifest({ apiVersion: 99 }), EXAMPLES, NODE)
    expect('error' in spec && spec.error).toMatch(/newer ClipWorld/)
  })
})

describe('conflicts', () => {
  const a = manifest({ id: 'a', commands: [{ id: 'x', title: 'X', shortcut: 'Ctrl+Alt+T' }], importers: [{ id: 'i', title: 'I', extensions: ['csv'] }] })
  test('the same shortcut', () => {
    const b = manifest({ id: 'b', commands: [{ id: 'y', title: 'Y', shortcut: 'ctrl+alt+t' }] })
    expect(findConflicts(b, [a])).toEqual([{ id: 'a', reason: 'shortcut', detail: 'Ctrl+Alt+T' }])
  })
  test('the same file type to import', () => {
    const b = manifest({ id: 'b', importers: [{ id: 'j', title: 'J', extensions: ['.CSV'] }] })
    expect(findConflicts(b, [a])).toEqual([{ id: 'a', reason: 'importer', detail: 'csv' }])
  })
  test('a plugin that says so, either way round', () => {
    expect(findConflicts(manifest({ id: 'b', conflicts: ['a'] }), [a])).toEqual([{ id: 'a', reason: 'declared' }])
    expect(findConflicts(manifest({ id: 'b' }), [manifest({ id: 'a', conflicts: ['b'] })])).toEqual([{ id: 'a', reason: 'declared' }])
  })
  test('a shortcut the user changed counts as it is now', () => {
    const b = manifest({ id: 'b', commands: [{ id: 'y', title: 'Y', shortcut: 'Ctrl+Alt+T' }] })
    expect(findConflicts(b, [a], (pid, c) => (pid === 'a' ? 'F9' : c.shortcut ?? ''))).toEqual([])
  })
  test('plugins that add different things get along', () => {
    expect(findConflicts(example('film-effects-ts'), [example('hello-js'), example('csv-python')])).toEqual([])
  })
})

describe('plugin effects', () => {
  afterEach(() => setPluginEffects([]))

  test('are added to the effects list and taken away again', () => {
    setPluginEffects(pluginEffectDefs([{ manifest: example('film-effects-ts') }], 'ja'))
    const type = pluginEffectType('example.film-effects-ts', 'oldFilm')
    expect(EFFECT_MAP[type]).toMatchObject({ target: 'video', kind: 'plugin', group: 'Plugins' })
    expect(EFFECT_MAP[type].labels?.name).toBe('古いフィルム')
    expect(EFFECT_MAP[pluginEffectType('example.film-effects-ts', 'telephone')].target).toBe('audio')
    expect(makeEffect(type).params).toEqual({ amount: 0.8, grain: true })
    expect(parsePluginEffectType(type)).toEqual({ pluginId: 'example.film-effects-ts', effectId: 'oldFilm' })
    const count = EFFECTS.length
    setPluginEffects([])
    expect(EFFECT_MAP[type]).toBeUndefined()
    expect(EFFECTS.length).toBe(count - 2)
  })

  test("the plugin's filter is used in the export", async () => {
    setupFfmpeg()
    setPluginEffects(pluginEffectDefs([{ manifest: example('film-effects-ts') }]))
    // A red video, turned gray by the filter a plugin gave.
    const red = join(TMP, 'red.mkv')
    if (!existsSync(red)) await ffmpeg(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1', '-c:v', 'ffv1', red])
    const p = newProject()
    p.settings = { width: 160, height: 90, fps: 25 }
    const media = await probeMedia(red)
    p.media.push(media)
    placeMedia(p, media, 0)
    const fx = makeEffect(pluginEffectType('example.film-effects-ts', 'oldFilm'))
    p.clips[0].effects.push(fx)
    const out = join(TMP, 'plugin-effect.mp4')
    const r = await runExport({
      project: p, settings: { ...defaultExportSettings(), container: 'mp4' }, outPath: out,
      tmpDir: join(TMP, 'plugin-effect-job'), caps: await usableCapabilities(), assets: { pluginFilters: { [fx.id]: 'hue=s=0' } }
    })
    expect(r.filter).toContain('hue=s=0')
    const [rr, gg, bb] = await frameColor(out, 0.5)
    expect(Math.max(rr, gg, bb) - Math.min(rr, gg, bb)).toBeLessThan(8)
    // Without a filter (its plugin gave none), the clip is left as it is.
    const plain = join(TMP, 'plugin-effect-none.mp4')
    await runExport({ project: p, settings: { ...defaultExportSettings(), container: 'mp4' }, outPath: plain, tmpDir: join(TMP, 'plugin-effect-job2'), caps: await usableCapabilities() })
    expect((await frameColor(plain, 0.5))[0]).toBeGreaterThan(200)
  })
})

// ---------------------------------------------------------------- the example plugins, really running

/** Starts an example plugin; `answers` is how "ClipWorld" answers its requests, and every request is recorded. */
async function run(name: string, answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const m = example(name)
  const dir = join(EXAMPLES, name)
  const spec = launchSpec(m, dir, NODE)
  if ('error' in spec) throw new Error(spec.error)
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const notes: { method: string; params: unknown }[] = []
  const proc = new PluginProcess(m.id, dir, spec, {
    request: async (_id, method, params) => {
      calls.push({ method, params: params as Record<string, unknown> })
      const fn = answers[method]
      if (!fn) throw new Error(`Unknown method "${method}"`)
      return fn(params as Record<string, unknown>)
    },
    notify: (_id, method, params) => notes.push({ method, params })
  })
  await proc.start({ version: 'test', language: 'en' })
  return { proc, calls, notes }
}

const procs: PluginProcess[] = []
afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.stop()))
})

describe('example plugins', () => {
  beforeAll(() => mkdirSync(join(TMP, 'plugins'), { recursive: true }))

  test('JavaScript: a command asks the user, then adds a title', async () => {
    const r = await run('hello-js', {
      askUser: () => ({ text: 'Big title', seconds: 4, color: '#00ff00' }),
      addTextClip: () => 'c42',
      setSelection: () => null
    })
    procs.push(r.proc)
    const result = await r.proc.request('command', { command: 'addTitle', selection: [], playhead: 7.5 })
    expect(result).toBe('Added “Big title”')
    expect(r.calls.map((c) => c.method)).toEqual(['askUser', 'addTextClip', 'setSelection'])
    expect(r.calls[1].params).toEqual({ start: 7.5, text: { content: 'Big title', color: '#00ff00' }, duration: 4 })
    expect(r.calls[2].params).toEqual({ ids: ['c42'] })
  })

  test('JavaScript: cancelling the question changes nothing', async () => {
    const r = await run('hello-js', { askUser: () => null })
    procs.push(r.proc)
    expect(await r.proc.request('command', { command: 'addTitle', selection: [], playhead: 0 })).toBeNull()
    expect(r.calls.map((c) => c.method)).toEqual(['askUser'])
  })

  test('JavaScript: its window asks for the clips and gets them', async () => {
    const r = await run('hello-js', { getProject: () => ({ clips: [{ id: 'b', type: 'text', start: 2, duration: 1, name: '', text: { content: 'Two' } }, { id: 'a', type: 'video', start: 0, duration: 2, name: 'one.mp4' }] }) })
    procs.push(r.proc)
    r.proc.notify('panelMessage', { panel: 'clips', data: { action: 'refresh' } })
    await expect.poll(() => r.notes.length).toBe(1)
    expect(r.notes[0]).toEqual({
      method: 'postToPanel',
      params: { panel: 'clips', data: { clips: [{ id: 'a', name: 'one.mp4', type: 'video', start: 0, duration: 2 }, { id: 'b', name: 'Two', type: 'text', start: 2, duration: 1 }] } }
    })
  })

  test('TypeScript: effects give ffmpeg filters (run without building)', async () => {
    const r = await run('film-effects-ts')
    procs.push(r.proc)
    const film = (await r.proc.request('effectFilter', { effect: 'oldFilm', params: { amount: 1, grain: false }, preview: false })) as { filter: string }
    expect(film.filter).toBe('colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131')
    const none = (await r.proc.request('effectFilter', { effect: 'oldFilm', params: { amount: 0, grain: true }, preview: true })) as { filter: string }
    expect(none.filter).toBe('colorchannelmixer=rr=1.000:rg=0.000:rb=0.000:gr=0.000:gg=1.000:gb=0.000:br=0.000:bg=0.000:bb=1.000,noise=alls=4:allf=t')
    const phone = (await r.proc.request('effectFilter', { effect: 'telephone', params: { low: 300, high: 3400 } })) as { filter: string }
    expect(phone.filter).toBe('highpass=f=300,lowpass=f=3400,volume=1.6')
    await expect(r.proc.request('effectFilter', { effect: 'nope', params: {} })).rejects.toThrow(/no effect "nope"/)
  })

  test('Python: exports the clips as CSV and imports titles from CSV', async () => {
    const out = join(TMP, 'plugins', 'clips.csv')
    rmSync(out, { force: true })
    let n = 0
    const r = await run('csv-python', {
      getProject: () => ({
        media: [{ id: 'm1', path: 'C:\\Footage\\take.mp4' }],
        clips: [
          { id: 'c2', type: 'text', start: 3, duration: 2, name: 'Text', text: { content: 'Héllo, “world”' } },
          { id: 'c1', type: 'video', start: 0, duration: 3, name: 'take.mp4', mediaId: 'm1' }
        ]
      }),
      addTextClip: () => `t${++n}`,
      setSelection: () => null
    })
    procs.push(r.proc)
    expect(await r.proc.request('export', { exporter: 'clipList', path: out })).toEqual({ message: 'Wrote 2 clips' })
    const csv = readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(csv).toEqual([
      'start,end,length,type,name,file',
      '0.000,3.000,3.000,video,take.mp4,C:\\Footage\\take.mp4',
      '3.000,5.000,2.000,text,"Héllo, “world”",'
    ])
    const titles = join(TMP, 'plugins', 'titles.csv')
    writeFileSync(titles, 'start,length,text\n1,2,First\n4.5,1.5,"Second, with comma"\nnot,a,row\n')
    expect(await r.proc.request('import', { importer: 'titles', path: titles })).toEqual({ message: 'Added 2 titles' })
    expect(r.calls.filter((c) => c.method === 'addTextClip').map((c) => c.params)).toEqual([
      { start: 1, text: { content: 'First' }, duration: 2 },
      { start: 4.5, text: { content: 'Second, with comma' }, duration: 1.5 }
    ])
    expect(r.calls.find((c) => c.method === 'setSelection')?.params).toEqual({ ids: ['t1', 't2'] })
  })

  test.skipIf(!hasLua)('Lua: asks for a length and sets it on the selected clips', async () => {
    const r = await run('clip-length-lua', { askUser: () => ({ seconds: 2.5 }), updateClip: () => null, showMessage: () => null })
    procs.push(r.proc)
    expect(await r.proc.request('command', { command: 'setLength', selection: ['a', 'b'], playhead: 0 })).toEqual({ message: 'Changed 2 clips' })
    expect(r.calls.filter((c) => c.method === 'updateClip').map((c) => c.params)).toEqual([
      { id: 'a', changes: { duration: 2.5 } },
      { id: 'b', changes: { duration: 2.5 } }
    ])
  })

  test('the SDK copies in the examples match the SDK', () => {
    for (const [dir, file] of [['hello-js', 'clipworld.mjs'], ['film-effects-ts', 'clipworld.ts'], ['csv-python', 'clipworld.py'], ['clip-length-lua', 'clipworld.lua']]) {
      expect(readFileSync(join(EXAMPLES, dir, file), 'utf8')).toBe(readFileSync(join(ROOT, 'plugins', 'sdk', file), 'utf8'))
    }
  })
})

describe('plugins that misbehave', () => {
  const dir = join(TMP, 'plugins', 'bad')
  const start = async (code: string, handlers: Partial<ConstructorParameters<typeof PluginProcess>[3]> = {}) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'main.js'), code)
    const proc = new PluginProcess('bad', dir, { cmd: ELECTRON, args: [join(dir, 'main.js')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, {
      request: async () => null, ...handlers
    })
    procs.push(proc)
    return proc
  }
  const respond = `require('readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); `

  test('one that never answers times out with a clear message', async () => {
    const proc = await start('setInterval(() => {}, 1000)')
    await expect(proc.start({ version: 't', language: 'en' }, 800)).rejects.toThrow(/did not answer "initialize"/)
  })

  test('stray printing is kept as its messages, not mistaken for answers', async () => {
    const proc = await start(`${respond} console.log('debug: ' + m.method); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 1 }) + '\\n') })`)
    await proc.start({ version: 't', language: 'en' })
    expect(proc.log).toContain('debug: initialize')
  })

  test('one that crashes is reported, with what it said', async () => {
    let exited = ''
    const proc = await start(`${respond} if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 1 }) + '\\n'); else { console.error('boom happened'); process.exit(3) } })`, {
      exited: (_id, msg) => { exited = msg }
    })
    await proc.start({ version: 't', language: 'en' })
    await expect(proc.request('command', {})).rejects.toThrow(/stopped/)
    await expect.poll(() => exited).toMatch(/exit code 3.*boom happened/)
  })

  test('a program that is not there', async () => {
    const proc = new PluginProcess('none', TMP, { cmd: join(TMP, 'no-such-program.exe'), args: [], env: process.env }, { request: async () => null })
    await expect(proc.start({ version: 't', language: 'en' })).rejects.toThrow(/Could not start/)
    expect(existsSync(join(TMP, 'no-such-program.exe'))).toBe(false)
  })
})

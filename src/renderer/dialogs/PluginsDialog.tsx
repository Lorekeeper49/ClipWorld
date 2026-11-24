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

// Plugins ▸ Manage plugins: what's installed, turning plugins on and off (with a warning, and an offer to
// turn off plugins that are on and could break), installing, removing, restarting and their messages.
import { useEffect, useState } from 'react'
import { type PluginConflict, type PluginInfo, pluginRuntime, pluginText } from '@shared/plugins'
import { Btn, Icon, Modal } from '../components/ui'
import { useT } from '../i18n'
import { conflictsFor, pluginName, setPluginsEnabled } from '../state/plugins'
import { set, toast, useStore } from '../state/store'

function summary(p: PluginInfo, t: ReturnType<typeof useT>): string {
  const m = p.manifest
  const parts = [
    m.commands.length && t('plugins.adds.commands', { count: m.commands.length }),
    m.importers.length && t('plugins.adds.importers', { count: m.importers.length }),
    m.exporters.length && t('plugins.adds.exporters', { count: m.exporters.length }),
    m.effects.length && t('plugins.adds.effects', { count: m.effects.length }),
    m.panels.length && t('plugins.adds.panels', { count: m.panels.length })
  ].filter(Boolean)
  const rt = pluginRuntime(m)
  const runtime = rt?.kind === 'node' ? (/\.(m|c)?ts$/i.test(rt.file) ? 'TypeScript' : 'JavaScript') : rt?.kind === 'python' ? 'Python' : rt?.kind === 'lua' ? 'Lua' : rt?.kind === 'command' ? rt.command[0] : '?'
  return [runtime, ...parts].join(' · ')
}

/** Asked before a plugin is turned on: the warning, and the plugins it could break, offered to be turned off. */
function TurnOn({ plugin, conflicts, onDone }: { plugin: PluginInfo; conflicts: PluginConflict[]; onDone: () => void }) {
  const t = useT()
  const plugins = useStore((s) => s.plugins?.plugins ?? [])
  const [off, setOff] = useState<Set<string>>(() => new Set(conflicts.map((c) => c.id)))
  const nameOf = (id: string) => {
    const p = plugins.find((x) => x.manifest.id === id)
    return p ? pluginName(p) : id
  }
  const go = async () => {
    await setPluginsEnabled([...[...off].map((id) => ({ id, on: false })), { id: plugin.manifest.id, on: true }])
    onDone()
  }
  return (
    <div className="plugin-confirm" data-testid="plugin-confirm">
      <p className="plugin-warning"><Icon name="warn" size={14} /> {t('plugins.trustWarning')}</p>
      {conflicts.length > 0 && (
        <>
          <p>{t('plugins.conflictIntro', { name: pluginName(plugin), count: conflicts.length })}</p>
          <ul className="plugin-conflicts" data-testid="plugin-conflicts">
            {conflicts.map((c) => (
              <li key={c.id}>
                <label>
                  <input type="checkbox" checked={off.has(c.id)} data-testid="plugin-conflict-off"
                    onChange={(e) => setOff((cur) => { const n = new Set(cur); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n })} />
                  <span>{t('plugins.turnOff', { name: nameOf(c.id) })}</span>
                </label>
                <span className="dim small">{t(`plugins.conflictReason.${c.reason}`, { detail: c.detail ?? '' })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="plugin-confirm-buttons">
        <Btn small onClick={onDone} testId="plugin-confirm-cancel">{t('common.cancel')}</Btn>
        <Btn small primary onClick={() => void go()} testId="plugin-confirm-on">
          {off.size ? t('plugins.turnOnAndOff', { count: off.size }) : t('plugins.turnOn')}
        </Btn>
      </div>
    </div>
  )
}

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const t = useT()
  const lang = useStore((s) => s.lang)
  const [asking, setAsking] = useState<PluginConflict[] | null>(null)
  const [log, setLog] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState(false)
  const m = plugin.manifest
  const toggle = (on: boolean) => {
    if (!on) void setPluginsEnabled([{ id: m.id, on: false }])
    else setAsking(conflictsFor(plugin))
  }
  const showLog = async () => setLog(log ? null : await window.cw.pluginLog(m.id))
  const state = plugin.enabled ? plugin.state : 'off'
  return (
    <li className={`plugin-row ${state}`} data-testid="plugin-row" data-plugin-id={m.id}>
      <div className="plugin-head">
        <label className="toggle" title={plugin.enabled ? t('plugins.turnOffHint') : t('plugins.turnOnHint')}>
          <input type="checkbox" checked={plugin.enabled || !!asking} onChange={(e) => toggle(e.target.checked)} data-testid="plugin-toggle" />
          <span className="toggle-track" />
        </label>
        <div className="plugin-title" data-i18n-ignore="">
          <strong>{pluginText(m.name, lang)}</strong> <span className="dim small">{m.version}{m.author ? ` · ${m.author}` : ''}</span>
          {m.description && <p className="dim small">{pluginText(m.description, lang)}</p>}
        </div>
        <span className={`plugin-state ${state}`} data-testid="plugin-state">{t(`plugins.state.${state}`)}</span>
      </div>
      <p className="dim small plugin-adds" data-i18n-ignore="">{summary(plugin, t)}{plugin.installed ? '' : ` · ${t('plugins.linked')}`}</p>
      {plugin.enabled && plugin.state === 'error' && plugin.error && <p className="plugin-error small" data-testid="plugin-error" data-i18n-ignore="">{plugin.error}</p>}
      {asking && <TurnOn plugin={plugin} conflicts={asking} onDone={() => setAsking(null)} />}
      <div className="plugin-buttons">
        {plugin.enabled && <Btn small icon="reset" onClick={() => void window.cw.restartPlugin(m.id)} testId="plugin-restart">{t('plugins.restart')}</Btn>}
        <Btn small icon="info" onClick={() => void showLog()} testId="plugin-log">{log ? t('plugins.hideLog') : t('plugins.log')}</Btn>
        {removing ? (
          <Btn small danger onClick={() => void window.cw.removePlugin(m.id)} testId="plugin-remove-confirm">
            {plugin.installed ? t('plugins.confirmRemove') : t('plugins.confirmForget')}
          </Btn>
        ) : (
          <Btn small icon="trash" onClick={() => setRemoving(true)} testId="plugin-remove">{plugin.installed ? t('plugins.remove') : t('plugins.forget')}</Btn>
        )}
      </div>
      {log && <pre className="plugin-log" data-testid="plugin-log-text" data-i18n-ignore="">{log.length ? log.join('\n') : t('plugins.logEmpty')}</pre>}
    </li>
  )
}

export function PluginsDialog() {
  const t = useT()
  const list = useStore((s) => s.plugins)
  useEffect(() => {
    void window.cw.rescanPlugins().then((l) => set({ plugins: l }))
  }, [])
  const install = async () => {
    const r = await window.cw.installPlugin()
    if (r.error) toast(t('plugins.installFailed', { error: r.error }), 'error')
    else if (r.id) toast(r.updated ? t('plugins.updated') : t('plugins.installed'))
  }
  const plugins = [...(list?.plugins ?? [])].sort((a, b) => pluginName(a).localeCompare(pluginName(b)))
  return (
    <Modal title={t('plugins.title')} width={640} onClose={() => set({ modal: null })}
      footer={<Btn primary onClick={() => set({ modal: null })}>{t('common.close')}</Btn>}>
      <div className="plugin-toolbar">
        <Btn small icon="upload" onClick={() => void install()} testId="plugin-install">{t('plugins.install')}</Btn>
        <Btn small icon="folder" onClick={() => void window.cw.openPluginsFolder()}>{t('plugins.openFolder')}</Btn>
        <Btn small icon="reset" onClick={() => void window.cw.rescanPlugins().then((l) => set({ plugins: l }))} testId="plugin-rescan">{t('plugins.rescan')}</Btn>
      </div>
      <p className="dim small">{t('plugins.intro')}</p>
      {plugins.length === 0 ? (
        <p className="dim" data-testid="plugins-empty">{t('plugins.empty')}</p>
      ) : (
        <ul className="plugin-list">{plugins.map((p) => <PluginRow key={p.manifest.id} plugin={p} />)}</ul>
      )}
      {(list?.broken.length ?? 0) > 0 && (
        <>
          <p className="dim small">{t('plugins.brokenTitle')}</p>
          <ul className="plugin-broken" data-testid="plugins-broken" data-i18n-ignore="">
            {list!.broken.map((b) => <li key={b.dir}><span>{b.dir}</span> <span className="plugin-error small">{b.error}</span></li>)}
          </ul>
        </>
      )}
    </Modal>
  )
}

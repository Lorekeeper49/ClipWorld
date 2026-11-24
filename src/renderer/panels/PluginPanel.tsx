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

// A plugin's window: its page from the plugin's folder, in a sandboxed frame that can't reach ClipWorld
// itself. The page talks to its plugin with postMessage: what it posts as { type: 'clipworld', data }
// goes to the plugin as "panelMessage", and the plugin's "postToPanel" arrives the same way.
import { useEffect, useRef } from 'react'
import { Icon } from '../components/ui'
import { useT } from '../i18n'
import { useStore } from '../state/store'

export function PluginPanel({ plugin, panel }: { plugin: string; panel: string }) {
  const t = useT()
  const ref = useRef<HTMLIFrameElement>(null)
  const info = useStore((s) => s.plugins?.plugins.find((p) => p.manifest.id === plugin) ?? null)
  const page = info?.manifest.panels.find((p) => p.id === panel)?.page
  const running = info?.enabled && info.state === 'running'
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return
      const msg = e.data as { type?: string; data?: unknown } | null
      if (msg?.type === 'clipworld') window.cw.notifyPlugin(plugin, 'panelMessage', { panel, data: msg.data ?? null })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [plugin, panel])
  if (!info || !page || !running) {
    return (
      <div className="panel empty" data-panel="plugin">
        <Icon name="warn" size={22} />
        <p className="dim">{info && page ? t('plugins.panelOff') : t('plugins.panelMissing')}</p>
      </div>
    )
  }
  const src = `cwplugin://${encodeURIComponent(plugin)}/${page.split('/').map(encodeURIComponent).join('/')}`
  return (
    <div className="panel plugin-panel" data-panel="plugin">
      <iframe ref={ref} src={src} title={panel} sandbox="allow-scripts allow-forms" data-plugin={plugin} data-plugin-panel={panel} />
    </div>
  )
}

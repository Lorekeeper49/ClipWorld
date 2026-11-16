// The dockable workspace: six panels the user can drag, tab, split, float and close.
import { type DockviewApi, DockviewReact, type DockviewReadyEvent, themeAbyss } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { AudioPanel } from '../panels/AudioPanel'
import { MediaPanel } from '../panels/MediaPanel'
import { MetadataPanel } from '../panels/MetadataPanel'
import { PreviewPanel } from '../panels/PreviewPanel'
import { TimelinePanel } from '../panels/TimelinePanel'
import { ToolsPanel } from '../panels/ToolsPanel'
import { get, patchSettings } from '../state/store'

export const PANELS = [
  { id: 'media', title: 'Media' },
  { id: 'preview', title: 'Preview' },
  { id: 'tools', title: 'Tools' },
  { id: 'metadata', title: 'Metadata' },
  { id: 'audio', title: 'Audio' },
  { id: 'timeline', title: 'Timeline' }
] as const

export type PanelId = (typeof PANELS)[number]['id']

const components = {
  media: MediaPanel,
  preview: PreviewPanel,
  tools: ToolsPanel,
  metadata: MetadataPanel,
  audio: AudioPanel,
  timeline: TimelinePanel
}

let api: DockviewApi | null = null
const listeners = new Set<() => void>()

function defaultLayout(a: DockviewApi): void {
  a.clear()
  a.addPanel({ id: 'preview', component: 'preview', title: 'Preview' })
  a.addPanel({ id: 'media', component: 'media', title: 'Media', position: { referencePanel: 'preview', direction: 'left' }, initialWidth: 320 })
  a.addPanel({ id: 'tools', component: 'tools', title: 'Tools', position: { referencePanel: 'preview', direction: 'right' }, initialWidth: 360 })
  a.addPanel({ id: 'metadata', component: 'metadata', title: 'Metadata', position: { referencePanel: 'tools', direction: 'within' }, inactive: true })
  a.addPanel({ id: 'audio', component: 'audio', title: 'Audio', position: { referencePanel: 'tools', direction: 'below' }, initialHeight: 230 })
  a.addPanel({ id: 'timeline', component: 'timeline', title: 'Timeline', position: { direction: 'below' }, initialHeight: 330 })
}

export function resetLayout(): void {
  if (api) defaultLayout(api)
}

export function isPanelOpen(id: PanelId): boolean {
  return !!api?.getPanel(id)
}

export function togglePanel(id: PanelId): void {
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.close()
    return
  }
  const def = PANELS.find((p) => p.id === id)!
  // Reopened panels float so they never rearrange the layout the user built.
  api.addPanel({ id, component: id, title: def.title, floating: { width: 420, height: 360 } })
}

export function subscribePanels(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function onReady(e: DockviewReadyEvent): void {
  api = e.api
  const saved = get().settings.layout
  let restored = false
  if (saved) {
    try {
      api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0])
      restored = api.panels.length > 0
    } catch {
      restored = false
    }
  }
  if (!restored) defaultLayout(api)
  let timer: ReturnType<typeof setTimeout> | null = null
  api.onDidLayoutChange(() => {
    for (const l of listeners) l()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => api && patchSettings({ layout: api.toJSON() }), 400)
  })
}

export function Dock() {
  return <DockviewReact className="dock" theme={themeAbyss} components={components} onReady={onReady} />
}

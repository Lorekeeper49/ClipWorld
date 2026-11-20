// The dockable workspace: six panels the user can drag, tab, split, float and close.
import { type DockviewApi, type DockviewMessages, DockviewReact, type DockviewReadyEvent, themeAbyss } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { AudioPanel } from '../panels/AudioPanel'
import { MediaPanel } from '../panels/MediaPanel'
import { MetadataPanel } from '../panels/MetadataPanel'
import { PreviewPanel } from '../panels/PreviewPanel'
import { PropertiesPanel } from '../panels/PropertiesPanel'
import { TimelinePanel } from '../panels/TimelinePanel'
import { SubtitlesPanel } from '../panels/SubtitlesPanel'
import { ToolsPanel } from '../panels/ToolsPanel'
import { t } from '@shared/i18n'
import { get, patchSettings, useStore } from '../state/store'

const title = (id: string) => t(`panels.${id}`)

/** Titles are message keys: panels.<id>. */
export const PANELS = [
  { id: 'media' }, { id: 'subtitles' }, { id: 'preview' }, { id: 'tools' }, { id: 'properties' }, { id: 'metadata' }, { id: 'audio' },
  { id: 'timeline' }
] as const

export type PanelId = (typeof PANELS)[number]['id']

/** Each window is drawn inside its own error boundary, so one crashing doesn't take the others with it. */
const guarded = (Panel: () => React.ReactNode) => () => <ErrorBoundary><Panel /></ErrorBoundary>
const components = {
  media: guarded(MediaPanel),
  subtitles: guarded(SubtitlesPanel),
  preview: guarded(PreviewPanel),
  tools: guarded(ToolsPanel),
  properties: guarded(PropertiesPanel),
  metadata: guarded(MetadataPanel),
  audio: guarded(AudioPanel),
  timeline: guarded(TimelinePanel)
}

let api: DockviewApi | null = null
const listeners = new Set<() => void>()

function defaultLayout(a: DockviewApi): void {
  a.clear()
  a.addPanel({ id: 'preview', component: 'preview', title: title('preview') })
  a.addPanel({ id: 'media', component: 'media', title: title('media'), position: { referencePanel: 'preview', direction: 'left' }, initialWidth: 340 })
  a.addPanel({ id: 'subtitles', component: 'subtitles', title: title('subtitles'), position: { referencePanel: 'media', direction: 'within' }, inactive: true })
  a.addPanel({ id: 'tools', component: 'tools', title: title('tools'), position: { referencePanel: 'preview', direction: 'right' }, initialWidth: 360 })
  a.addPanel({ id: 'properties', component: 'properties', title: title('properties'), position: { referencePanel: 'tools', direction: 'within' }, inactive: true })
  a.addPanel({ id: 'metadata', component: 'metadata', title: title('metadata'), position: { referencePanel: 'tools', direction: 'within' }, inactive: true })
  a.addPanel({ id: 'audio', component: 'audio', title: title('audio'), position: { referencePanel: 'tools', direction: 'below' }, initialHeight: 230 })
  a.addPanel({ id: 'timeline', component: 'timeline', title: title('timeline'), position: { direction: 'below' }, initialHeight: 330 })
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
  api.addPanel({ id, component: id, title: title(def.id), floating: { width: 420, height: 360 } })
}

/** Brings a panel to the front, opening it if it was closed. */
export function showPanel(id: PanelId): void {
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) existing.api.setActive()
  else togglePanel(id)
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
  // Layouts saved before the Subtitles window existed: add it as a tab beside Media.
  else if (!api.getPanel('subtitles') && !get().settings.subtitlesPanelAdded) {
    const media = api.getPanel('media')
    api.addPanel({
      id: 'subtitles', component: 'subtitles', title: title('subtitles'), inactive: true,
      ...(media ? { position: { referencePanel: 'media', direction: 'within' as const } } : { floating: { width: 420, height: 520 } })
    })
  }
  if (!get().settings.subtitlesPanelAdded) patchSettings({ subtitlesPanelAdded: true })
  // Layouts saved before the Properties window existed: add it as a tab beside Tools (once, so closing it sticks).
  const added = get().settings.addedPanels ?? []
  if (restored && !added.includes('properties') && !api.getPanel('properties')) {
    const tools = api.getPanel('tools')
    api.addPanel({
      id: 'properties', component: 'properties', title: title('properties'), inactive: true,
      ...(tools ? { position: { referencePanel: 'tools', direction: 'within' as const } } : { floating: { width: 380, height: 520 } })
    })
  }
  if (!added.includes('properties')) patchSettings({ addedPanels: [...added, 'properties'] })
  // Saved layouts remember tab titles in the language they were saved in.
  retitle()
  let timer: ReturnType<typeof setTimeout> | null = null
  api.onDidLayoutChange(() => {
    for (const l of listeners) l()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => api && patchSettings({ layout: api.toJSON() }), 400)
  })
}

/** Puts every open window's tab title in the current language. */
function retitle(): void {
  for (const p of api?.panels ?? []) if (p.title !== title(p.id)) p.api.setTitle(title(p.id))
}
useStore.subscribe((s, prev) => s.lang !== prev.lang && retitle())

/**
 * dockview's own text (tab close buttons, screen-reader announcements). Each message is looked up when
 * dockview needs it, so it is always in the current language.
 */
const where = (position: string) => t(`dock.positions.${position}`)
const messages: DockviewMessages = {
  panelOpened: (title) => t('dock.panelOpened', { title }),
  panelClosed: (title) => t('dock.panelClosed', { title }),
  groupMaximized: (title) => t('dock.groupMaximized', { title }),
  groupRestored: (title) => t('dock.groupRestored', { title }),
  groupFloated: (title) => t('dock.groupFloated', { title }),
  groupDocked: (title) => t('dock.groupDocked', { title }),
  groupPoppedOut: (title) => t('dock.groupPoppedOut', { title }),
  closeTab: (title) => t('dock.closeTab', { title }),
  closeTabPlain: () => t('common.close'),
  movePickTarget: (source, target, current, total) => t('dock.movePickTarget', { source, target, current, total }),
  movePickEdge: (position, target) =>
    position === 'center' ? t('dock.movePickTab', { target }) : t('dock.movePickSplit', { target, position: where(position) }),
  moveCommitted: (source, target, position) =>
    position === 'center' ? t('dock.movedTab', { source, target }) : t('dock.movedSplit', { source, target, position: where(position) }),
  moveCancelled: () => t('dock.moveCancelled'),
  moveNotAllowed: () => t('dock.moveNotAllowed'),
  moveFloated: (source) => t('dock.groupFloated', { title: source })
}

export function Dock() {
  return <DockviewReact className="dock" theme={themeAbyss} components={components} onReady={onReady} messages={messages} />
}

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

// Interface language for the renderer. Components call useT() so they re-render when the language changes;
// code outside components (toasts, dialogs) calls t() directly and gets the current language.
import { Fragment, type ReactNode, createElement } from 'react'
import { type TOptions } from 'i18next'
import { resolveLanguage, setLanguage, t } from '@shared/i18n'
import { get, patchSettings, set, useStore } from './state/store'

export { t }

/** Returns t() and re-renders the calling component when the language changes. */
export function useT(): typeof t {
  useStore((s) => s.lang)
  return t
}

let systemLanguages: readonly string[] = []

/** Shows the language the settings ask for (or the system's), everywhere at once. */
export function applyLanguage(preference: string | undefined, system?: readonly string[]): void {
  if (system) systemLanguages = system
  const code = resolveLanguage(preference, systemLanguages)
  setLanguage(code)
  document.documentElement.lang = code
  set({ lang: code })
}

/** Switches language: saved in the settings (which also switches the main process). */
export function chooseLanguage(preference: string): void {
  patchSettings({ language: preference })
  applyLanguage(preference)
}

/** The language "System default" currently means. */
export const systemLanguage = (): string => resolveLanguage('system', systemLanguages)

export const languagePreference = (): string => get().settings.language ?? 'system'

/**
 * Like t(), with React elements in place of some placeholders:
 * tx('app.noFfmpeg', { cmd: <code>npm run fetch-ffmpeg</code> }) for "Run {{cmd}}, then restart."
 */
export function tx(key: string, nodes: Record<string, ReactNode>, options?: TOptions): ReactNode {
  const marks = Object.fromEntries(Object.keys(nodes).map((k) => [k, `\u0000${k}\u0000`]))
  const parts = t(key, { ...options, ...marks }).split('\u0000')
  return createElement(Fragment, null, ...parts.map((p, i) => (i % 2 ? createElement(Fragment, { key: i }, nodes[p]) : p)))
}

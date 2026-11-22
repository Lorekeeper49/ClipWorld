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

import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyLanguage } from './i18n'
import { player } from './engine/player'
import { showPanel } from './layout/dock'
import * as actions from './state/actions'
import * as presets from './state/presets'
import { edit, get, set } from './state/store'
import './styles.css'

// Handles for automated tests and for poking at the app from the developer tools.
;(window as unknown as Record<string, unknown>).__cw = { player, actions, presets, get, set, edit, showPanel }

// The system language until the settings arrive, so even the start-up screen is translated.
applyLanguage(undefined, navigator.languages)

createRoot(document.getElementById('root')!).render(<App />)

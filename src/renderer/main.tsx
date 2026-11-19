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

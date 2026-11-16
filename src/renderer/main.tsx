import { createRoot } from 'react-dom/client'
import { App } from './App'
import { player } from './engine/player'
import * as actions from './state/actions'
import { edit, get, set } from './state/store'
import './styles.css'

// Handles for automated tests and for poking at the app from the developer tools.
;(window as unknown as Record<string, unknown>).__cw = { player, actions, get, set, edit }

createRoot(document.getElementById('root')!).render(<App />)

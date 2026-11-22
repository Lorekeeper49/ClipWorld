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

// Keeps a crash inside one window or dialog from blanking the whole app: that part shows a short message
// (with the error, for reporting) and a way to try again, and everything else keeps working.
import { Component, type ReactNode } from 'react'
import { t } from '@shared/i18n'

interface Props {
  children: ReactNode
  /** Called by "Try again" (for a dialog: close it). Without it, the part is simply drawn again. */
  onReset?: () => void
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('A window crashed:', error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crashed" role="alert" data-testid="crashed">
        <p>{t('app.crashed')}</p>
        <pre className="error-text">{error.message}</pre>
        <button type="button" className="btn" onClick={() => { this.setState({ error: null }); this.props.onReset?.() }}>
          {t('app.tryAgain')}
        </button>
      </div>
    )
  }
}

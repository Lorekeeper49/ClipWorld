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

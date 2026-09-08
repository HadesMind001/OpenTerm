import React, { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: React.ComponentType<{ error: Error; resetErrorBoundary: () => void }>
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback
        return <FallbackComponent error={this.state.error!} resetErrorBoundary={this.resetErrorBoundary} />
      }
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: '#d7dde8',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          background: '#0a0c10',
          padding: '20px',
          textAlign: 'center'
        }}>
          <div>
            <h2 style={{ color: '#f87171', marginBottom: '16px' }}>Application Error</h2>
            <pre style={{
              color: '#8a94a6',
              marginBottom: '24px',
              textAlign: 'left',
              background: '#10141b',
              padding: '16px',
              borderRadius: '4px',
              overflow: 'auto',
              maxHeight: '300px'
            }}>
              {this.state.error?.toString()}
            </pre>
            <button
              onClick={this.resetErrorBoundary}
              style={{
                background: '#34d399',
                color: '#0a0c10',
                border: 'none',
                padding: '12px 24px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: '14px',
                fontWeight: 600
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
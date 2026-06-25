import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// ErrorPanel — inline error display (functional component)
// ---------------------------------------------------------------------------

export function ErrorPanel({
  error,
  onRetry,
}: {
  error: Error | string;
  onRetry?: () => void;
}) {
  const message = typeof error === 'string' ? error : error.message;

  return (
    <div
      className="rounded-lg p-6 flex flex-col items-center gap-3 text-center"
      style={{
        background: 'var(--red-dim)',
        border: '1px solid var(--red)',
        color: 'var(--text-primary)',
      }}
    >
      <AlertTriangle size={24} style={{ color: 'var(--red)' }} />
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium"
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--border-bright)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={12} />
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBoundary — React class component that catches render errors
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className="flex items-center justify-center"
          style={{
            minHeight: '100%',
            padding: 40,
            background: 'var(--bg-0)',
          }}
        >
          <div
            className="rounded-lg p-8 max-w-md w-full text-center"
            style={{
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
            }}
          >
            <AlertTriangle
              size={32}
              className="mx-auto mb-4"
              style={{ color: 'var(--red)' }}
            />
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary)' }}
            >
              Something went wrong
            </h2>
            <p
              className="text-sm mb-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              {this.state.error.message}
            </p>
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium focus-ring"
              style={{
                background: 'var(--blue)',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

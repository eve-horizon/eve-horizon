import { useCallback, useState } from 'react';
import { useEveAuth } from './hooks.js';

/**
 * Minimal login form with two modes:
 * - SSO: "Sign in with Eve" button (default)
 * - Token: paste an access token from `eve auth token`
 */
export function EveLoginForm() {
  const { loginWithSso, loginWithToken, error, config } = useEveAuth();
  const [mode, setMode] = useState<'sso' | 'token'>('sso');
  const [tokenInput, setTokenInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleTokenSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!tokenInput.trim()) return;
      setSubmitting(true);
      await loginWithToken(tokenInput.trim());
      setSubmitting(false);
    },
    [tokenInput, loginWithToken],
  );

  return (
    <div style={{ maxWidth: 360, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ textAlign: 'center', marginBottom: '1.5rem' }}>Sign in</h2>

      {/* Tab selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={() => setMode('sso')}
          style={{
            flex: 1,
            padding: '0.5rem',
            border: '1px solid #ccc',
            borderRadius: 4,
            background: mode === 'sso' ? '#0066cc' : '#fff',
            color: mode === 'sso' ? '#fff' : '#333',
            cursor: 'pointer',
          }}
        >
          SSO
        </button>
        <button
          type="button"
          onClick={() => setMode('token')}
          style={{
            flex: 1,
            padding: '0.5rem',
            border: '1px solid #ccc',
            borderRadius: 4,
            background: mode === 'token' ? '#0066cc' : '#fff',
            color: mode === 'token' ? '#fff' : '#333',
            cursor: 'pointer',
          }}
        >
          Token
        </button>
      </div>

      {/* Error display */}
      {error && (
        <div
          style={{
            padding: '0.5rem',
            marginBottom: '1rem',
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 4,
            color: '#c00',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {/* SSO mode */}
      {mode === 'sso' && (
        <button
          type="button"
          onClick={loginWithSso}
          disabled={!config?.sso_url}
          style={{
            width: '100%',
            padding: '0.75rem',
            background: config?.sso_url ? '#0066cc' : '#ccc',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            fontSize: '1rem',
            cursor: config?.sso_url ? 'pointer' : 'default',
          }}
        >
          Sign in with Eve
        </button>
      )}

      {/* Token mode */}
      {mode === 'token' && (
        <form onSubmit={handleTokenSubmit}>
          <textarea
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Paste your Eve access token..."
            rows={4}
            style={{
              width: '100%',
              padding: '0.5rem',
              border: '1px solid #ccc',
              borderRadius: 4,
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <button
            type="submit"
            disabled={submitting || !tokenInput.trim()}
            style={{
              width: '100%',
              marginTop: '0.5rem',
              padding: '0.75rem',
              background: submitting || !tokenInput.trim() ? '#ccc' : '#0066cc',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              fontSize: '1rem',
              cursor: submitting || !tokenInput.trim() ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'Verifying...' : 'Sign in with token'}
          </button>
        </form>
      )}

      <p style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.75rem', color: '#888' }}>
        Get a token with: <code>eve auth token</code>
      </p>
    </div>
  );
}

import type { ReactNode } from 'react';
import { useEveAuth } from './hooks.js';
import { EveLoginForm } from './login-form.js';

export interface EveLoginGateProps {
  children: ReactNode;
  /** Custom login component. Defaults to EveLoginForm. */
  fallback?: ReactNode;
  /** Custom loading component. Defaults to null (render nothing). */
  loadingFallback?: ReactNode;
}

/**
 * Renders children when authenticated, login form when not.
 */
export function EveLoginGate({
  children,
  fallback,
  loadingFallback = null,
}: EveLoginGateProps) {
  const { user, loading } = useEveAuth();

  if (loading) return <>{loadingFallback}</>;
  if (!user) return <>{fallback ?? <EveLoginForm />}</>;
  return <>{children}</>;
}

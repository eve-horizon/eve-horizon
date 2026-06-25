import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { EveAuthContext, type EveAuthContextValue } from './provider.js';
import { getStoredToken } from './client.js';
import type { EveAppAccess, EveAppInviteResult } from './types.js';

/**
 * Access the Eve auth context.
 * Must be used within an EveAuthProvider.
 */
export function useEveAuth(): EveAuthContextValue {
  const ctx = useContext(EveAuthContext);
  if (!ctx) {
    throw new Error('useEveAuth must be used within an EveAuthProvider');
  }
  return ctx;
}

export function useEveAppAccess(projectId?: string): {
  access: EveAppAccess | null;
  orgs: EveAppAccess['orgs'];
  adminOrgs: EveAppAccess['admin_orgs'];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  inviteMember: (input: { orgId: string; email: string; redirectTo?: string; resend?: boolean }) => Promise<EveAppInviteResult>;
} {
  const { config, user } = useEveAuth();
  const [access, setAccess] = useState<EveAppAccess | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eveApiBase = useMemo(
    () => (config?.eve_public_api_url ?? config?.eve_api_url ?? '').replace(/\/$/, ''),
    [config],
  );
  const resolvedProjectId = projectId ?? config?.eve_project_id ?? undefined;

  const refresh = useCallback(async () => {
    if (!eveApiBase || !resolvedProjectId || !user) {
      setAccess(null);
      return;
    }

    const token = getStoredToken();
    if (!token) {
      setAccess(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${eveApiBase}/auth/app-access?project_id=${encodeURIComponent(resolvedProjectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`App access lookup failed (${res.status})`);
      }
      setAccess((await res.json()) as EveAppAccess);
    } catch (err) {
      setAccess(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [eveApiBase, resolvedProjectId, user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inviteMember = useCallback(async (input: {
    orgId: string;
    email: string;
    redirectTo?: string;
    resend?: boolean;
  }): Promise<EveAppInviteResult> => {
    if (!eveApiBase || !resolvedProjectId) {
      throw new Error('Eve app access is not configured');
    }
    const token = getStoredToken();
    if (!token) {
      throw new Error('Authentication required');
    }

    const res = await fetch(`${eveApiBase}/auth/app-invites`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project_id: resolvedProjectId,
        org_id: input.orgId,
        email: input.email,
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
        ...(input.resend ? { resend: true } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Invite failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as EveAppInviteResult;
    await refresh();
    return result;
  }, [eveApiBase, refresh, resolvedProjectId]);

  return {
    access,
    orgs: access?.orgs ?? [],
    adminOrgs: access?.admin_orgs ?? [],
    loading,
    error,
    refresh,
    inviteMember,
  };
}

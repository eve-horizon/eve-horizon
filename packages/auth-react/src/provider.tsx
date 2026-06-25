import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthConfig, EveAuthOrg, EveAuthState, EveUser } from './types.js';
import {
  clearToken,
  decodeTokenPayload,
  getStoredToken,
  isTokenExpired,
  storeToken,
} from './client.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface EveAuthContextValue extends EveAuthState {
  /** All org memberships for the authenticated user */
  orgs: EveAuthOrg[];
  /** Currently active org (null if not authenticated) */
  activeOrg: EveAuthOrg | null;
  loginWithSso: () => void;
  loginWithToken: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Switch active org context. Only valid orgs from user memberships are accepted. */
  switchOrg: (orgId: string) => void;
}

export const EveAuthContext = createContext<EveAuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface EveAuthProviderProps {
  apiUrl?: string;
  /** When set, sends X-Eve-Project-Id header with /auth/me to resolve project role */
  projectId?: string;
  children: ReactNode;
}

export function EveAuthProvider({ apiUrl = '/api', projectId, children }: EveAuthProviderProps) {
  const base = apiUrl.replace(/\/$/, '');
  const [user, setUser] = useState<EveUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => {
    try {
      if (typeof window !== 'undefined') {
        const queryOrgId = new URLSearchParams(window.location.search).get('eve_org_id');
        if (queryOrgId) return queryOrgId;
      }
      return localStorage.getItem('eve_active_org_id');
    } catch {
      return null;
    }
  });

  // Fetch auth config from backend
  const fetchConfig = useCallback(async (): Promise<AuthConfig | null> => {
    try {
      const res = await fetch(`${base}/auth/config`);
      if (!res.ok) return null;
      const data = (await res.json()) as AuthConfig;
      setConfig(data);
      return data;
    } catch {
      return null;
    }
  }, [base]);

  // Validate token via /auth/me
  const validateToken = useCallback(
    async (token: string): Promise<EveUser | null> => {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (projectId) headers['X-Eve-Project-Id'] = projectId;
        const res = await fetch(`${base}/auth/me`, { headers });
        if (!res.ok) return null;
        const data = (await res.json()) as Record<string, unknown>;

        // Extract org memberships — handle both snake_case (Eve API)
        // and camelCase (naive req.eveUser proxy) formats
        const memberships = data.memberships as
          | Array<{ org_id: string; role: string; org_name?: string; org_slug?: string }>
          | undefined;
        const organizations: EveAuthOrg[] | undefined = memberships?.map(
          (m) => ({
            id: m.org_id,
            role: m.role as 'owner' | 'admin' | 'member',
            ...(m.org_name ? { name: m.org_name } : {}),
            ...(m.org_slug ? { slug: m.org_slug } : {}),
          }),
        );

        // Handle both snake_case (user_id, org_id) and camelCase (id, orgId)
        const userId = (data.user_id ?? data.id) as string;
        const orgId =
          ((data.org_id ?? data.orgId) as string) ?? organizations?.[0]?.id ?? '';
        const role = ((data.role as string) ??
          organizations?.[0]?.role ??
          'member') as 'owner' | 'admin' | 'member';

        // Platform admin flag
        const isAdmin = Boolean(data.is_admin);

        // Project role from Eve API (present when X-Eve-Project-Id header was sent)
        const projectRole = (data.project_role ?? data.projectRole) as
          | 'owner' | 'admin' | 'member' | null
          | undefined;

        return {
          id: userId,
          email: data.email as string,
          orgId,
          role,
          isAdmin,
          organizations,
          ...(projectRole !== undefined ? { projectRole } : {}),
        };
      } catch {
        return null;
      }
    },
    [base, projectId],
  );

  // Try SSO session probe
  const probeSsoSession = useCallback(
    async (ssoUrl: string, eveProjectId?: string): Promise<string | null> => {
      try {
        const sessionUrl = eveProjectId
          ? `${ssoUrl}/session?project_id=${encodeURIComponent(eveProjectId)}`
          : `${ssoUrl}/session`;
        const res = await fetch(sessionUrl, { credentials: 'include' });
        if (!res.ok) return null;
        const data = (await res.json()) as { access_token?: string };
        return data.access_token ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  // Bootstrap: try cached token, then SSO session
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      // 1. Check cached token
      const cached = getStoredToken();
      if (cached && !isTokenExpired(cached)) {
        const me = await validateToken(cached);
        // A cancelled bootstrap (e.g. StrictMode remount) must never clear a
        // token another bootstrap may have just validated successfully.
        if (cancelled) return;
        if (me) {
          setUser(me);
          setLoading(false);
          return;
        }
      }
      if (cancelled) return;
      if (cached) clearToken();

      // 2. Fetch config + probe SSO
      const cfg = await fetchConfig();
      if (cfg?.sso_url) {
        const ssoToken = await probeSsoSession(cfg.sso_url, cfg.eve_project_id ?? undefined);
        if (cancelled) return;
        if (ssoToken) {
          storeToken(ssoToken);
          const me = await validateToken(ssoToken);
          if (cancelled) return;
          if (me) {
            setUser(me);
            setLoading(false);
            return;
          }
          clearToken();
        }
      }

      // 3. Unauthenticated
      if (!cancelled) {
        setLoading(false);
      }
    }

    bootstrap().catch((e) => {
      if (!cancelled) {
        setError(String(e));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fetchConfig, validateToken, probeSsoSession]);

  // Login with SSO (redirect)
  const loginWithSso = useCallback(() => {
    const ssoUrl = config?.sso_url;
    if (!ssoUrl) {
      setError('SSO URL not configured');
      return;
    }
    const returnUrl = window.location.href;
    const params = new URLSearchParams({ redirect_to: returnUrl });
    if (config?.eve_project_id) {
      params.set('project_id', config.eve_project_id);
    }
    window.location.href = `${ssoUrl}/login?${params.toString()}`;
  }, [config]);

  // Login with token (paste mode)
  const loginWithToken = useCallback(
    async (token: string) => {
      setError(null);
      const payload = decodeTokenPayload(token);
      if (!payload) {
        setError('Invalid token format');
        return;
      }
      if (isTokenExpired(token)) {
        setError('Token has expired');
        return;
      }
      storeToken(token);
      const me = await validateToken(token);
      if (me) {
        setUser(me);
      } else {
        clearToken();
        setError('Token validation failed');
      }
    },
    [validateToken],
  );

  // Logout
  const logout = useCallback(async () => {
    clearToken();
    setUser(null);
    setError(null);
    setActiveOrgId(null);
    try {
      localStorage.removeItem('eve_active_org_id');
    } catch {
      // localStorage may not be available
    }
    if (config?.sso_url) {
      try {
        const logoutUrl = config.eve_project_id
          ? `${config.sso_url}/logout?project_id=${encodeURIComponent(config.eve_project_id)}`
          : `${config.sso_url}/logout`;
        await fetch(logoutUrl, {
          method: 'POST',
          credentials: 'include',
        });
      } catch {
        // Best-effort SSO logout
      }
    }
  }, [config]);

  // Derived org state
  const orgs = useMemo<EveAuthOrg[]>(
    () => user?.organizations ?? [],
    [user],
  );

  const activeOrg = useMemo<EveAuthOrg | null>(() => {
    if (!user?.organizations?.length) return null;
    if (activeOrgId) {
      const found = user.organizations.find((o) => o.id === activeOrgId);
      if (found) return found;
    }
    // Default to config org, then first membership
    const configOrg = config?.eve_org_id;
    if (configOrg) {
      const found = user.organizations.find((o) => o.id === configOrg);
      if (found) return found;
    }
    return user.organizations[0] ?? null;
  }, [user, activeOrgId, config]);

  useEffect(() => {
    if (!activeOrgId || !user?.organizations?.some((o) => o.id === activeOrgId)) {
      return;
    }
    try {
      localStorage.setItem('eve_active_org_id', activeOrgId);
    } catch {
      // localStorage may not be available
    }
  }, [activeOrgId, user]);

  const switchOrg = useCallback(
    (orgId: string) => {
      if (!user?.organizations?.some((o) => o.id === orgId)) return;
      setActiveOrgId(orgId);
      try {
        localStorage.setItem('eve_active_org_id', orgId);
      } catch {
        // localStorage may not be available
      }
    },
    [user],
  );

  const value = useMemo<EveAuthContextValue>(
    () => ({
      user,
      loading,
      error,
      config,
      orgs,
      activeOrg,
      loginWithSso,
      loginWithToken,
      logout,
      switchOrg,
    }),
    [user, loading, error, config, orgs, activeOrg, loginWithSso, loginWithToken, logout, switchOrg],
  );

  return <EveAuthContext.Provider value={value}>{children}</EveAuthContext.Provider>;
}

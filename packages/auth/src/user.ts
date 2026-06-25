/**
 * User auth middleware for Eve-compatible Express apps.
 *
 * Usage:
 *   import { eveUserAuth, eveAuthGuard, eveAuthConfig } from '@eve-horizon/auth';
 *   app.use(eveUserAuth());
 *   app.get('/auth/config', eveAuthConfig());
 *   app.get('/protected', eveAuthGuard(), handler);
 */

import { verifyEveToken, verifyEveTokenRemote, type EveTokenClaims } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EveUser {
  id: string;
  email: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  /** Project-level role when project context is available */
  projectRole?: 'owner' | 'admin' | 'member' | null;
}

export interface EveAppAccessOrg {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  capabilities: {
    enter_app: boolean;
    invite_members: boolean;
  };
}

export interface EveAppAccess {
  project_id: string;
  orgs: EveAppAccessOrg[];
  admin_orgs: Array<Omit<EveAppAccessOrg, 'capabilities'>>;
}

export interface EveUserRequest {
  eveUser?: EveUser;
}

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
} & EveUserRequest;

type ResponseLike = {
  status(code: number): ResponseLike;
  json(body: unknown): void;
};

type NextFn = () => void;

// ---------------------------------------------------------------------------
// User auth middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware: verifies Eve RS256 token, checks org membership,
 * attaches req.eveUser. Non-blocking — unauthenticated requests pass through
 * with req.eveUser undefined (use eveAuthGuard() to enforce auth).
 */
export function eveUserAuth(options?: {
  orgId?: string;
  eveApiUrl?: string;
  strategy?: 'local' | 'remote';
}) {
  const strategy = options?.strategy ?? 'local';
  const verify = strategy === 'local' ? verifyEveToken : verifyEveTokenRemote;

  return async (req: RequestLike, _res: ResponseLike, next: NextFn) => {
    const token = extractToken(req);
    if (!token) {
      next();
      return;
    }

    let claims: EveTokenClaims;
    try {
      claims = await verify(token, options?.eveApiUrl);
    } catch {
      // Invalid token — pass through without setting eveUser
      next();
      return;
    }

    if (claims.type !== 'user') {
      next();
      return;
    }

    const targetOrgId = options?.orgId ?? process.env.EVE_ORG_ID;
    if (!targetOrgId || !claims.orgs) {
      next();
      return;
    }

    const membership = claims.orgs.find((o) => o.id === targetOrgId);
    if (!membership) {
      next();
      return;
    }

    req.eveUser = {
      id: claims.user_id,
      email: claims.email ?? '',
      orgId: targetOrgId,
      role: membership.role as EveUser['role'],
    };

    next();
  };
}

/**
 * Express middleware for apps that opt into Eve app-org access policies.
 *
 * Verifies the user token, asks Eve API which orgs this user can enter for
 * the project, and attaches req.eveUser for the selected allowed org. The
 * selected org comes from X-Eve-Org-Id, eve_org_id query, or the first allowed
 * org returned by Eve.
 */
export function eveAppUserAuth(options?: {
  projectId?: string;
  eveApiUrl?: string;
  strategy?: 'local' | 'remote';
  orgHeader?: string;
}) {
  const strategy = options?.strategy ?? 'local';
  const verify = strategy === 'local' ? verifyEveToken : verifyEveTokenRemote;
  const orgHeader = (options?.orgHeader ?? 'x-eve-org-id').toLowerCase();

  return async (req: RequestLike, _res: ResponseLike, next: NextFn) => {
    const token = extractToken(req);
    const projectId = options?.projectId ?? process.env.EVE_PROJECT_ID;
    const eveApiUrl = options?.eveApiUrl ?? process.env.EVE_API_URL;
    if (!token || !projectId || !eveApiUrl) {
      next();
      return;
    }

    let claims: EveTokenClaims;
    try {
      claims = await verify(token, eveApiUrl);
    } catch {
      next();
      return;
    }

    if (claims.type !== 'user') {
      next();
      return;
    }

    let access: EveAppAccess;
    try {
      access = await fetchAppAccess(eveApiUrl, token, projectId);
    } catch {
      next();
      return;
    }

    const requestedOrgId =
      extractHeader(req, orgHeader)
      ?? extractQueryValue(req, 'eve_org_id')
      ?? claims.org_id
      ?? undefined;
    const selectedOrg = requestedOrgId
      ? access.orgs.find((org) => org.id === requestedOrgId)
      : access.orgs[0];
    if (!selectedOrg) {
      next();
      return;
    }

    req.eveUser = {
      id: claims.user_id,
      email: claims.email ?? '',
      orgId: selectedOrg.id,
      role: selectedOrg.role,
    };

    next();
  };
}

// ---------------------------------------------------------------------------
// /auth/me handler — returns full user claims for React SDK
// ---------------------------------------------------------------------------

/**
 * Express handler for /auth/me endpoint.
 * Reads JWT claims directly (not req.eveUser) so the response includes all
 * org memberships — matching the format the React SDK expects.
 *
 * When `projectHeader` is set, reads the project ID from that request header
 * and proxies to the Eve API to resolve the user's project-level role.
 */
export function eveAuthMe(options?: {
  orgId?: string;
  eveApiUrl?: string;
  strategy?: 'local' | 'remote';
  /** Request header name containing the project ID (e.g. 'x-eve-project-id') */
  projectHeader?: string;
}) {
  const strategy = options?.strategy ?? 'local';
  const verify = strategy === 'local' ? verifyEveToken : verifyEveTokenRemote;
  const eveApiUrl = options?.eveApiUrl ?? process.env.EVE_API_URL;

  return async (req: RequestLike, res: ResponseLike) => {
    const token = extractToken(req);
    if (!token) {
      res.status(200).json({ authenticated: false });
      return;
    }

    // If project context is requested and we have an Eve API URL,
    // proxy to the Eve API /auth/me to get project_role resolved server-side
    const projectHeaderName = options?.projectHeader;
    const projectId = projectHeaderName
      ? extractHeader(req, projectHeaderName)
      : undefined;

    if (projectId && eveApiUrl) {
      try {
        const apiRes = await fetch(`${eveApiUrl.replace(/\/$/, '')}/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Eve-Project-Id': projectId,
          },
        });
        if (apiRes.ok) {
          const data = await apiRes.json();
          res.status(200).json(data);
          return;
        }
      } catch {
        // Fall through to local resolution
      }
    }

    let claims: EveTokenClaims;
    try {
      claims = await verify(token, options?.eveApiUrl);
    } catch {
      res.status(200).json({ authenticated: false });
      return;
    }

    if (claims.type !== 'user') {
      res.status(200).json({ authenticated: false });
      return;
    }

    // Build memberships from JWT orgs claim
    const memberships = claims.orgs?.map((o) => ({
      org_id: o.id,
      role: o.role,
    }));

    // Resolve org_id: prefer configured org, fall back to first membership
    const targetOrgId = options?.orgId ?? process.env.EVE_ORG_ID;
    const orgId = targetOrgId
      ?? claims.org_id
      ?? memberships?.[0]?.org_id
      ?? null;

    // Resolve role from matching membership
    const matchedMembership = orgId
      ? memberships?.find((m) => m.org_id === orgId)
      : undefined;

    res.status(200).json({
      authenticated: true,
      user_id: claims.user_id,
      email: claims.email ?? '',
      org_id: orgId,
      role: matchedMembership?.role ?? claims.role ?? 'member',
      memberships,
    });
  };
}

// ---------------------------------------------------------------------------
// Auth guard middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware: returns 401 if req.eveUser is not set.
 * Use after eveUserAuth() on protected routes.
 */
export function eveAuthGuard() {
  return (req: EveUserRequest, res: ResponseLike, next: NextFn) => {
    if (!req.eveUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Auth config handler
// ---------------------------------------------------------------------------

/**
 * Express handler for /auth/config endpoint.
 * Returns platform auth URLs from auto-injected env vars.
 */
export function eveAuthConfig() {
  return (_req: unknown, res: ResponseLike) => {
    res.status(200).json({
      sso_url: process.env.EVE_SSO_URL ?? null,
      eve_api_url: process.env.EVE_API_URL ?? null,
      eve_public_api_url: process.env.EVE_PUBLIC_API_URL ?? null,
      eve_org_id: process.env.EVE_ORG_ID ?? null,
      eve_project_id: process.env.EVE_PROJECT_ID ?? null,
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHeader(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

function extractQueryValue(req: RequestLike, name: string): string | undefined {
  const value = req.query?.[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

async function fetchAppAccess(
  eveApiUrl: string,
  token: string,
  projectId: string,
): Promise<EveAppAccess> {
  const url = `${eveApiUrl.replace(/\/$/, '')}/auth/app-access?project_id=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`App access lookup failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<EveAppAccess>;
}

function extractToken(req: RequestLike): string | undefined {
  // 1. Authorization header (preferred)
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Query param (for SSE connections)
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string') {
    return queryToken;
  }

  return undefined;
}

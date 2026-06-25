/**
 * Unified auth middleware for Eve-compatible apps serving both users and agents.
 *
 * Usage:
 *   import { eveAuth, eveIdentityGuard } from '@eve-horizon/auth';
 *   app.use(eveAuth());
 *   app.get('/protected', eveIdentityGuard(), handler);
 *
 * req.eveIdentity is set for both user and agent tokens with a normalized shape.
 */

import { verifyEveToken, verifyEveTokenRemote, type EveTokenClaims } from './index.js';
import type { EveAppAccess } from './user.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EveIdentity {
  /** User ID (for users) or actor user ID (for agents) */
  id: string;
  /** Email — real for users, {agent_slug}@eve.agent for agents */
  email: string;
  /** Organization this request is scoped to */
  orgId: string;
  /** Role within the organization */
  role: 'owner' | 'admin' | 'member';
  /** True when the request comes from an agent job token */
  isAgent: boolean;
  /** Agent slug — only set for agent requests */
  agentSlug?: string;
  /** Job ID — only set for agent requests */
  jobId?: string;
  /** Project ID — only set for agent requests */
  projectId?: string;
  /** Permissions array — only set for agent requests */
  permissions?: string[];
}

export interface EveIdentityRequest {
  eveIdentity?: EveIdentity;
}

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
} & EveIdentityRequest;

type ResponseLike = {
  status(code: number): ResponseLike;
  json(body: unknown): void;
};

type NextFn = () => void;

// ---------------------------------------------------------------------------
// Unified auth middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware: verifies any Eve token (user or job), normalizes identity
 * into `req.eveIdentity`. Non-blocking — unauthenticated requests pass through
 * with `req.eveIdentity` undefined (use `eveIdentityGuard()` to enforce).
 */
export function eveAuth(options?: {
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
      next();
      return;
    }

    const targetOrgId = options?.orgId ?? process.env.EVE_ORG_ID;

    if (claims.type === 'user') {
      if (!targetOrgId || !claims.orgs) {
        next();
        return;
      }
      const membership = claims.orgs.find((o) => o.id === targetOrgId);
      if (!membership) {
        next();
        return;
      }

      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? '',
        orgId: targetOrgId,
        role: membership.role as EveIdentity['role'],
        isAgent: false,
      };
    } else if (claims.type === 'job') {
      const orgId = claims.org_id ?? targetOrgId;
      if (!orgId) {
        next();
        return;
      }

      const agentSlug = claims.agent_slug;
      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? (agentSlug ? `${agentSlug}@eve.agent` : `${claims.job_id}@eve.agent`),
        orgId,
        role: 'member',
        isAgent: true,
        ...(agentSlug ? { agentSlug } : {}),
        ...(claims.job_id ? { jobId: claims.job_id } : {}),
        ...(claims.project_id ? { projectId: claims.project_id } : {}),
        ...(claims.permissions ? { permissions: claims.permissions } : {}),
      };
    }

    next();
  };
}

/**
 * Unified middleware for app-org policies. User tokens are scoped through Eve's
 * app-access endpoint; job tokens keep their token org/project context.
 */
export function eveAppAuth(options?: {
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
    if (!token) {
      next();
      return;
    }

    let claims: EveTokenClaims;
    try {
      claims = await verify(token, options?.eveApiUrl);
    } catch {
      next();
      return;
    }

    if (claims.type === 'user') {
      const projectId = options?.projectId ?? process.env.EVE_PROJECT_ID;
      const eveApiUrl = options?.eveApiUrl ?? process.env.EVE_API_URL;
      if (!projectId || !eveApiUrl) {
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

      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? '',
        orgId: selectedOrg.id,
        role: selectedOrg.role,
        isAgent: false,
      };
    } else if (claims.type === 'job') {
      const orgId = claims.org_id ?? process.env.EVE_ORG_ID;
      if (!orgId) {
        next();
        return;
      }

      const agentSlug = claims.agent_slug;
      req.eveIdentity = {
        id: claims.user_id,
        email: claims.email ?? (agentSlug ? `${agentSlug}@eve.agent` : `${claims.job_id}@eve.agent`),
        orgId,
        role: 'member',
        isAgent: true,
        ...(agentSlug ? { agentSlug } : {}),
        ...(claims.job_id ? { jobId: claims.job_id } : {}),
        ...(claims.project_id ? { projectId: claims.project_id } : {}),
        ...(claims.permissions ? { permissions: claims.permissions } : {}),
      };
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Identity guard middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware: returns 401 if `req.eveIdentity` is not set.
 * Use after `eveAuth()` on protected routes.
 */
export function eveIdentityGuard() {
  return (req: EveIdentityRequest, res: ResponseLike, next: NextFn) => {
    if (!req.eveIdentity) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(req: RequestLike): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const queryToken = req.query?.token;
  if (typeof queryToken === 'string') {
    return queryToken;
  }

  return undefined;
}

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

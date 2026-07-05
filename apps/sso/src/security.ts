import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { EVE_DEFAULT_DOMAIN, EVE_INTERNAL_API_KEY, SIGNUP_ALLOWED_DOMAINS } from './config.js';
import { fetchAppContext } from './gotrue-client.js';

// Wrap tokens have the typeid('mlw') shape: lowercase prefix + 26-char base32.
// Validating against this regex before hitting the API gives scanners crafting
// malformed paths a quick 404 and avoids logging arbitrary user input.
const WRAP_TOKEN_REGEX = /^mlw_[0-9a-z]{26}$/;

const LOCAL_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function isLocalHttpOrigin(parsed: URL): boolean {
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HTTP_HOSTNAMES.has(host)) return true;
  if (host === 'lvh.me' || host.endsWith('.lvh.me')) return true;
  return false;
}

export function isClusterDomainHost(host: string): boolean {
  return host === EVE_DEFAULT_DOMAIN || host.endsWith(`.${EVE_DEFAULT_DOMAIN}`);
}

export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Validate a post-auth `redirect_to` URL. Accepts:
 *   - Any URL whose hostname is the cluster domain or a subdomain of it.
 *   - Any URL whose origin matches a project-declared allowed origin.
 * Project-declared origins must be HTTPS (or local-only HTTP for dev).
 */
export function isAllowedRedirect(
  url: string,
  context: { allowedOrigins?: string[] } = {},
): boolean {
  try {
    const parsed = new URL(url);
    if (isClusterDomainHost(parsed.hostname)) {
      return true;
    }
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) {
      return false;
    }
    const allowed = (context.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin));
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Validate a CORS request `Origin` against cluster + project-declared origins. */
export function isAllowedOrigin(
  origin: string,
  context: { allowedOrigins?: string[] } = {},
): boolean {
  try {
    const parsed = new URL(origin);
    if (isClusterDomainHost(parsed.hostname)) {
      return true;
    }
    if (parsed.protocol !== 'https:' && !isLocalHttpOrigin(parsed)) {
      return false;
    }
    const allowed = (context.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((o): o is string => Boolean(o));
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Check whether an email is allowed for self-signup. Returns true when unrestricted. */
export function isSignupEmailAllowed(email: string): boolean {
  if (SIGNUP_ALLOWED_DOMAINS.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && SIGNUP_ALLOWED_DOMAINS.includes(domain);
}

export function signWrapCsrf(wrapToken: string): string {
  // Stateless CSRF: HMAC-SHA256 of the wrap_token using the internal API key.
  // Stored in a hidden form field. Defends against accidental cross-origin
  // form submissions; the wrap_token itself remains the bearer credential.
  return createHmac('sha256', EVE_INTERNAL_API_KEY || 'unconfigured').update(wrapToken).digest('hex');
}

export function verifyWrapCsrf(wrapToken: string, nonce: string): boolean {
  if (!nonce || nonce.length !== 64) return false;
  const expected = signWrapCsrf(wrapToken);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(nonce, 'hex'));
  } catch {
    return false;
  }
}

export function isValidWrapToken(token: string): boolean {
  return WRAP_TOKEN_REGEX.test(token);
}

export async function applyCorsHeaders(req: express.Request, res: express.Response): Promise<boolean> {
  const origin = req.headers.origin;
  // Same-origin requests may omit the Origin header. In that case, CORS is not
  // relevant and we should allow the request to proceed.
  if (!origin) return true;

  // Cluster-domain origins are always allowed (no project context needed).
  let parsed: URL | null = null;
  try {
    parsed = new URL(origin);
  } catch {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  if (isClusterDomainHost(parsed.hostname)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return true;
  }

  // Non-cluster origins must declare their project context so the SSO can
  // consult the project-scoped allowlist. Without a project, we cannot trust
  // any external origin.
  const projectId = (req.query.project_id as string) || '';
  if (!projectId) {
    res.status(403).json({ error: 'Origin not allowed (project_id required for cross-domain requests)' });
    return false;
  }

  const context = await fetchAppContext(projectId);
  const allowedOrigins = context?.auth?.allowed_redirect_origins ?? [];
  if (!isAllowedOrigin(origin, { allowedOrigins })) {
    console.warn(
      `[cors] Rejected origin=${origin} (project_id=${projectId}, allowed=${allowedOrigins.join(',') || 'none'})`,
    );
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  return true;
}

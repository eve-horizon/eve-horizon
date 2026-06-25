/**
 * @eve-horizon/auth — Unified auth SDK for Eve-compatible apps.
 *
 * Supports agent job tokens (JWKS verification) and user session tokens.
 *
 * Verification strategies:
 * 1. verifyEveTokenRemote() — calls Eve API /auth/token/verify (simplest)
 * 2. verifyEveToken()       — JWKS-based local verification (faster, no network per-request)
 */

import { createVerify } from 'node:crypto';

// Re-export user auth middleware
export { eveUserAuth, eveAppUserAuth, eveAuthGuard, eveAuthConfig, eveAuthMe } from './user.js';
export type { EveUser, EveUserRequest, EveAppAccess, EveAppAccessOrg } from './user.js';

// Re-export unified auth middleware (handles both user and agent tokens)
export { eveAuth, eveAppAuth, eveIdentityGuard } from './unified.js';
export type { EveIdentity, EveIdentityRequest } from './unified.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EveTokenClaims {
  valid: true;
  type: 'user' | 'job' | 'service_principal';
  user_id: string;
  email?: string;
  org_id?: string | null;
  orgs?: Array<{ id: string; role: string }>;
  project_id?: string;
  job_id?: string;
  agent_slug?: string;
  permissions?: string[];
  is_admin?: boolean;
  role?: string;
}

export interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

// ---------------------------------------------------------------------------
// Remote verification (simplest — one HTTP call per token)
// ---------------------------------------------------------------------------

/**
 * Verify an Eve token by calling the Eve API's /auth/token/verify endpoint.
 * Simplest approach — no key management needed.
 */
export async function verifyEveTokenRemote(
  token: string,
  eveApiUrl?: string,
): Promise<EveTokenClaims> {
  const baseUrl = eveApiUrl ?? process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required (pass eveApiUrl or set EVE_API_URL env)');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/auth/token/verify`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Token verification failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<EveTokenClaims>;
}

// ---------------------------------------------------------------------------
// Local JWKS verification (faster — caches public keys)
// ---------------------------------------------------------------------------

let cachedJwks: { keys: JwksKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function fetchJwks(eveApiUrl: string): Promise<JwksKey[]> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks.keys;
  }

  const url = `${eveApiUrl.replace(/\/$/, '')}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${res.status}`);
  }

  const data = (await res.json()) as JwksResponse;
  cachedJwks = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function jwkToPem(key: JwksKey): string {
  const n = base64UrlDecode(key.n);
  const e = base64UrlDecode(key.e);

  // DER encode RSA public key
  const nBytes = n[0]! >= 0x80 ? Buffer.concat([Buffer.from([0x00]), n]) : n;
  const eBytes = e[0]! >= 0x80 ? Buffer.concat([Buffer.from([0x00]), e]) : e;

  function derLength(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    if (len < 0x100) return Buffer.from([0x81, len]);
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  function derSequence(...items: Buffer[]): Buffer {
    const content = Buffer.concat(items);
    return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
  }

  function derInteger(data: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0x02]), derLength(data.length), data]);
  }

  function derBitString(data: Buffer): Buffer {
    const withPad = Buffer.concat([Buffer.from([0x00]), data]);
    return Buffer.concat([Buffer.from([0x03]), derLength(withPad.length), withPad]);
  }

  // RSA OID: 1.2.840.113549.1.1.1
  const rsaOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  const rsaKey = derSequence(derInteger(nBytes), derInteger(eBytes));
  const publicKeyInfo = derSequence(rsaOid, derBitString(rsaKey));

  const pem =
    '-----BEGIN PUBLIC KEY-----\n' +
    publicKeyInfo.toString('base64').replace(/(.{64})/g, '$1\n') +
    '\n-----END PUBLIC KEY-----';

  return pem;
}

/**
 * Verify an Eve token locally using JWKS (fetched and cached from Eve API).
 * Faster than remote verification for high-throughput scenarios.
 */
export async function verifyEveToken(
  token: string,
  eveApiUrl?: string,
): Promise<EveTokenClaims> {
  const baseUrl = eveApiUrl ?? process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required (pass eveApiUrl or set EVE_API_URL env)');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(headerB64).toString()) as {
    alg: string;
    kid?: string;
  };

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  const keys = await fetchJwks(baseUrl);
  const key = header.kid
    ? keys.find((k) => k.kid === header.kid)
    : keys[0];

  if (!key) {
    throw new Error('No matching key found in JWKS');
  }

  const pem = jwkToPem(key);
  const verify = createVerify('RSA-SHA256');
  verify.update(`${headerB64}.${payloadB64}`);

  if (!verify.verify(pem, base64UrlDecode(signatureB64))) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString()) as {
    sub?: string;
    user_id?: string;
    type?: string;
    org_id?: string | null;
    orgs?: Array<{ id: string; role: string }>;
    project_id?: string;
    job_id?: string;
    agent_slug?: string;
    permissions?: string[];
    is_admin?: boolean;
    email?: string;
    role?: string;
    exp?: number;
    nbf?: number;
  };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('Token has expired');
  }
  if (payload.nbf && payload.nbf > now + 60) {
    throw new Error('Token not yet valid');
  }

  return {
    valid: true,
    type: (payload.type as EveTokenClaims['type']) ?? 'user',
    user_id: payload.user_id ?? payload.sub ?? '',
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.org_id !== undefined ? { org_id: payload.org_id } : {}),
    ...(payload.orgs ? { orgs: payload.orgs } : {}),
    ...(payload.project_id ? { project_id: payload.project_id } : {}),
    ...(payload.job_id ? { job_id: payload.job_id } : {}),
    ...(payload.agent_slug ? { agent_slug: payload.agent_slug } : {}),
    ...(payload.permissions ? { permissions: payload.permissions } : {}),
    ...(payload.is_admin !== undefined ? { is_admin: payload.is_admin } : {}),
    ...(payload.role ? { role: payload.role } : {}),
  };
}

// ---------------------------------------------------------------------------
// Express middleware helper
// ---------------------------------------------------------------------------

export interface EveAuthRequest {
  agent?: EveTokenClaims;
}

/**
 * Express middleware that verifies Eve tokens.
 * Attaches claims to `req.agent` on success, returns 401 on failure.
 *
 * Usage:
 *   app.use('/api', eveAuthMiddleware());
 *   // or with explicit URL:
 *   app.use('/api', eveAuthMiddleware({ eveApiUrl: 'https://api.eve.example.com' }));
 */
export function eveAuthMiddleware(options?: {
  eveApiUrl?: string;
  strategy?: 'remote' | 'local';
}) {
  const strategy = options?.strategy ?? 'remote';
  const verify = strategy === 'local' ? verifyEveToken : verifyEveTokenRemote;

  return async (
    req: { headers: Record<string, string | string[] | undefined> } & EveAuthRequest,
    res: { status(code: number): { json(body: unknown): void } },
    next: () => void,
  ) => {
    const authHeader = req.headers.authorization;
    const token =
      typeof authHeader === 'string'
        ? authHeader.replace(/^Bearer\s+/i, '')
        : undefined;

    if (!token) {
      res.status(401).json({ error: 'Authorization header required' });
      return;
    }

    try {
      req.agent = await verify(token, options?.eveApiUrl);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid agent token' });
    }
  };
}

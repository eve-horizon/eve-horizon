import { EVE_API_URL, EVE_INTERNAL_API_KEY, SUPABASE_ANON_KEY, SUPABASE_AUTH_URL } from './config.js';
import type { SsoLoginContext } from './types.js';

export async function internalApiPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  if (!EVE_INTERNAL_API_KEY) {
    console.error('[wrap] EVE_INTERNAL_API_KEY not configured — refusing to call internal API');
    return null;
  }
  try {
    const res = await fetch(`${EVE_API_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': EVE_INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[wrap] ${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[wrap] ${path} fetch error:`, err);
    return null;
  }
}

export async function fetchAppContext(projectId: string | undefined): Promise<SsoLoginContext | null> {
  if (!projectId) return null;
  try {
    const res = await fetch(`${EVE_API_URL}/auth/app-context?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok) {
      console.error('[app-context] API returned', res.status, await res.text());
      return null;
    }
    return await res.json() as SsoLoginContext;
  } catch (err) {
    console.error('[app-context] Fetch error:', err);
    return null;
  }
}

/** Refresh a Supabase session using a refresh token. Returns { access_token, refresh_token }. */
export async function refreshSupabaseSession(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const url = `${SUPABASE_AUTH_URL}/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GoTrue refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

/** Exchange a Supabase access token for an Eve RS256 token via the Eve API. */
export async function exchangeForEveToken(
  supabaseAccessToken: string,
): Promise<{
  access_token: string;
  expires_at: string;
  user_id: string;
  invite_redirect_to?: string;
  invite_org_id?: string;
  invite_app_context?: { project_id?: string; org_id?: string } & Record<string, unknown>;
}> {
  const url = `${EVE_API_URL}/auth/exchange`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseAccessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Eve exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{
    access_token: string;
    expires_at: string;
    user_id: string;
    invite_redirect_to?: string;
    invite_org_id?: string;
    invite_app_context?: { project_id?: string; org_id?: string } & Record<string, unknown>;
  }>;
}

/** Decode a JWT payload without verification (for extracting email/user info from Supabase token). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

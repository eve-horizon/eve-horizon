import { internalApiFetch } from '@eve/shared';

type JsonValue = Record<string, unknown> | unknown[];

/** Percent-encoded dot, slash or backslash. */
const ENCODED_PATH_CHARACTER = /%(2e|2f|5c)/i;

/**
 * True for a plain absolute API path: it starts with a single `/`, carries
 * no query or fragment, no encoded dot, slash or backslash, and the URL
 * parser reads it back as exactly the same path (so no dot segments,
 * backslashes or characters that would need encoding).
 */
export function isPlainApiPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return false;
  }
  if (ENCODED_PATH_CHARACTER.test(path)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(path, 'http://api.invalid');
  } catch {
    return false;
  }
  return parsed.pathname === path && parsed.search === '' && parsed.hash === '';
}

async function requestJson<TResponse>(
  path: string,
  opts: { method: 'GET' | 'POST'; body?: JsonValue },
): Promise<TResponse> {
  // Every gateway call names a fixed internal route: refuse a path that
  // would reach a different one before it is sent with the internal key.
  if (!isPlainApiPath(path)) {
    throw new Error('Gateway API request refused: not a plain API path');
  }

  const baseUrl = process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required for gateway API calls');
  }

  const response = await internalApiFetch(path, { ...opts, baseUrl });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway API request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<TResponse>;
}

export async function postJson<TResponse>(path: string, body: JsonValue): Promise<TResponse> {
  return requestJson<TResponse>(path, { method: 'POST', body });
}

export async function getJson<TResponse>(path: string): Promise<TResponse> {
  return requestJson<TResponse>(path, { method: 'GET' });
}

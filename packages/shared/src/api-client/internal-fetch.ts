import { createHash, timingSafeEqual } from 'node:crypto';

/** Header used for internal service-to-service authentication. */
export const INTERNAL_TOKEN_HEADER = 'x-eve-internal-token';

/**
 * Check a presented internal token against the configured
 * `EVE_INTERNAL_API_KEY` in constant time.
 *
 * Fails closed: an unset key, or a missing, empty or non-string token, never
 * matches. Both values are hashed before comparison so neither the key's
 * content nor its length leaks through timing.
 */
export function internalTokenMatches(presented: unknown, expected: string | undefined): boolean {
  if (!expected || typeof presented !== 'string' || presented.length === 0) {
    return false;
  }
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Headers that authenticate a service-to-service call: the internal token
 * header when a key is configured, otherwise nothing (the callee then refuses
 * the call, which is the fail-closed outcome).
 */
export function internalAuthHeaders(
  key: string | undefined = process.env.EVE_INTERNAL_API_KEY,
): Record<string, string> {
  return key ? { [INTERNAL_TOKEN_HEADER]: key } : {};
}

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

/**
 * Build an API path from fixed text and values, encoding each value as
 * exactly one path segment:
 *
 *   apiPath`/internal/projects/${projectId}/workflows/${name}/invoke`
 *
 * Throws when a value is empty, `.` or `..`, or contains a slash or
 * backslash, so a value (a manifest key, an id from a payload) can never
 * select a different route. Append any query string separately.
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let path = strings[0];
  values.forEach((value, index) => {
    const segment = String(value);
    if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
      throw new Error(`API path segment refused: ${JSON.stringify(segment)}`);
    }
    path += encodeURIComponent(segment) + strings[index + 1];
  });
  if (!isPlainApiPath(path)) {
    throw new Error(`API path refused: ${JSON.stringify(path)} is not a plain API path`);
  }
  return path;
}

export interface InternalApiFetchOptions {
  /** HTTP method — defaults to 'GET'. */
  method?: string;
  /** JSON-serializable body. When provided, `content-type: application/json` is sent. */
  body?: unknown;
  /** Override the API base URL (defaults to `EVE_API_URL` from the environment). */
  baseUrl?: string;
  /** Override the internal token (defaults to `EVE_INTERNAL_API_KEY` from the environment). */
  internalToken?: string;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
}

/**
 * Perform an authenticated fetch against an internal Eve API endpoint.
 *
 * Builds the URL from `EVE_API_URL` (or `opts.baseUrl`) and attaches the
 * `x-eve-internal-token` header from `EVE_INTERNAL_API_KEY` (or
 * `opts.internalToken`). Returns the raw `Response` — callers own their
 * error semantics (throw vs return-null) and response parsing.
 *
 * Refuses (throws) a path that is not plain (see `isPlainApiPath`), so the
 * internal token only ever goes to the route the caller named.
 */
export async function internalApiFetch(
  path: string,
  opts: InternalApiFetchOptions = {},
): Promise<Response> {
  if (!isPlainApiPath(path)) {
    throw new Error('Internal API request refused: not a plain API path');
  }

  const baseUrl = opts.baseUrl ?? process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required for internal API calls');
  }

  const headers: Record<string, string> = {
    [INTERNAL_TOKEN_HEADER]: opts.internalToken ?? process.env.EVE_INTERNAL_API_KEY ?? '',
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...opts.headers,
  };

  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** Header used for internal service-to-service authentication. */
export const INTERNAL_TOKEN_HEADER = 'x-eve-internal-token';

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
 */
export async function internalApiFetch(
  path: string,
  opts: InternalApiFetchOptions = {},
): Promise<Response> {
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

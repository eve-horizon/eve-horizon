import type { ResolvedContext } from './context';
import type { CredentialsFile, TokenEntry } from './config';
import { loadCredentials, saveCredentials } from './config';

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  allowError?: boolean;
  tokenOverride?: string;
};

/** A parsed Server-Sent Events frame. */
export type SseFrame = {
  /** Value of the frame's `event:` field, or undefined when absent. */
  event?: string;
  /** All `data:` lines (each trimmed) joined with '\n'. */
  data: string;
};

type StreamOptions = {
  /** Extra request headers (e.g. Last-Event-ID). */
  headers?: Record<string, string>;
  /**
   * Emit any trailing partial frame (data received without a closing blank
   * line) when the stream ends. Matches the legacy pipeline/job behavior of
   * processing the remaining buffer at stream end.
   */
  flushPartialFrameOnEnd?: boolean;
  /** Called once after the response is validated, before reading begins. */
  onOpen?: () => void;
  /** Called after each raw chunk is received (before its frames are emitted). */
  onChunk?: () => void;
  /** Called for each complete SSE frame that contains at least one data line. */
  onFrame: (frame: SseFrame) => void | Promise<void>;
  tokenOverride?: string;
};

type ListResponseEnvelope<T> = {
  data: T[];
};

export async function requestJson<T>(
  context: ResolvedContext,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await requestRaw(context, path, options);
  const method = options.method ?? 'GET';

  if (response.status === 401 && options.tokenOverride === undefined) {
    const refreshed = await attemptRefresh(context);
    if (refreshed?.access_token) {
      context.token = refreshed.access_token;
      context.refreshToken = refreshed.refresh_token;
      context.expiresAt = refreshed.expires_at;
      const retry = await requestRaw(context, path, {
        ...options,
        tokenOverride: refreshed.access_token,
      });
      if (!retry.ok && !options.allowError) {
        const message = formatErrorMessage(retry);
        throw new Error(`HTTP ${retry.status}: ${method} ${path}: ${message}`);
      }
      return retry.data as T;
    }
  }

  if (!response.ok && !options.allowError) {
    const message = formatErrorMessage(response);
    const requestTarget = `${method} ${path}`;
    const requestFailedContext = `while calling ${requestTarget}: ${message}`;

    // Check for "Project not found" error and provide actionable guidance
    if ((response.status === 404 || response.status === 500) && message.includes('Project not found')) {
      const projectIdMatch = message.match(/Project not found: (proj_[a-z0-9]+)/);
      const projectId = projectIdMatch?.[1] ?? 'unknown';
      throw new Error(
        `Project not found: ${projectId}\n\n` +
        `The configured project_id does not exist in the connected Eve API.\n` +
        `This often happens when connecting to a different environment (e.g., K8s vs local).\n\n` +
        `To fix this, either:\n` +
        `  1. Clear the default project: eve profile set --project=""\n` +
        `  2. Set a valid project: eve profile set --project=<valid-project-id>\n` +
        `  3. Specify project per-command: eve job create --project=<id> ...\n\n` +
        `To list available projects: eve project list`
      );
    }

    throw new Error(`HTTP ${response.status}: ${requestFailedContext}`);
  }

  return response.data as T;
}

export function unwrapListResponse<T>(value: ListResponseEnvelope<T> | T[]): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object' && Array.isArray(value.data)) {
    return value.data;
  }
  throw new Error('Expected list response envelope with data[]');
}

export async function requestRaw(
  context: ResolvedContext,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; ok: boolean; data: unknown; text: string }>
{
  const headers: Record<string, string> = {
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const token = options.tokenOverride ?? context.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `${context.apiUrl}${path}`;
  const method = options.method ?? 'GET';

  const response = await fetchWithConnectionGuidance(context, url, method, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { status: response.status, ok: response.ok, data, text };
}

/**
 * Perform a fetch with the shared connection-error guidance used by all
 * API requests. Throws a friendly error on connection failures.
 */
async function fetchWithConnectionGuidance(
  context: ResolvedContext,
  url: string,
  method: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause = error instanceof Error ? (error as NodeJS.ErrnoException).cause as { code?: string } | undefined : undefined;
    const code = cause?.code;
    const isConnectionError =
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      (error instanceof Error && error.message.includes('fetch failed'));

    if (isConnectionError) {
      throw new Error(
        `Could not connect to ${context.apiUrl}\n\n` +
        `  The API is unreachable. Check that:\n` +
        `  - The URL is correct (current: ${context.apiUrl})\n` +
        `  - Your internet connection is working\n\n` +
        `  To change the API URL:\n` +
        `    eve profile set default --api-url <url>\n` +
        `    or set EVE_API_URL=<url>`,
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Request failed for ${method} ${url}: ${message}`);
  }
}

/**
 * Incremental SSE frame parser.
 *
 * Frames are separated by a blank line; both LF (`\n\n`) and CRLF
 * (`\r\n\r\n`) framing are accepted via the `\r?\n\r?\n` superset. Within a
 * frame, `event:` sets the event name and each `data:` line contributes one
 * (trimmed) data line; other fields (`id:`, `retry:`, comments) are ignored.
 * Frames without any `data:` line are dropped, matching all legacy CLI
 * SSE loops.
 */
export function createSseFrameParser(): {
  push(chunk: string): SseFrame[];
  flush(): SseFrame | null;
} {
  let buffer = '';

  function parseFrame(raw: string): SseFrame | null {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) {
      return null;
    }
    return { event, data: dataLines.join('\n') };
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const frames: SseFrame[] = [];
      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) {
          break;
        }
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) {
          frames.push(frame);
        }
      }
      return frames;
    },
    flush(): SseFrame | null {
      const raw = buffer;
      buffer = '';
      if (!raw.trim()) {
        return null;
      }
      return parseFrame(raw);
    },
  };
}

/**
 * Open an SSE stream against the API and emit parsed frames.
 *
 * Shares auth-header construction, 401 refresh, and connection-error
 * guidance with requestJson/requestRaw. Non-OK responses throw
 * `HTTP <status>: <body>` (the format used by the legacy hand-rolled
 * SSE loops); a missing body throws 'No response body received'.
 */
export async function requestStream(
  context: ResolvedContext,
  path: string,
  options: StreamOptions,
): Promise<void> {
  let response = await fetchStream(context, path, options);

  if (response.status === 401 && options.tokenOverride === undefined) {
    const refreshed = await attemptRefresh(context);
    if (refreshed?.access_token) {
      context.token = refreshed.access_token;
      context.refreshToken = refreshed.refresh_token;
      context.expiresAt = refreshed.expires_at;
      response = await fetchStream(context, path, options, refreshed.access_token);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new Error('No response body received');
  }

  options.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseFrameParser();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    options.onChunk?.();

    for (const frame of parser.push(chunk)) {
      await options.onFrame(frame);
    }
  }

  if (options.flushPartialFrameOnEnd) {
    const frame = parser.flush();
    if (frame) {
      await options.onFrame(frame);
    }
  }
}

async function fetchStream(
  context: ResolvedContext,
  path: string,
  options: StreamOptions,
  tokenOverride?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...options.headers,
  };

  const token = tokenOverride ?? options.tokenOverride ?? context.token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `${context.apiUrl}${path}`;
  return fetchWithConnectionGuidance(context, url, 'GET', { method: 'GET', headers });
}

function formatErrorMessage(response: { data: unknown; text: string }): string {
  if (typeof response.data === 'string') {
    return response.data;
  }

  if (response.data && typeof response.data === 'object') {
    const payload = response.data as {
      message?: unknown;
      error?: unknown;
      detail?: unknown;
      statusCode?: unknown;
    };

    return (
      [payload.message, payload.error, payload.detail, response.text]
        .map((entry) => {
          if (typeof entry === 'string' && entry.trim()) return entry;
          return '';
        })
        .find((entry) => entry.length > 0) ?? response.text
    );
  }

  return response.text;
}

async function attemptRefresh(context: ResolvedContext): Promise<TokenEntry | undefined> {
  if (!context.refreshToken) return undefined;
  if (!context.profile.supabase_url || !context.profile.supabase_anon_key) return undefined;

  const refreshResponse = await fetch(
    `${context.profile.supabase_url}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: context.profile.supabase_anon_key,
        Authorization: `Bearer ${context.profile.supabase_anon_key}`,
      },
      body: JSON.stringify({ refresh_token: context.refreshToken }),
    },
  );

  const refreshText = await refreshResponse.text();
  let refreshData: unknown = null;
  if (refreshText) {
    try {
      refreshData = JSON.parse(refreshText);
    } catch {
      refreshData = refreshText;
    }
  }

  if (!refreshResponse.ok || !refreshData || typeof refreshData !== 'object') {
    return undefined;
  }

  const payload = refreshData as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!payload.access_token) {
    return undefined;
  }

  const expiresAt = payload.expires_in
    ? Math.floor(Date.now() / 1000) + payload.expires_in
    : undefined;

  const nextToken: TokenEntry = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? context.refreshToken,
    expires_at: expiresAt,
    token_type: payload.token_type,
  };

  const credentials: CredentialsFile = loadCredentials();
  credentials.tokens[context.authKey] = nextToken;
  saveCredentials(credentials);
  return nextToken;
}

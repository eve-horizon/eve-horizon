import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const ACCESS_TOKEN_SKEW_SECONDS = 60;

export type CodeAuthCandidate = {
  sourcePath: string;
  authJsonB64: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt: number;
  lastRefresh?: string;
  auth: Record<string, unknown>;
};

export type CodexAuthValidation = {
  found: boolean;
  usable: boolean;
  candidate?: CodeAuthCandidate;
  authJsonB64?: string;
  accessToken?: string;
  apiKey?: string;
  expiresAt?: number;
  lastRefresh?: string;
  accessTokenValid?: boolean;
  refreshTokenPresent?: boolean;
  refreshTokenUsable?: boolean;
  refreshed?: boolean;
  validationStatus:
    | 'not_found'
    | 'api_key'
    | 'access_token_valid'
    | 'refreshed'
    | 'missing_refresh_token'
    | 'refresh_failed'
    | 'invalid_auth_json';
  error?: string;
  reloginRequired?: boolean;
};

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type FetchLike = typeof fetch;

export type ResolveCodexAuthOptions = {
  homeDir?: string;
  validateRefresh?: boolean;
  persistRefresh?: boolean;
  now?: Date;
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  timeoutMs?: number;
};

export function readCodeAuthCandidates(homeDir = homedir()): CodeAuthCandidate[] {
  const codexAuthPaths = [
    join(homeDir, '.codex', 'auth.json'),
    join(homeDir, '.code', 'auth.json'),
  ];

  const candidates: CodeAuthCandidate[] = [];

  for (const authPath of codexAuthPaths) {
    if (!existsSync(authPath)) continue;
    try {
      const content = readFileSync(authPath, 'utf8');
      const auth = JSON.parse(content) as Record<string, unknown>;
      const candidate = parseCodeAuthCandidate(authPath, auth, content);
      if (candidate) {
        candidates.push(candidate);
      }
    } catch {
      // Failed to parse, skip.
    }
  }

  return candidates;
}

export function pickFreshestCodeAuth(homeDir = homedir()): CodeAuthCandidate | null {
  const candidates = readCodeAuthCandidates(homeDir);
  if (candidates.length === 0) return null;
  return candidates.sort(compareCodeAuthCandidates)[0] ?? null;
}

export async function resolveCodexAuthForSync(
  options: ResolveCodexAuthOptions = {},
): Promise<CodexAuthValidation> {
  const candidates = readCodeAuthCandidates(options.homeDir).sort(compareCodeAuthCandidates);
  if (candidates.length === 0) {
    return {
      found: false,
      usable: false,
      validationStatus: 'not_found',
      error: 'No Codex auth.json found. Run `codex login --device-auth` and retry `eve auth sync --codex`.',
    };
  }

  let firstFailure: CodexAuthValidation | null = null;
  for (const candidate of candidates) {
    const validation = await validateCodeAuthCandidate(candidate, options);
    if (validation.usable) {
      return validation;
    }
    firstFailure ??= validation;
  }

  return firstFailure ?? {
    found: true,
    usable: false,
    validationStatus: 'invalid_auth_json',
    error: 'No usable Codex credential found.',
    reloginRequired: true,
  };
}

export async function validateCodeAuthCandidate(
  candidate: CodeAuthCandidate,
  options: ResolveCodexAuthOptions = {},
): Promise<CodexAuthValidation> {
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const accessTokenValid = candidate.accessToken
    ? candidate.expiresAt === 0 || candidate.expiresAt > nowSeconds + ACCESS_TOKEN_SKEW_SECONDS
    : undefined;

  if (candidate.apiKey) {
    return {
      found: true,
      usable: true,
      candidate,
      authJsonB64: candidate.authJsonB64,
      apiKey: candidate.apiKey,
      expiresAt: candidate.expiresAt,
      lastRefresh: candidate.lastRefresh,
      accessTokenValid,
      validationStatus: 'api_key',
    };
  }

  if (!candidate.accessToken) {
    return {
      found: true,
      usable: false,
      candidate,
      expiresAt: candidate.expiresAt,
      lastRefresh: candidate.lastRefresh,
      accessTokenValid: false,
      refreshTokenPresent: Boolean(candidate.refreshToken),
      refreshTokenUsable: false,
      validationStatus: 'invalid_auth_json',
      error: 'Codex auth.json does not contain an access token.',
      reloginRequired: true,
    };
  }

  if (!candidate.refreshToken) {
    return {
      found: true,
      usable: false,
      candidate,
      expiresAt: candidate.expiresAt,
      lastRefresh: candidate.lastRefresh,
      accessTokenValid,
      refreshTokenPresent: false,
      refreshTokenUsable: false,
      validationStatus: 'missing_refresh_token',
      error: 'Codex auth.json is missing a refresh token.',
      reloginRequired: true,
    };
  }

  if (!options.validateRefresh) {
    return {
      found: true,
      usable: accessTokenValid !== false,
      candidate,
      authJsonB64: candidate.authJsonB64,
      accessToken: candidate.accessToken,
      expiresAt: candidate.expiresAt,
      lastRefresh: candidate.lastRefresh,
      accessTokenValid,
      refreshTokenPresent: true,
      validationStatus: accessTokenValid === false ? 'refresh_failed' : 'access_token_valid',
    };
  }

  return refreshCodeAuthCandidate(candidate, options);
}

function parseCodeAuthCandidate(
  sourcePath: string,
  auth: Record<string, unknown>,
  content: string,
): CodeAuthCandidate | null {
  const authJsonB64 = Buffer.from(content, 'utf8').toString('base64');
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  const accessToken = stringValue(tokens?.access_token ?? auth.oauth_token ?? auth.access_token);
  const refreshToken = stringValue(tokens?.refresh_token ?? auth.refresh_token);
  const apiKey = stringValue(auth.OPENAI_API_KEY);
  const expiresAt =
    numberValue(tokens?.expires_at ?? auth.expires_at) ??
    (accessToken ? decodeJwtExpiry(accessToken) : undefined) ??
    0;
  const lastRefresh = stringValue(auth.last_refresh);

  if (!accessToken && !apiKey) {
    return null;
  }

  return {
    sourcePath,
    authJsonB64,
    accessToken,
    refreshToken,
    apiKey,
    expiresAt,
    lastRefresh,
    auth,
  };
}

function compareCodeAuthCandidates(left: CodeAuthCandidate, right: CodeAuthCandidate): number {
  if (right.expiresAt !== left.expiresAt) {
    return right.expiresAt - left.expiresAt;
  }
  const leftRefresh = Date.parse(left.lastRefresh ?? '') || 0;
  const rightRefresh = Date.parse(right.lastRefresh ?? '') || 0;
  if (rightRefresh !== leftRefresh) {
    return rightRefresh - leftRefresh;
  }
  return left.sourcePath.localeCompare(right.sourcePath);
}

function decodeJwtExpiry(token: string): number | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    return numberValue(decoded.exp);
  } catch {
    return undefined;
  }
}

async function refreshCodeAuthCandidate(
  candidate: CodeAuthCandidate,
  options: ResolveCodexAuthOptions,
): Promise<CodexAuthValidation> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenUrl = options.tokenUrl ?? DEFAULT_CODEX_TOKEN_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: candidate.refreshToken ?? '',
      client_id: DEFAULT_CODEX_CLIENT_ID,
    });
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: abortController.signal,
    });

    const responseText = await response.text();
    const data = parseRefreshResponse(responseText);

    if (!response.ok || data.error) {
      const message = data.error_description || data.error || responseText || `HTTP ${response.status}`;
      return {
        found: true,
        usable: false,
        candidate,
        expiresAt: candidate.expiresAt,
        lastRefresh: candidate.lastRefresh,
        accessTokenValid: false,
        refreshTokenPresent: true,
        refreshTokenUsable: false,
        validationStatus: 'refresh_failed',
        error: message,
        reloginRequired: isReloginError(message),
      };
    }

    if (!data.access_token || !data.refresh_token) {
      return {
        found: true,
        usable: false,
        candidate,
        expiresAt: candidate.expiresAt,
        lastRefresh: candidate.lastRefresh,
        accessTokenValid: false,
        refreshTokenPresent: true,
        refreshTokenUsable: false,
        validationStatus: 'refresh_failed',
        error: 'Codex token refresh response did not include both access_token and refresh_token.',
        reloginRequired: true,
      };
    }

    const refreshedAtDate = options.now ?? new Date();
    const nextAuth = buildRefreshedAuth(candidate.auth, data, refreshedAtDate);
    const nextContent = JSON.stringify(nextAuth, null, 2);
    const refreshedCandidate = parseCodeAuthCandidate(candidate.sourcePath, nextAuth, nextContent);
    if (!refreshedCandidate) {
      return {
        found: true,
        usable: false,
        candidate,
        validationStatus: 'invalid_auth_json',
        error: 'Codex token refresh produced an invalid auth.json payload.',
        reloginRequired: true,
      };
    }

    if (options.persistRefresh ?? true) {
      writeFileSync(candidate.sourcePath, `${nextContent}\n`, 'utf8');
    }

    return {
      found: true,
      usable: true,
      candidate: refreshedCandidate,
      authJsonB64: refreshedCandidate.authJsonB64,
      accessToken: refreshedCandidate.accessToken,
      expiresAt: refreshedCandidate.expiresAt,
      lastRefresh: refreshedCandidate.lastRefresh,
      accessTokenValid: true,
      refreshTokenPresent: true,
      refreshTokenUsable: true,
      refreshed: true,
      validationStatus: 'refreshed',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      found: true,
      usable: false,
      candidate,
      expiresAt: candidate.expiresAt,
      lastRefresh: candidate.lastRefresh,
      accessTokenValid: false,
      refreshTokenPresent: true,
      refreshTokenUsable: false,
      validationStatus: 'refresh_failed',
      error: message,
      reloginRequired: isReloginError(message),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildRefreshedAuth(
  auth: Record<string, unknown>,
  data: RefreshResponse,
  refreshedAt: Date,
): Record<string, unknown> {
  const tokens = (auth.tokens && typeof auth.tokens === 'object')
    ? { ...(auth.tokens as Record<string, unknown>) }
    : {};

  tokens.access_token = data.access_token;
  tokens.refresh_token = data.refresh_token;
  if (data.id_token) {
    tokens.id_token = data.id_token;
  }
  if (data.account_id) {
    tokens.account_id = data.account_id;
  }
  if (typeof data.expires_in === 'number') {
    tokens.expires_at = Math.floor(refreshedAt.getTime() / 1000) + data.expires_in;
  }

  return {
    ...auth,
    auth_mode: auth.auth_mode ?? 'chatgpt',
    OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null,
    tokens,
    last_refresh: refreshedAt.toISOString(),
  };
}

function parseRefreshResponse(text: string): RefreshResponse {
  if (!text) return {};
  try {
    return JSON.parse(text) as RefreshResponse;
  } catch {
    return { error_description: text };
  }
}

function isReloginError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('refresh_token_reused') ||
    normalized.includes('invalid_grant') ||
    normalized.includes('token_expired') ||
    normalized.includes('refresh token') ||
    normalized.includes('sign in') ||
    normalized.includes('login');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const TOKEN_KEY = 'eve_access_token';

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Silently fail in non-browser environments
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Silently fail
  }
}

/**
 * Decode a JWT payload without verification (browser-side expiry check).
 */
export function decodeTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeTokenPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp < Math.floor(Date.now() / 1000);
}

/**
 * Creates a fetch wrapper that injects the Eve token.
 */
export function createEveClient(baseUrl = '/api') {
  const normalizedBase = baseUrl.replace(/\/$/, '');

  return {
    getToken: getStoredToken,

    fetch: async (path: string, init?: RequestInit): Promise<Response> => {
      const token = getStoredToken();
      const headers = new Headers(init?.headers);
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return fetch(`${normalizedBase}${path}`, { ...init, headers });
    },
  };
}

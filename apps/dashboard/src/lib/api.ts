const BASE = '/api';

function getToken(): string | null {
  try {
    return sessionStorage.getItem('eve_access_token');
  } catch {
    return null;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers(), ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

// SSE helper for streaming logs
export function createEventSource(path: string): EventSource {
  const token = getToken();
  const url = token ? `${BASE}${path}?token=${encodeURIComponent(token)}` : `${BASE}${path}`;
  return new EventSource(url);
}

import { internalApiFetch } from '@eve/shared';

type JsonValue = Record<string, unknown> | unknown[];

async function requestJson<TResponse>(
  path: string,
  opts: { method: 'GET' | 'POST'; body?: JsonValue },
): Promise<TResponse> {
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

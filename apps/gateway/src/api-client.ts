type JsonValue = Record<string, unknown> | unknown[];

export async function postJson<TResponse>(path: string, body: JsonValue): Promise<TResponse> {
  const baseUrl = process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required for gateway API calls');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-eve-internal-token': process.env.EVE_INTERNAL_API_KEY ?? '',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway API request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<TResponse>;
}

export async function getJson<TResponse>(path: string): Promise<TResponse> {
  const baseUrl = process.env.EVE_API_URL;
  if (!baseUrl) {
    throw new Error('EVE_API_URL is required for gateway API calls');
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      'x-eve-internal-token': process.env.EVE_INTERNAL_API_KEY ?? '',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway API request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<TResponse>;
}

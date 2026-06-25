import { describe, expect, it } from 'vitest';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';

async function requestJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${text}`);
  }
  return data as T;
}

describe('integration pricing (phase 1)', () => {
  it('creates rate cards and resolves the effective version', async () => {
    const name = `integration-${Date.now()}`;
    const ratesJson = {
      llm: { byok: {}, managed: {} },
      compute: { default: { vcpu_hour_usd: '0.01', memory_gib_hour_usd: '0.02' } },
    };

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await requestJson<{ id: string }>(`/admin/pricing/rate-cards`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        version: 1,
        effective_at: past,
        rates_json: ratesJson,
      }),
    });

    await requestJson<{ id: string }>(`/admin/pricing/rate-cards`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        version: 2,
        effective_at: future,
        rates_json: ratesJson,
      }),
    });

    const effectiveNow = await requestJson<{ name: string; version: number }>(
      `/admin/pricing/rate-cards/effective?name=${encodeURIComponent(name)}`,
    );
    expect(effectiveNow.name).toBe(name);
    expect(effectiveNow.version).toBe(1);

    const effectiveFuture = await requestJson<{ name: string; version: number }>(
      `/admin/pricing/rate-cards/effective?name=${encodeURIComponent(name)}&at=${encodeURIComponent(new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString())}`,
    );
    expect(effectiveFuture.name).toBe(name);
    expect(effectiveFuture.version).toBe(2);
  });

  it('inserts exchange rates and returns the latest snapshot', async () => {
    const fetchedAt = new Date().toISOString();
    await requestJson<{ id: string }>(`/admin/pricing/exchange-rates`, {
      method: 'POST',
      body: JSON.stringify({
        from_currency: 'usd',
        to_currency: 'sats',
        rate: '12345.67',
        source: 'manual',
        fetched_at: fetchedAt,
      }),
    });

    const latest = await requestJson<{
      from_currency: string;
      to_currency: string;
      rate: string;
      source: string;
      fetched_at: string;
    } | null>(`/admin/pricing/exchange-rates/latest?from=usd&to=sats`);

    expect(latest).toBeTruthy();
    expect(latest?.from_currency).toBe('usd');
    expect(latest?.to_currency).toBe('sats');
    expect(latest?.rate).toBe('12345.67');
    expect(latest?.source).toBe('manual');
  });
});


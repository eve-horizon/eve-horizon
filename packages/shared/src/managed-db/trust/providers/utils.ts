import { readFile } from 'node:fs/promises';

const bundleFetchCache = new Map<string, Promise<string>>();

function normalizePem(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

export async function readPemOverride(prefix: string): Promise<string | null> {
  const inlinePem = process.env[`${prefix}_PEM`];
  if (inlinePem && inlinePem.trim().length > 0) {
    return normalizePem(inlinePem);
  }

  const pemFile = process.env[`${prefix}_FILE`];
  if (!pemFile || pemFile.trim().length === 0) {
    return null;
  }

  return normalizePem(await readFile(pemFile, 'utf8'));
}

export async function fetchPemBundle(url: string): Promise<string> {
  let pending = bundleFetchCache.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'eve-horizon/managed-db-trust',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch PEM bundle from ${url}: HTTP ${response.status}`);
      }

      return normalizePem(await response.text());
    })();

    bundleFetchCache.set(url, pending);
  }

  return pending;
}

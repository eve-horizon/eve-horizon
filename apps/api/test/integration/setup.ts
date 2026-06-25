import { beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const apiUrl = process.env.EVE_API_URL || 'http://localhost:4701';
const bootstrapToken = process.env.EVE_BOOTSTRAP_TOKEN || 'test-bootstrap-token';
const bootstrapEmail = process.env.EVE_AUTH_TEST_EMAIL || 'admin@example.com';
const bootstrapKey = process.env.EVE_AUTH_TEST_PUBLIC_KEY;

const testHome = process.env.EVE_TEST_HOME || mkdtempSync(join(tmpdir(), 'eve-test-home-'));
process.env.EVE_TEST_HOME = testHome;
process.env.HOME = testHome;

let cachedToken: string | undefined;
let bootstrapInFlight: Promise<string> | undefined;

function writeCredentials(token: string) {
  const configDir = join(testHome, '.eve');
  mkdirSync(configDir, { recursive: true });
  const credentialsPath = join(configDir, 'credentials.json');
  const profileKeys = new Set<string>(['default', 'local']);
  if (process.env.EVE_PROFILE) {
    profileKeys.add(process.env.EVE_PROFILE);
  }

  const profileTokens = Object.fromEntries(
    Array.from(profileKeys).map((profile) => [
      profile,
      { access_token: token, token_type: 'bearer' },
    ]),
  );

  writeFileSync(
    credentialsPath,
    JSON.stringify({
      tokens: {
        [apiUrl.replace(/\/+$/, '')]: { access_token: token, token_type: 'bearer' },
      },
      profiles: profileTokens,
    }, null, 2),
  );
}

async function bootstrapAuth(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (bootstrapInFlight) return bootstrapInFlight;

  bootstrapInFlight = (async () => {
    if (!bootstrapKey) {
      throw new Error('EVE_AUTH_TEST_PUBLIC_KEY is required for auth bootstrap tests');
    }

    const response = await fetch(`${apiUrl}/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: bootstrapToken,
        email: bootstrapEmail,
        public_key: bootstrapKey,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Auth bootstrap failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Auth bootstrap response missing access_token');
    }

    cachedToken = data.access_token;
    writeCredentials(cachedToken);
    return cachedToken;
  })();

  return bootstrapInFlight;
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await bootstrapAuth();
});

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!originalFetch) {
    throw new Error('global fetch is not available');
  }

  const url = typeof input === 'string' ? input : input.toString();

  if (url.startsWith(apiUrl) && !url.includes('/auth/bootstrap')) {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('Authorization') && !url.includes('/auth/challenge') && !url.includes('/auth/verify')) {
      const token = await bootstrapAuth();
      headers.set('Authorization', `Bearer ${token}`);
    }
    return originalFetch(input, { ...init, headers });
  }

  return originalFetch(input, init);
};

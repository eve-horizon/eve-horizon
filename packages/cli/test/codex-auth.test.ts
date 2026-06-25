import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  pickFreshestCodeAuth,
  resolveCodexAuthForSync,
} from '../src/lib/codex-auth';

function fakeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function writeAuth(homeDir: string, dir: '.codex' | '.code', auth: Record<string, unknown>): string {
  const authDir = path.join(homeDir, dir);
  fs.mkdirSync(authDir, { recursive: true });
  const authPath = path.join(authDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  return authPath;
}

describe('Codex auth helpers', () => {
  it('picks the auth.json with the freshest decoded access token expiry', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-codex-auth-'));
    try {
      writeAuth(home, '.codex', {
        tokens: {
          access_token: fakeJwt(100),
          refresh_token: 'rt_old',
        },
        last_refresh: '2026-01-01T00:00:00.000Z',
      });
      writeAuth(home, '.code', {
        tokens: {
          access_token: fakeJwt(200),
          refresh_token: 'rt_new',
        },
        last_refresh: '2026-01-02T00:00:00.000Z',
      });

      const candidate = pickFreshestCodeAuth(home);

      expect(candidate?.sourcePath).toBe(path.join(home, '.code', 'auth.json'));
      expect(candidate?.expiresAt).toBe(200);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refreshes and persists rotated tokens before sync', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-codex-auth-'));
    const now = new Date('2026-05-02T08:00:00.000Z');
    try {
      const authPath = writeAuth(home, '.codex', {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: fakeJwt(100),
          refresh_token: 'rt_original',
          account_id: 'acct_1',
        },
        last_refresh: '2026-02-24T19:57:10.402005Z',
      });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'next_access',
        refresh_token: 'next_refresh',
        id_token: 'next_id',
        expires_in: 3600,
      }), { status: 200 }));

      const result = await resolveCodexAuthForSync({
        homeDir: home,
        validateRefresh: true,
        persistRefresh: true,
        now,
        fetchImpl: fetchImpl as never,
      });

      expect(result.usable).toBe(true);
      expect(result.refreshTokenUsable).toBe(true);
      expect(result.refreshed).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain('grant_type=refresh_token');
      expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain('refresh_token=rt_original');

      const persisted = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      expect(persisted.tokens.access_token).toBe('next_access');
      expect(persisted.tokens.refresh_token).toBe('next_refresh');
      expect(persisted.tokens.id_token).toBe('next_id');
      expect(persisted.tokens.expires_at).toBe(Math.floor(now.getTime() / 1000) + 3600);
      expect(persisted.last_refresh).toBe(now.toISOString());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports reused refresh tokens as relogin-required failures', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-codex-auth-'));
    try {
      writeAuth(home, '.codex', {
        tokens: {
          access_token: fakeJwt(100),
          refresh_token: 'rt_reused',
        },
        last_refresh: '2026-02-24T19:57:10.402005Z',
      });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: 'refresh_token_reused',
        error_description: 'Your access token could not be refreshed because your refresh token was already used.',
      }), { status: 401 }));

      const result = await resolveCodexAuthForSync({
        homeDir: home,
        validateRefresh: true,
        persistRefresh: true,
        fetchImpl: fetchImpl as never,
      });

      expect(result.usable).toBe(false);
      expect(result.refreshTokenUsable).toBe(false);
      expect(result.reloginRequired).toBe(true);
      expect(result.error).toContain('refresh token was already used');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

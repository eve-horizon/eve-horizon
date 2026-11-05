import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import type { AppAuthService } from './app-auth.service';

const mocks = vi.hoisted(() => ({
  users: {
    findFirstAdmin: vi.fn(),
    create: vi.fn(),
  },
  identities: {
    create: vi.fn(),
  },
}));

vi.mock('@eve/db', () => ({
  userQueries: vi.fn(() => mocks.users),
  identityQueries: vi.fn(() => mocks.identities),
}));

const ENV_KEYS = ['DATABASE_URL', 'NODE_ENV', 'EVE_DEV_REBOOTSTRAP', 'EVE_BOOTSTRAP_TOKEN'] as const;
const EXISTING_ADMIN = { id: 'user_admin', email: 'admin@example.com' };
const REQUEST = { email: 'attacker@example.com', public_key: 'ssh-ed25519 AAAA attacker' };

describe('BootstrapService once an admin exists', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let mintUserToken: ReturnType<typeof vi.fn>;

  function buildService(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): BootstrapService {
    env = { DATABASE_URL: 'postgres://eve:eve@localhost:5432/eve_test', ...env };
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    mintUserToken = vi.fn().mockResolvedValue({ access_token: 'admin-token', token_type: 'bearer' });
    return new BootstrapService({} as never, { mintUserToken } as unknown as AppAuthService);
  }

  async function expectRefused(service: BootstrapService, input = REQUEST): Promise<void> {
    await expect(service.bootstrapAdmin(input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mintUserToken).not.toHaveBeenCalled();
    expect(mocks.users.create).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    vi.clearAllMocks();
    mocks.users.findFirstAdmin.mockResolvedValue(EXISTING_ADMIN);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('refuses without returning a token when NODE_ENV is unset (the default)', async () => {
    await expectRefused(buildService({}));
  });

  it('refuses in development mode unless re-bootstrap is explicitly enabled', async () => {
    await expectRefused(buildService({ NODE_ENV: 'development' }));
    await expectRefused(buildService({ NODE_ENV: 'test', EVE_BOOTSTRAP_TOKEN: 'bootstrap-secret' }), {
      ...REQUEST,
      token: 'bootstrap-secret',
    } as typeof REQUEST);
  });

  it('refuses in production even when re-bootstrap is enabled and the token matches', async () => {
    await expectRefused(
      buildService({ NODE_ENV: 'production', EVE_DEV_REBOOTSTRAP: 'true', EVE_BOOTSTRAP_TOKEN: 'bootstrap-secret' }),
      { ...REQUEST, token: 'bootstrap-secret' } as typeof REQUEST,
    );
  });

  it('requires the configured bootstrap token for a dev re-issue', async () => {
    const service = buildService({ NODE_ENV: 'test', EVE_DEV_REBOOTSTRAP: 'true', EVE_BOOTSTRAP_TOKEN: 'bootstrap-secret' });
    await expectRefused(service);
    await expectRefused(service, { ...REQUEST, token: 'wrong-secret' } as typeof REQUEST);
  });

  it('re-issues the existing admin token in dev when explicitly enabled and the token matches', async () => {
    const service = buildService({ NODE_ENV: 'test', EVE_DEV_REBOOTSTRAP: 'true', EVE_BOOTSTRAP_TOKEN: 'bootstrap-secret' });
    const result = await service.bootstrapAdmin({ ...REQUEST, token: 'bootstrap-secret' });
    expect(result).toEqual({ access_token: 'admin-token', token_type: 'bearer', user_id: EXISTING_ADMIN.id });
    expect(mintUserToken).toHaveBeenCalledWith(EXISTING_ADMIN.id, EXISTING_ADMIN.email);
    expect(mocks.users.create).not.toHaveBeenCalled();
  });

  it('re-issues without a token only when no bootstrap token is configured and re-bootstrap is enabled', async () => {
    const service = buildService({ NODE_ENV: 'development', EVE_DEV_REBOOTSTRAP: 'true' });
    const result = await service.bootstrapAdmin(REQUEST);
    expect(result.user_id).toBe(EXISTING_ADMIN.id);
  });
});

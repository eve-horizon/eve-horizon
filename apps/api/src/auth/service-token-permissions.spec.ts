import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { DEFAULT_SERVICE_PERMISSIONS } from '@eve/shared';
import { AuthService } from './auth.service';
import { AppAuthService } from './app-auth.service';
import { MagicLinkService } from './magic-link.service';
import { TokenVerifierService } from './token-verifier.service';
import { BootstrapService } from './bootstrap.service';
import { createJwtRs256 } from './auth.util';
import type { MailerService } from '../mailer/mailer.service';
import type { IdentityProviderRegistry } from './providers/index.js';

vi.mock('@eve/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@eve/db')>();
  const empty = () => ({});
  return {
    ...actual,
    userQueries: vi.fn(empty),
    membershipQueries: vi.fn(empty),
    projectQueries: vi.fn(empty),
  };
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** What the app-service docs say a service may ask for in x-eve.permissions. */
const documentedWrites = ['jobs:write', 'events:write', 'threads:write', 'envdb:write'];
/** Platform, admin-level and org-management permissions. */
const outOfReach = [
  'system:read',
  'system:admin',
  'jobs:admin',
  'secrets:admin',
  'projects:admin',
  'orgs:admin',
  'orgs:write',
  'orgs:invite',
  'orgs:create',
  'projects:create',
  'integrations:write',
  'endpoints:write',
];

function buildAuthService(): AuthService {
  const mailer = { send: vi.fn() } as unknown as MailerService;
  const magicLink = new MagicLinkService({} as never, mailer);
  const appAuth = new AppAuthService({} as never, magicLink);
  const tokenVerifier = new TokenVerifierService({} as never, appAuth, magicLink);
  const bootstrap = new BootstrapService({} as never, appAuth);
  return new AuthService({} as never, {} as IdentityProviderRegistry, magicLink, appAuth, tokenVerifier, bootstrap);
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

describe('deployed-service token permissions', () => {
  let authService: AuthService;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://eve:eve@localhost:5432/eve';
    process.env.EVE_AUTH_ENABLED = 'true';
    process.env.EVE_AUTH_PRIVATE_KEY = privatePem;
    authService = buildAuthService();
  });

  const requested = [...DEFAULT_SERVICE_PERMISSIONS, ...documentedWrites, ...outOfReach];

  it('are minted without platform, admin-level or org-management permissions', () => {
    const token = authService.mintServiceToken({
      projectId: 'proj_a',
      orgId: 'org_a',
      envName: 'staging',
      serviceName: 'web',
      permissions: requested,
    });

    const permissions = decodePayload(token).permissions as string[];
    expect(permissions).toEqual(expect.arrayContaining([...DEFAULT_SERVICE_PERMISSIONS, ...documentedWrites]));
    for (const permission of outOfReach) {
      expect(permissions).not.toContain(permission);
    }
  });

  it('are held to the same set when a token signed earlier is presented', async () => {
    const now = Math.floor(Date.now() / 1000);
    const earlier = createJwtRs256(
      {
        sub: 'service:web',
        org_id: 'org_a',
        project_id: 'proj_a',
        env_name: 'staging',
        service_name: 'web',
        permissions: requested,
        iat: now,
        exp: now + 600,
        type: 'service',
      },
      { kid: 'key-1', privateKey, publicKey },
    );

    const user = await authService.verifyAuthorizationHeader(`Bearer ${earlier}`);

    expect(user.is_service_token).toBe(true);
    expect(user.permissions).toEqual(expect.arrayContaining([...DEFAULT_SERVICE_PERMISSIONS, ...documentedWrites]));
    for (const permission of outOfReach) {
      expect(user.permissions).not.toContain(permission);
    }
  });
});

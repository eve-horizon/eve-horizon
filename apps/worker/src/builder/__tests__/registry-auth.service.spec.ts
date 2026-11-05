import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRegistryPushCredential } from '@eve/shared';
import { RegistryAuthService } from '../registry-auth.service.js';

describe('RegistryAuthService - Eve registry', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
    vi.stubEnv('EVE_REGISTRY_HOST', 'registry.eve.example.com');
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gives builds a push credential scoped to the project, never the internal key', async () => {
    const { auth, config } = await new RegistryAuthService().resolve('proj_01hshop', 'registry: eve\n');

    expect(config).toEqual({ host: 'registry.eve.example.com', eveProjectId: 'proj_01hshop' });
    expect(auth.username).toBe('eve-push');
    expect(auth.token).not.toContain('internal-key');
    const dockerConfig = Buffer.from(auth.dockerConfigJson, 'base64').toString('utf8');
    expect(dockerConfig).not.toContain('internal-key');
    expect(Buffer.from(JSON.parse(dockerConfig).auths['registry.eve.example.com'].auth, 'base64').toString('utf8'))
      .not.toContain('internal-key');
    expect(verifyRegistryPushCredential(auth.token, 'internal-key')).toMatchObject({ projectId: 'proj_01hshop' });
  });
});

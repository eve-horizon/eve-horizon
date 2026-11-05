import { generateKeyPairSync } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintRegistryPullCredential } from '@eve/shared';
import {
  grantRegistryAccess,
  identifyRegistryCaller,
  isPullCredentialCurrent,
  repositoryFromImageRef,
} from './registry-access.js';
import { RegistryTokenController } from './registry-token.controller.js';

const KEY = 'internal-key';
const PULL_CLAIMS = { projectId: 'proj_shop', environmentId: 'env_test', namespace: 'eve-acme-shop-test', epoch: 4 };
const projectCaller = { kind: 'project-pull' as const, ...PULL_CLAIMS };

describe('identifyRegistryCaller', () => {
  it('recognises the internal key', () => {
    expect(identifyRegistryCaller(KEY, KEY)).toEqual({ kind: 'internal' });
  });

  it('recognises a project pull credential', () => {
    const credential = mintRegistryPullCredential(PULL_CLAIMS, KEY);
    expect(identifyRegistryCaller(credential, KEY)).toEqual(projectCaller);
  });

  it('rejects anything else, and everything when no key is configured', () => {
    expect(identifyRegistryCaller('wrong', KEY)).toBeNull();
    expect(identifyRegistryCaller(undefined, KEY)).toBeNull();
    expect(identifyRegistryCaller(KEY, undefined)).toBeNull();
    const foreign = mintRegistryPullCredential(PULL_CLAIMS, 'other-key');
    expect(identifyRegistryCaller(foreign, KEY)).toBeNull();
  });
});

describe('isPullCredentialCurrent', () => {
  const liveEnv = { project_id: 'proj_shop', status: 'active', registry_pull_epoch: 4 };

  it('honours the current epoch and the one before it', () => {
    expect(isPullCredentialCurrent(projectCaller, liveEnv, true)).toBe(true);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, registry_pull_epoch: 5 }, true)).toBe(true);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, status: 'suspended' }, true)).toBe(true);
  });

  it('refuses a superseded credential (two rewrites later)', () => {
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, registry_pull_epoch: 6 }, true)).toBe(false);
  });

  it('refuses a credential from the future', () => {
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, registry_pull_epoch: 3 }, true)).toBe(false);
  });

  it('refuses a deleted or terminated environment, another project, or a deleted project', () => {
    expect(isPullCredentialCurrent(projectCaller, null, true)).toBe(false);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, status: 'terminated' }, true)).toBe(false);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, project_id: 'proj_other' }, true)).toBe(false);
    expect(isPullCredentialCurrent(projectCaller, liveEnv, false)).toBe(false);
  });
});

describe('grantRegistryAccess', () => {
  it('gives internal callers push and pull on any repository, nothing else', () => {
    expect(
      grantRegistryAccess({ kind: 'internal' }, [
        { type: 'repository', name: 'shop-api', actions: ['pull', 'push'] },
        { type: 'repository', name: 'other-web', actions: ['pull'] },
        { type: 'repository', name: 'shop-api', actions: ['delete', '*'] },
        { type: 'registry', name: 'catalog', actions: ['*'] },
      ]),
    ).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['pull', 'push'] },
      { type: 'repository', name: 'other-web', actions: ['pull'] },
    ]);
  });

  it('gives project callers pull only, on their own repositories only', () => {
    const repositories = new Set(['shop-api', 'acme/shop-web']);
    expect(
      grantRegistryAccess(
        projectCaller,
        [
          { type: 'repository', name: 'shop-api', actions: ['pull', 'push'] },
          { type: 'repository', name: 'acme/shop-web', actions: ['pull'] },
          { type: 'repository', name: 'other-api', actions: ['pull'] },
          { type: 'repository', name: 'shop-api', actions: ['delete'] },
          { type: 'registry', name: 'catalog', actions: ['*'] },
        ],
        repositories,
      ),
    ).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['pull'] },
      { type: 'repository', name: 'acme/shop-web', actions: ['pull'] },
    ]);
  });

  it('gives a project caller with no builds nothing', () => {
    expect(
      grantRegistryAccess(projectCaller, [{ type: 'repository', name: 'shop-api', actions: ['pull'] }]),
    ).toEqual([]);
  });
});

describe('repositoryFromImageRef', () => {
  it.each([
    ['registry.eve.example.com/shop-api', 'shop-api'],
    ['registry.eve.example.com/shop-api:sha-0123456789ab', 'shop-api'],
    ['registry.eve.example.com/acme/shop-web@sha256:abc', 'acme/shop-web'],
    ['eve-registry.eve.svc.cluster.local:5000/shop-api:local', 'shop-api'],
    ['localhost/shop-api', 'shop-api'],
    ['shop-api', 'shop-api'],
    ['acme/shop-api:v1', 'acme/shop-api'],
  ])('%s -> %s', (imageRef, repository) => {
    expect(repositoryFromImageRef(imageRef)).toBe(repository);
  });

  it('returns null for an empty ref', () => {
    expect(repositoryFromImageRef('')).toBeNull();
  });
});

describe('RegistryTokenController GET /internal/registry/token', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const imageRefsByProject: Record<string, string[]> = {
    proj_shop: [
      'registry.eve.example.com/shop-api',
      'registry.eve.example.com/shop-web:v2',
    ],
  };
  // Stands in for the postgres tagged-template client: the only query this
  // controller runs is listImageRefsForProject(projectId).
  const db = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) =>
    (imageRefsByProject[String(values[0])] ?? []).map((image_ref) => ({ image_ref })),
  );

  function basic(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  function grantedAccess(token: string): unknown {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).access;
  }

  let controller: RegistryTokenController;
  let environment: { project_id: string; status: string; registry_pull_epoch: number } | null;
  let project: { id: string } | null;
  const credential = () => mintRegistryPullCredential(PULL_CLAIMS, KEY);

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
    vi.stubEnv('EVE_INTERNAL_API_KEY', KEY);
    vi.stubEnv('EVE_REGISTRY_SIGNING_KEY', signingKey);
    db.mockClear();
    environment = { project_id: 'proj_shop', status: 'active', registry_pull_epoch: 4 };
    project = { id: 'proj_shop' };
    controller = new RegistryTokenController(db as any);
    (controller as any).environments = { findById: vi.fn(async (id: string) => (id === 'env_test' ? environment : null)) };
    (controller as any).projects = { findById: vi.fn(async (id: string) => (id === 'proj_shop' ? project : null)) };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('grants a project pull credential pull on its own repositories only', async () => {
    const response = await controller.issueTokenGet(
      basic('eve-pull', credential()),
      ['repository:shop-api:pull,push', 'repository:shop-web:pull', 'repository:other-api:pull'],
      'eve-registry',
    );
    expect(grantedAccess(response.token)).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['pull'] },
      { type: 'repository', name: 'shop-web', actions: ['pull'] },
    ]);
    const payload = JSON.parse(Buffer.from(response.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('eve-pull:proj_shop');
  });

  it('keeps builds working: the internal key still gets push and pull', async () => {
    const response = await controller.issueTokenGet(
      basic('eve-token', KEY),
      ['repository:shop-api:pull,push', 'repository:other-api:pull'],
      'eve-registry',
    );
    expect(grantedAccess(response.token)).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['pull', 'push'] },
      { type: 'repository', name: 'other-api', actions: ['pull'] },
    ]);
    expect(db).not.toHaveBeenCalled();
  });

  it('answers a scopeless login probe with an empty token for either caller', async () => {
    const response = await controller.issueTokenGet(basic('eve-pull', credential()), undefined, 'eve-registry');
    expect(grantedAccess(response.token)).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  it('refuses a pull credential once its environment is deleted, terminated or redeployed twice', async () => {
    const attempt = () =>
      controller.issueTokenGet(basic('eve-pull', credential()), 'repository:shop-api:pull', 'eve-registry');

    environment = null;
    await expect(attempt()).rejects.toThrow(UnauthorizedException);

    environment = { project_id: 'proj_shop', status: 'terminated', registry_pull_epoch: 4 };
    await expect(attempt()).rejects.toThrow(UnauthorizedException);

    environment = { project_id: 'proj_shop', status: 'active', registry_pull_epoch: 6 };
    await expect(attempt()).rejects.toThrow(UnauthorizedException);

    environment = { project_id: 'proj_shop', status: 'active', registry_pull_epoch: 4 };
    project = null;
    await expect(attempt()).rejects.toThrow(UnauthorizedException);
    expect(db).not.toHaveBeenCalled();
  });

  it('rejects unknown credentials', async () => {
    await expect(
      controller.issueTokenGet(basic('eve-pull', 'not-a-credential'), 'repository:shop-api:pull', 'eve-registry'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(controller.issueTokenGet(undefined, 'repository:shop-api:pull', 'eve-registry')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('limits the internal POST endpoint the same way', async () => {
    const response = await controller.issueToken({
      scope: ['repository:shop-api:push,pull,delete', 'registry:catalog:*'],
      service: 'eve-registry',
    });
    expect(grantedAccess(response.token)).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['push', 'pull'] },
    ]);
  });
});

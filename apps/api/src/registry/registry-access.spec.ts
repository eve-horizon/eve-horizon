import { generateKeyPairSync } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintRegistryPullCredential, mintRegistryPushCredential } from '@eve/shared';
import {
  grantRegistryAccess,
  identifyRegistryCaller,
  isPullCredentialCurrent,
} from './registry-access.js';
import { RegistryTokenController } from './registry-token.controller.js';

const KEY = 'internal-key';
const PROJECT = 'proj_01hshop';
const PULL_CLAIMS = { projectId: PROJECT, environmentId: 'env_test', namespace: 'eve-acme-shop-test', epoch: 4 };
const projectCaller = { kind: 'project-pull' as const, ...PULL_CLAIMS };
const pushCaller = { kind: 'project-push' as const, projectId: PROJECT, expiresAt: 9_999_999_999 };

describe('identifyRegistryCaller', () => {
  it('recognises the internal key', () => {
    expect(identifyRegistryCaller(KEY, KEY)).toEqual({ kind: 'internal' });
  });

  it('recognises a pull credential', () => {
    expect(identifyRegistryCaller(mintRegistryPullCredential(PULL_CLAIMS, KEY), KEY)).toEqual(projectCaller);
  });

  it('recognises an unexpired push credential', () => {
    expect(identifyRegistryCaller(mintRegistryPushCredential(PROJECT, KEY), KEY)).toMatchObject({
      kind: 'project-push',
      projectId: PROJECT,
    });
    const expired = mintRegistryPushCredential(PROJECT, KEY, 1_000);
    expect(identifyRegistryCaller(expired, KEY)).toBeNull();
  });

  it('rejects anything else, and everything when no key is configured', () => {
    expect(identifyRegistryCaller('wrong', KEY)).toBeNull();
    expect(identifyRegistryCaller(undefined, KEY)).toBeNull();
    expect(identifyRegistryCaller(KEY, undefined)).toBeNull();
    expect(identifyRegistryCaller(mintRegistryPullCredential(PULL_CLAIMS, 'other-key'), KEY)).toBeNull();
  });
});

describe('isPullCredentialCurrent', () => {
  const liveEnv = { project_id: PROJECT, status: 'active', registry_pull_epoch: 4 };

  it('honours the current epoch and the one before it', () => {
    expect(isPullCredentialCurrent(projectCaller, liveEnv, true)).toBe(true);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, registry_pull_epoch: 5 }, true)).toBe(true);
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, status: 'suspended' }, true)).toBe(true);
  });

  it('refuses a superseded credential (two rewrites later) or one from the future', () => {
    expect(isPullCredentialCurrent(projectCaller, { ...liveEnv, registry_pull_epoch: 6 }, true)).toBe(false);
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
  const requested = [
    { type: 'repository', name: `${PROJECT}/api`, actions: ['pull', 'push'] },
    { type: 'repository', name: `${PROJECT}/acme/web`, actions: ['pull'] },
    { type: 'repository', name: 'proj_01hvictim/api', actions: ['pull', 'push'] },
    { type: 'repository', name: 'api', actions: ['pull'] },
    { type: 'repository', name: `${PROJECT}-evil/api`, actions: ['pull'] },
    { type: 'repository', name: `${PROJECT}/api`, actions: ['delete', '*'] },
    { type: 'registry', name: 'catalog', actions: ['*'] },
  ];

  it('gives internal callers push and pull on any repository, nothing else', () => {
    expect(grantRegistryAccess({ kind: 'internal' }, requested)).toEqual([
      { type: 'repository', name: `${PROJECT}/api`, actions: ['pull', 'push'] },
      { type: 'repository', name: `${PROJECT}/acme/web`, actions: ['pull'] },
      { type: 'repository', name: 'proj_01hvictim/api', actions: ['pull', 'push'] },
      { type: 'repository', name: 'api', actions: ['pull'] },
      { type: 'repository', name: `${PROJECT}-evil/api`, actions: ['pull'] },
    ]);
  });

  it('gives a build push and pull under its project prefix only', () => {
    expect(grantRegistryAccess(pushCaller, requested)).toEqual([
      { type: 'repository', name: `${PROJECT}/api`, actions: ['pull', 'push'] },
      { type: 'repository', name: `${PROJECT}/acme/web`, actions: ['pull'] },
    ]);
  });

  it('gives an environment pull only, under its project prefix only', () => {
    expect(grantRegistryAccess(projectCaller, requested)).toEqual([
      { type: 'repository', name: `${PROJECT}/api`, actions: ['pull'] },
      { type: 'repository', name: `${PROJECT}/acme/web`, actions: ['pull'] },
    ]);
  });
});

describe('RegistryTokenController GET /internal/registry/token', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  function basic(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  function payloadOf(token: string): { access: unknown; sub: string } {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  }

  let controller: RegistryTokenController;
  let environment: { project_id: string; status: string; registry_pull_epoch: number } | null;
  let project: { id: string } | null;
  const pullCredential = () => mintRegistryPullCredential(PULL_CLAIMS, KEY);

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/eve_test');
    vi.stubEnv('EVE_INTERNAL_API_KEY', KEY);
    vi.stubEnv('EVE_REGISTRY_SIGNING_KEY', signingKey);
    environment = { project_id: PROJECT, status: 'active', registry_pull_epoch: 4 };
    project = { id: PROJECT };
    controller = new RegistryTokenController(null as any);
    (controller as any).environments = { findById: vi.fn(async (id: string) => (id === 'env_test' ? environment : null)) };
    (controller as any).projects = { findById: vi.fn(async (id: string) => (id === PROJECT ? project : null)) };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('grants an environment pull credential pull under its project prefix only', async () => {
    const response = await controller.issueTokenGet(
      basic('eve-pull', pullCredential()),
      [`repository:${PROJECT}/api:pull,push`, 'repository:proj_01hvictim/api:pull', 'repository:api:pull'],
      'eve-registry',
    );
    const payload = payloadOf(response.token);
    expect(payload.access).toEqual([{ type: 'repository', name: `${PROJECT}/api`, actions: ['pull'] }]);
    expect(payload.sub).toBe(`eve-pull:${PROJECT}`);
  });

  it('grants a build push and pull under its project prefix only', async () => {
    const response = await controller.issueTokenGet(
      basic('eve-push', mintRegistryPushCredential(PROJECT, KEY)),
      [`repository:${PROJECT}/api:pull,push`, 'repository:proj_01hvictim/api:pull,push'],
      'eve-registry',
    );
    const payload = payloadOf(response.token);
    expect(payload.access).toEqual([{ type: 'repository', name: `${PROJECT}/api`, actions: ['pull', 'push'] }]);
    expect(payload.sub).toBe(`eve-push:${PROJECT}`);
  });

  it('refuses a pull credential once its environment is deleted, terminated or redeployed twice', async () => {
    const attempt = () =>
      controller.issueTokenGet(basic('eve-pull', pullCredential()), `repository:${PROJECT}/api:pull`, 'eve-registry');

    environment = null;
    await expect(attempt()).rejects.toThrow(UnauthorizedException);
    environment = { project_id: PROJECT, status: 'terminated', registry_pull_epoch: 4 };
    await expect(attempt()).rejects.toThrow(UnauthorizedException);
    environment = { project_id: PROJECT, status: 'active', registry_pull_epoch: 6 };
    await expect(attempt()).rejects.toThrow(UnauthorizedException);
    environment = { project_id: PROJECT, status: 'active', registry_pull_epoch: 4 };
    project = null;
    await expect(attempt()).rejects.toThrow(UnauthorizedException);
  });

  it('answers a scopeless login probe with an empty token', async () => {
    const response = await controller.issueTokenGet(basic('eve-pull', pullCredential()), undefined, 'eve-registry');
    expect(payloadOf(response.token).access).toEqual([]);
  });

  it('rejects unknown and expired credentials', async () => {
    await expect(
      controller.issueTokenGet(basic('eve-pull', 'not-a-credential'), 'repository:api:pull', 'eve-registry'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      controller.issueTokenGet(
        basic('eve-push', mintRegistryPushCredential(PROJECT, KEY, 1_000)),
        `repository:${PROJECT}/api:push`,
        'eve-registry',
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(controller.issueTokenGet(undefined, 'repository:api:pull', 'eve-registry')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('limits the internal POST endpoint to push and pull on repositories', async () => {
    const response = await controller.issueToken({
      scope: ['repository:shop-api:push,pull,delete', 'registry:catalog:*'],
      service: 'eve-registry',
    });
    expect(payloadOf(response.token).access).toEqual([
      { type: 'repository', name: 'shop-api', actions: ['push', 'pull'] },
    ]);
  });
});

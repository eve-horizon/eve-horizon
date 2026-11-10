import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ConflictException, HttpException } from '@nestjs/common';
import * as yaml from 'yaml';
import { ProjectsService } from './projects.service';
import { ProjectApisService } from './project-apis.service';
import { EnvironmentsService } from '../environments/environments.service';
import { ApiRegistrationService } from '../environments/api-registration.service';

// Two projects in one org whose slugs differ only in case ("shop" and
// "Shop") map to the same Kubernetes namespaces.

const SPEC = { openapi: '3.0.0', info: { title: 'shop', version: '1' }, paths: {} };

const net = vi.hoisted(() => ({ connections: [] as string[] }));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const request = (options: Record<string, any>, onResponse?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & Record<string, any>;
    req.end = () => {
      setImmediate(() => {
        net.connections.push(`${options.hostname}:${options.port ?? 80}${options.path ?? '/'}`);
        const res = Readable.from([Buffer.from(JSON.stringify(SPEC))], { objectMode: false }) as Readable & Record<string, any>;
        res.statusCode = 200;
        res.headers = {};
        onResponse?.(res);
      });
      return req;
    };
    req.destroy = () => req;
    return req;
  };
  return { ...actual, request, default: { ...actual, request } };
});

const db = vi.hoisted(() => ({
  projects: {
    findById: vi.fn(),
    findByOrgAndName: vi.fn(),
    findByOrgAndSlug: vi.fn(),
    listByOrgAndSlugIgnoringCase: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  orgs: { findById: vi.fn() },
  environments: { findByProjectAndName: vi.fn(), list: vi.fn() },
  manifests: { findLatestByProject: vi.fn(), findByProjectAndHash: vi.fn() },
  apiSources: { findByProjectEnvAndName: vi.fn(), upsert: vi.fn(), updateCachedSchema: vi.fn(), list: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  projectQueries: vi.fn(() => db.projects),
  orgQueries: vi.fn(() => db.orgs),
  environmentQueries: vi.fn(() => db.environments),
  projectManifestQueries: vi.fn(() => db.manifests),
  projectApiSourceQueries: vi.fn(() => db.apiSources),
  membershipQueries: vi.fn(() => ({})),
  userQueries: vi.fn(() => ({})),
  releaseQueries: vi.fn(() => ({})),
  agentConfigQueries: vi.fn(() => ({})),
  agentQueries: vi.fn(() => ({})),
  teamQueries: vi.fn(() => ({})),
  threadQueries: vi.fn(() => ({})),
  scheduleQueries: vi.fn(() => ({})),
  spendQueries: vi.fn(() => ({})),
  managedDbQueries: vi.fn(() => ({})),
  ingressAliasQueries: vi.fn(() => ({})),
}));

const project = (id: string, slug: string) => ({
  id,
  org_id: 'org_1',
  name: slug,
  slug,
  repo_url: 'https://github.com/acme/shop',
  branch: 'main',
  deleted_at: null,
  created_at: new Date('2026-11-10T00:00:00Z'),
  updated_at: new Date('2026-11-10T00:00:00Z'),
});

const lower = project('proj_lower', 'shop');
const upper = project('proj_upper', 'Shop');

const MANIFEST = yaml.stringify({
  services: { api: { image: 'example/api:1', ports: [3000], 'x-eve': { api_spec: { type: 'openapi', spec_url: '/openapi.json' } } } },
});

describe('project slugs that differ only in case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    net.connections.length = 0;
    db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
    db.projects.findByOrgAndName.mockResolvedValue(null);
    db.projects.findByOrgAndSlug.mockImplementation(async (_org: string, slug: string) =>
      [lower, upper].find((p) => p.slug === slug) ?? null);
    db.projects.listByOrgAndSlugIgnoringCase.mockImplementation(async (_org: string, slug: string) =>
      [lower, upper].filter((p) => p.slug.toLowerCase() === slug.toLowerCase()));
    db.projects.create.mockImplementation(async (data: { slug: string }) => project('proj_new', data.slug));
    db.projects.findById.mockImplementation(async (id: string) => [lower, upper].find((p) => p.id === id) ?? null);
    db.environments.findByProjectAndName.mockResolvedValue({ id: 'env_1', name: 'dev', namespace: null });
    db.environments.list.mockResolvedValue([]);
    db.manifests.findLatestByProject.mockResolvedValue({ manifest_yaml: MANIFEST });
    db.manifests.findByProjectAndHash.mockResolvedValue({ manifest_yaml: MANIFEST });
    db.apiSources.findByProjectEnvAndName.mockResolvedValue(null);
    db.apiSources.upsert.mockImplementation(async (row: Record<string, unknown>) => row);
    db.apiSources.updateCachedSchema.mockResolvedValue({});
  });

  describe('creating a project', () => {
    let service: ProjectsService;

    beforeEach(() => {
      // Only "shop" exists for these tests.
      db.projects.listByOrgAndSlugIgnoringCase.mockImplementation(async (_org: string, slug: string) =>
        slug.toLowerCase() === 'shop' ? [lower] : []);
      db.projects.findByOrgAndSlug.mockImplementation(async (_org: string, slug: string) => (slug === 'shop' ? lower : null));
      service = new ProjectsService({} as never, {} as never, {} as never);
      (service as any).assignOwner = vi.fn(async () => undefined);
    });

    it('refuses a slug that matches another project\'s slug ignoring case', async () => {
      await expect(service.create({ org_id: 'org_1', name: 'Shop two', slug: 'Shop', repo_url: 'https://github.com/acme/x', branch: 'main' }))
        .rejects.toBeInstanceOf(ConflictException);
      await expect(service.ensure({ org_id: 'org_1', name: 'Shop two', slug: 'SHOP', repo_url: 'https://github.com/acme/x', branch: 'main' }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(db.projects.create).not.toHaveBeenCalled();
    });

    it('still finds the existing project for the exact slug and creates new ones', async () => {
      await expect(service.ensure({ org_id: 'org_1', name: 'Shop', slug: 'shop', repo_url: 'https://github.com/acme/shop', branch: 'main' }))
        .resolves.toMatchObject({ id: 'proj_lower' });
      await expect(service.create({ org_id: 'org_1', name: 'Cart', slug: 'cart', repo_url: 'https://github.com/acme/cart', branch: 'main' }))
        .resolves.toMatchObject({ slug: 'cart' });
    });
  });

  describe('fetching API specs inside the cluster', () => {
    it('getSpec and refreshSpec refuse the shared namespace', async () => {
      const apis = new ProjectApisService({} as never);
      for (const call of [() => apis.getSpec('proj_upper', 'api', 'dev'), () => apis.refreshSpec('proj_upper', 'api', 'dev')]) {
        const error = await call().then(() => null, (err: unknown) => err);
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBeLessThan(500);
      }
      expect(net.connections).toEqual([]);
    });

    it('deploy-time registration fetches nothing from the shared namespace', async () => {
      const service = new EnvironmentsService(null as never, new ApiRegistrationService({} as never), {} as never, {} as never);
      await (service as any).registerComponentApis('proj_upper', 'dev', 'hash_1');
      expect(net.connections).toEqual([]);
      expect(db.apiSources.updateCachedSchema).not.toHaveBeenCalled();
    });

    it('still fetches when no other project shares the namespace', async () => {
      db.projects.listByOrgAndSlugIgnoringCase.mockResolvedValue([lower]);
      const apis = new ProjectApisService({} as never);
      await expect(apis.getSpec('proj_lower', 'api', 'dev')).resolves.toEqual(SPEC);
      expect(net.connections).toEqual(['dev-api.eve-acme-shop-dev.svc.cluster.local:3000/openapi.json']);
    });
  });
});

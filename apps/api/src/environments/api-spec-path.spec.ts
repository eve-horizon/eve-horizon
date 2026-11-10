import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsSync from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'yaml';
import { ApiRegistrationService } from './api-registration.service';
import { EnvironmentsService } from './environments.service';

const db = vi.hoisted(() => ({
  apiSources: { upsert: vi.fn(), updateCachedSchema: vi.fn() },
  manifests: { findByProjectAndHash: vi.fn() },
  projects: { findById: vi.fn() },
  orgs: { findById: vi.fn() },
  environments: { findByProjectAndName: vi.fn() },
}));

vi.mock('@eve/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eve/db')>()),
  projectApiSourceQueries: vi.fn(() => db.apiSources),
  projectManifestQueries: vi.fn(() => db.manifests),
  projectQueries: vi.fn(() => db.projects),
  orgQueries: vi.fn(() => db.orgs),
  environmentQueries: vi.fn(() => db.environments),
  releaseQueries: vi.fn(() => ({})),
  managedDbQueries: vi.fn(() => ({})),
  ingressAliasQueries: vi.fn(() => ({})),
}));

const SPEC = { openapi: '3.0.0', info: { title: 'shop', version: '1' }, paths: {} };

describe('spec_path reads', () => {
  let work: string;
  let repo: string;
  let outside: string;
  let registration: ApiRegistrationService;
  // Never let a test read an endless device: fail the read at once instead.
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    work = fsSync.mkdtempSync(path.join(os.tmpdir(), 'eve-spec-path-'));
    repo = path.join(work, 'repo');
    fsSync.mkdirSync(path.join(repo, 'api'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, 'api', 'openapi.json'), JSON.stringify(SPEC));
    outside = path.join(work, 'outside.json');
    fsSync.writeFileSync(outside, JSON.stringify({ outside: true }));
    fsSync.symlinkSync(outside, path.join(repo, 'api', 'linked.json'));
    fsSync.symlinkSync(work, path.join(repo, 'up'));
  });

  afterAll(() => {
    fsSync.rmSync(work, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', '');
    const realReadFile = fsp.readFile.bind(fsp);
    readFileSpy = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (String(file).startsWith('/dev/')) throw new Error('read of a device attempted');
      return (realReadFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as never);
    db.apiSources.upsert.mockImplementation(async (r: Record<string, unknown>) => r);
    db.apiSources.updateCachedSchema.mockResolvedValue({});
    registration = new ApiRegistrationService({} as never);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  const location = { baseUrl: 'http://dev-api.eve-acme-shop-dev.svc.cluster.local:3000', namespace: 'eve-acme-shop-dev', deployed: true };
  const register = (specPath: string, repoPath: string) =>
    registration.registerComponentApi(
      'proj_1', 'dev', 'api',
      { type: 'openapi', spec_path: specPath, on_deploy: true, auth: 'eve' },
      location,
      repoPath,
    );

  const failure = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err);

  it('reads a regular file inside the repo', async () => {
    await register('api/openapi.json', repo);
    expect(db.apiSources.updateCachedSchema).toHaveBeenCalledWith('proj_1', 'dev', 'api', SPEC);
  });

  it('refuses a device such as /dev/zero without reading it', async () => {
    expect(await failure(register('dev/zero', '/'))).toBeTruthy();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(db.apiSources.upsert).not.toHaveBeenCalled();
  });

  it('refuses a symlink to a file outside the repo', async () => {
    expect(await failure(register('api/linked.json', repo))).toBeTruthy();
    expect(db.apiSources.upsert).not.toHaveBeenCalled();
  });

  it('refuses a path through a symlinked directory outside the repo', async () => {
    expect(await failure(register('up/outside.json', repo))).toBeTruthy();
    expect(db.apiSources.upsert).not.toHaveBeenCalled();
  });

  it('refuses a path that climbs out of the repo', async () => {
    expect(await failure(register('../outside.json', repo))).toBeTruthy();
    expect(db.apiSources.upsert).not.toHaveBeenCalled();
  });

  it('refuses a file over the spec size limit without reading it', async () => {
    const big = path.join(repo, 'api', 'big.json');
    const handle = fsSync.openSync(big, 'w');
    fsSync.ftruncateSync(handle, 11 * 1024 * 1024);
    fsSync.closeSync(handle);
    readFileSpy.mockImplementation((async () => {
      throw new Error('read of an oversized file attempted');
    }) as never);

    const error = await failure(register('api/big.json', repo));
    expect(error).toBeTruthy();
    expect(String((error as Error).message)).not.toMatch(/attempted/);
  });

  describe('at deploy, through the project repo URL', () => {
    let service: EnvironmentsService;

    beforeEach(() => {
      db.orgs.findById.mockResolvedValue({ id: 'org_1', slug: 'acme' });
      db.environments.findByProjectAndName.mockResolvedValue({ id: 'env_1', name: 'dev', namespace: null });
      db.manifests.findByProjectAndHash.mockResolvedValue({
        manifest_yaml: yaml.stringify({
          services: {
            api: { image: 'example/api:1', ports: [3000], 'x-eve': { api_spec: { type: 'openapi', spec_path: 'api/openapi.json' } } },
          },
        }),
      });
      service = new EnvironmentsService(null as never, registration, {} as never, {} as never);
    });

    const deployWithRepo = (repoUrl: string) => {
      db.projects.findById.mockResolvedValue({ id: 'proj_1', org_id: 'org_1', slug: 'shop', repo_url: repoUrl });
      return (service as any).registerComponentApis('proj_1', 'dev', 'hash_1') as Promise<void>;
    };

    it('ignores a file:// repo URL unless the local development setting is on', async () => {
      await deployWithRepo('file:///');
      await deployWithRepo(pathToFileURL(repo).toString());
      expect(db.apiSources.upsert).not.toHaveBeenCalled();
    });

    it('reads spec_path from a file:// repo when the setting is on', async () => {
      vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', 'true');
      await deployWithRepo(pathToFileURL(repo).toString());
      expect(db.apiSources.updateCachedSchema).toHaveBeenCalledWith('proj_1', 'dev', 'api', SPEC);
    });
  });
});

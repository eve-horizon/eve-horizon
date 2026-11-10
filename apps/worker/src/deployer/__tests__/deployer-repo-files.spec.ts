import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeployerService } from '../deployer.service.js';

// x-eve.files and local secrets read files from a checkout of the tenant's
// repo. Only regular files inside that checkout may be read.

describe('DeployerService – files read from a repo checkout', () => {
  let work: string;
  let repo: string;
  let outsideFile: string;
  let outsideDir: string;
  let deployer: DeployerService;
  const createConfigMap = vi.fn(async () => undefined);

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-deployer-files-'));
    repo = path.join(work, 'repo');
    outsideDir = path.join(work, 'outside-dir');
    outsideFile = path.join(work, 'outside.txt');
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'db', 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'piped'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.eve'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'app.conf'), 'mode=prod\n');
    fs.writeFileSync(path.join(repo, 'db', 'migrations', '001_init.sql'), 'CREATE TABLE a (id int);\n');
    fs.writeFileSync(path.join(repo, 'db', 'migrations', '002_more.sql'), 'CREATE TABLE b (id int);\n');
    fs.writeFileSync(outsideFile, 'WORKER_TOKEN=from-the-worker\n');
    fs.writeFileSync(path.join(outsideDir, 'token'), 'from-the-worker\n');
    fs.symlinkSync('config/app.conf', path.join(repo, 'app-link.conf'));
    fs.symlinkSync(outsideFile, path.join(repo, 'out-link'));
    fs.symlinkSync(outsideDir, path.join(repo, 'out-dir'));
    fs.symlinkSync(outsideFile, path.join(repo, 'db', 'migrations', '003_link.sql'));
    execFileSync('mkfifo', [path.join(repo, 'pipe')]);
    execFileSync('mkfifo', [path.join(repo, 'piped', 'pipe')]);
    fs.writeFileSync(path.join(outsideDir, 'dev-secrets.yaml'), 'secrets:\n  WORKER_TOKEN: from-the-worker\n');
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', '');
    deployer = Object.create(DeployerService.prototype) as DeployerService;
    Object.assign(deployer as any, {
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      k8sService: { createConfigMap },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.join(repo, 'db', 'migrations', '003_link.sql'), { force: true });
    fs.symlinkSync(outsideFile, path.join(repo, 'db', 'migrations', '003_link.sql'));
  });

  const mount = (source: string) =>
    (deployer as any).resolveXeveFiles({ files: [{ source, target: '/mnt/x' }] }, repo, 'eve-acme-shop-dev', 'migrate-1a2b') as Promise<{
      configMapNames: string[];
    }>;

  const failure = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => err);

  describe('x-eve.files sources that are refused', () => {
    for (const [label, source] of [
      ['a path that climbs out of the repo', '../outside.txt'],
      ['a path that climbs to the worker process files', '../../../../../../proc/self/environ'],
      ['an absolute path', '/proc/self/environ'],
      ['an absolute path to a host file', '/etc/hosts'],
      ['a symlink to a file outside the repo', 'out-link'],
      ['a symlink to a directory outside the repo', 'out-dir'],
      ['a named pipe', 'pipe'],
      ['a directory holding a named pipe', 'piped'],
    ] as const) {
      it(`refuses ${label} and creates no ConfigMap`, async () => {
        const error = await failure(mount(source));
        expect(error).toBeInstanceOf(Error);
        expect(createConfigMap).not.toHaveBeenCalled();
      });
    }

    it('refuses a directory with a symlink that leads outside the repo', async () => {
      const error = await failure(mount('db/migrations'));
      expect(error).toBeInstanceOf(Error);
      expect(createConfigMap).not.toHaveBeenCalled();
    });
  });

  describe('x-eve.files sources that still work', () => {
    it('mounts a regular file inside the repo', async () => {
      await mount('config/app.conf');
      expect(createConfigMap).toHaveBeenCalledWith('eve-acme-shop-dev', expect.any(String), { 'app.conf': 'mode=prod\n' });
    });

    it('mounts an in-repo symlink to an in-repo file', async () => {
      await mount('app-link.conf');
      expect(createConfigMap).toHaveBeenCalledWith('eve-acme-shop-dev', expect.any(String), { 'app-link.conf': 'mode=prod\n' });
    });

    it('mounts the regular files of an in-repo directory', async () => {
      fs.rmSync(path.join(repo, 'db', 'migrations', '003_link.sql'));
      await mount('db/migrations');
      expect(createConfigMap).toHaveBeenCalledWith('eve-acme-shop-dev', expect.any(String), {
        '001_init.sql': 'CREATE TABLE a (id int);\n',
        '002_more.sql': 'CREATE TABLE b (id int);\n',
      });
    });
  });

  describe('local secrets', () => {
    const load = () => (deployer as any).loadLocalSecrets(repo, 'dev') as Promise<Map<string, string>>;

    afterEach(() => {
      fs.rmSync(path.join(repo, '.eve', 'dev-secrets.yaml'), { force: true, recursive: true });
    });

    it('refuses a dev-secrets file that is a symlink outside the repo', async () => {
      fs.symlinkSync(path.join(outsideDir, 'dev-secrets.yaml'), path.join(repo, '.eve', 'dev-secrets.yaml'));
      const result = await load().then((map) => map, (err: unknown) => err);
      expect(result).toBeInstanceOf(Error);
    });

    it('refuses a dev-secrets path that is a directory', async () => {
      fs.mkdirSync(path.join(repo, '.eve', 'dev-secrets.yaml'));
      const result = await load().then((map) => map, (err: unknown) => err);
      expect(result).toBeInstanceOf(Error);
    });

    it('reads an in-repo dev-secrets file', async () => {
      fs.writeFileSync(path.join(repo, '.eve', 'dev-secrets.yaml'), 'secrets:\n  API_KEY: local-value\n');
      await expect(load()).resolves.toEqual(new Map([['API_KEY', 'local-value']]));
    });
  });

  describe('file:// repo URLs', () => {
    const localPath = (repoUrl: string) => (deployer as any).extractLocalRepoPath(repoUrl) as string | undefined;

    it('are refused without the local development setting', () => {
      expect(() => localPath('file:///')).toThrow(/EVE_ALLOW_FILE_REPO_URLS/);
      expect(() => localPath('/srv/repo')).toThrow(/EVE_ALLOW_FILE_REPO_URLS/);
    });

    it('resolve to their checkout path with the setting on', () => {
      vi.stubEnv('EVE_ALLOW_FILE_REPO_URLS', 'true');
      expect(localPath('file:///work/shop')).toBe('/work/shop');
    });

    it('leave other repo URLs alone', () => {
      expect(localPath('https://github.com/acme/shop')).toBeUndefined();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkEnvironProtection,
  inspectEnvironExposure,
  PLATFORM_SECRET_ENV_KEYS,
  withoutPlatformSecrets,
  type EnvironExposureProbe,
} from '../process-isolation.js';
import { runGit } from '../invoke/git-utils.js';
import { GitWorkspace } from '../git/git-workspace.js';
import { tmpdir } from 'node:os';

const linux = (uid: number, owner: number | (() => number)): EnvironExposureProbe => ({
  platform: 'linux',
  getuid: () => uid,
  environOwner: typeof owner === 'function' ? owner : () => owner,
});

describe('inspectEnvironExposure', () => {
  it('reports a non-dumpable process (procfs owned by root) as protected', () => {
    expect(inspectEnvironExposure(linux(1000, 0))).toEqual({ status: 'protected' });
  });

  it('reports a dumpable process (procfs owned by its own UID) as exposed', () => {
    expect(inspectEnvironExposure(linux(1000, 1000))).toEqual({ status: 'exposed', uid: 1000 });
  });

  it('distinguishes root, where the ownership check proves nothing', () => {
    expect(inspectEnvironExposure(linux(0, 0))).toEqual({ status: 'root' });
  });

  it('skips platforms without procfs', () => {
    expect(inspectEnvironExposure({ platform: 'darwin', getuid: () => 501, environOwner: () => 501 }))
      .toEqual({ status: 'unsupported' });
    expect(inspectEnvironExposure(linux(1000, () => { throw new Error('ENOENT'); })))
      .toEqual({ status: 'unsupported' });
  });
});

describe('checkEnvironProtection', () => {
  const logger = () => ({ log: vi.fn(), warn: vi.fn() });

  it('logs protection and does not warn', () => {
    const l = logger();
    checkEnvironProtection(l, 'AGENT-RUNTIME', {}, linux(1000, 0));
    expect(l.log).toHaveBeenCalledWith(expect.stringContaining('non-dumpable'));
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('warns with the fix when exposed', () => {
    const l = logger();
    checkEnvironProtection(l, 'WORKER', {}, linux(1000, 1000));
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/UID 1000.*\/usr\/local\/libexec\/eve-node/));
  });

  it('refuses to start when protection is required and missing', () => {
    expect(() => checkEnvironProtection(logger(), 'WORKER', { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' }, linux(1000, 1000)))
      .toThrow(/Refusing to start/);
    expect(() => checkEnvironProtection(logger(), 'WORKER', { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' }, linux(0, 0)))
      .toThrow(/runs as root/);
    expect(() => checkEnvironProtection(logger(), 'WORKER', { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' }, linux(1000, 0)))
      .not.toThrow();
  });

  it('does not block local development on platforms without procfs', () => {
    expect(() => checkEnvironProtection(logger(), 'WORKER', { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' },
      { platform: 'darwin', getuid: () => 501, environOwner: () => 501 })).not.toThrow();
  });
});

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('on this Linux host', () => {
  it('reads real procfs: the test runner starts from a readable node binary, so it is dumpable', () => {
    expect(inspectEnvironExposure()).toEqual({ status: 'exposed', uid: process.getuid?.() });
  });
});

describe('helper children', () => {
  const saved = { db: process.env.DATABASE_URL, key: process.env.EVE_INTERNAL_API_KEY };
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://eve:pw@db/eve';
    process.env.EVE_INTERNAL_API_KEY = 'internal-key';
  });
  afterEach(() => {
    for (const [key, value] of [['DATABASE_URL', saved.db], ['EVE_INTERNAL_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('strips platform credentials and keeps everything else', () => {
    const env = withoutPlatformSecrets({ DATABASE_URL: 'x', EVE_INTERNAL_API_KEY: 'y', HTTPS_PROXY: 'p', PATH: '/bin' });
    expect(env).toEqual({ HTTPS_PROXY: 'p', PATH: '/bin' });
    expect(PLATFORM_SECRET_ENV_KEYS).toEqual(expect.arrayContaining(['DATABASE_URL', 'EVE_INTERNAL_API_KEY', 'EVE_SECRETS_MASTER_KEY']));
  });

  it('starts git without the service credentials in its environment', async () => {
    const { stdout } = await runGit(['-c', 'alias.showenv=!env', 'showenv']);
    const names = stdout.split('\n').map((line) => line.split('=')[0]);
    expect(names).not.toContain('DATABASE_URL');
    expect(names).not.toContain('EVE_INTERNAL_API_KEY');
    expect(names).toContain('PATH');
  });

  it('starts workspace git commands without the service credentials', async () => {
    const workspace = new GitWorkspace({ repoUrl: 'https://example.invalid/repo.git', workspacePath: tmpdir() });
    const { stdout } = await workspace.runGit(['-c', 'alias.showenv=!env', 'showenv'], { cwd: tmpdir() });
    const names = stdout.split('\n').map((line) => line.split('=')[0]);
    expect(names).not.toContain('DATABASE_URL');
    expect(names).not.toContain('EVE_INTERNAL_API_KEY');
  });
});

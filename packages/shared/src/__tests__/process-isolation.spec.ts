import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkProcessIsolation,
  inspectEnvironExposure,
  inspectInspectorExposure,
  SERVICE_HELPER_ENV_KEYS,
  serviceGitEnv,
  serviceHelperEnv,
  trustedPath,
  type DirStat,
  type EnvironExposureProbe,
  type InspectorProbe,
} from '../process-isolation.js';
import { runGit } from '../invoke/git-utils.js';
import { GitWorkspace } from '../git/git-workspace.js';

const linux = (uid: number, owner: number | (() => number)): EnvironExposureProbe => ({
  platform: 'linux',
  getuid: () => uid,
  environOwner: typeof owner === 'function' ? owner : () => owner,
});
const hardened: InspectorProbe = { execArgv: ['--disable-sigusr1'], nodeOptions: undefined, inspectorUrl: () => undefined };

/** What a service pod's environment looks like with `envFrom: eve-app` plus cloud wiring. */
const SERVICE_SECRETS: Record<string, string> = {
  DATABASE_URL: 'postgres://eve:pw@db/eve',
  EVE_INTERNAL_API_KEY: 'internal-key',
  EVE_SECRETS_MASTER_KEY: 'master-key',
  EVE_AUTH_PRIVATE_KEY: 'signing-key',
  GITHUB_TOKEN: 'gh-token',
  GHCR_TOKEN: 'ghcr-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
  EVE_SLACK_SIGNING_SECRET: 'slack-secret',
  SUPABASE_AUTH_DATABASE_URL: 'postgres://auth:pw@db/auth',
  EVE_STORAGE_SECRET_KEY: 'storage-key',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  AWS_SESSION_TOKEN: 'aws-session',
};

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

describe('inspectInspectorExposure', () => {
  it('accepts a service started with --disable-sigusr1 and no inspector', () => {
    expect(inspectInspectorExposure(hardened)).toEqual([]);
    expect(inspectInspectorExposure({ ...hardened, execArgv: [], nodeOptions: '--disable-sigusr1' })).toEqual([]);
  });

  it('flags SIGUSR1, --inspect flags and an open inspector', () => {
    expect(inspectInspectorExposure({ ...hardened, execArgv: [] })).toEqual([
      'started without --disable-sigusr1, so SIGUSR1 opens the inspector',
    ]);
    expect(inspectInspectorExposure({ ...hardened, execArgv: ['--disable-sigusr1', '--inspect=0.0.0.0:9229'] }))
      .toEqual(['started with --inspect=0.0.0.0:9229']);
    expect(inspectInspectorExposure({ ...hardened, nodeOptions: '--inspect-brk' }))
      .toEqual(['started with --inspect-brk']);
    expect(inspectInspectorExposure({ ...hardened, inspectorUrl: () => 'ws://127.0.0.1:9229/x' }))
      .toEqual(['has an open inspector']);
  });
});

describe('checkProcessIsolation', () => {
  const logger = () => ({ log: vi.fn(), warn: vi.fn() });

  it('logs protection and does not warn', () => {
    const l = logger();
    checkProcessIsolation(l, 'AGENT-RUNTIME', {}, { environ: linux(1000, 0), inspector: hardened });
    expect(l.log).toHaveBeenCalledWith(expect.stringContaining('non-dumpable with SIGUSR1 disabled'));
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('warns with the fix when exposed', () => {
    const l = logger();
    checkProcessIsolation(l, 'WORKER', {}, { environ: linux(1000, 1000), inspector: hardened });
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/UID 1000.*eve-node --disable-sigusr1/));
  });

  it('warns when the environ is protected but SIGUSR1 would still open the inspector', () => {
    const l = logger();
    checkProcessIsolation(l, 'WORKER', {}, { environ: linux(1000, 0), inspector: { ...hardened, execArgv: [] } });
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining('without --disable-sigusr1'));
  });

  it('refuses to start when protection is required and missing', () => {
    const strict = { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' };
    expect(() => checkProcessIsolation(logger(), 'WORKER', strict, { environ: linux(1000, 1000), inspector: hardened }))
      .toThrow(/Refusing to start/);
    expect(() => checkProcessIsolation(logger(), 'WORKER', strict, { environ: linux(0, 0), inspector: hardened }))
      .toThrow(/runs as root/);
    expect(() => checkProcessIsolation(logger(), 'WORKER', strict, { environ: linux(1000, 0), inspector: { ...hardened, execArgv: [] } }))
      .toThrow(/SIGUSR1/);
    expect(() => checkProcessIsolation(logger(), 'WORKER', strict, { environ: linux(1000, 0), inspector: hardened }))
      .not.toThrow();
  });

  it('does not block local development on platforms without procfs', () => {
    expect(() => checkProcessIsolation(logger(), 'WORKER', { EVE_REQUIRE_ENVIRON_PROTECTION: 'true' },
      { environ: { platform: 'darwin', getuid: () => 501, environOwner: () => 501 }, inspector: { ...hardened, execArgv: [] } }))
      .not.toThrow();
  });
});

describe.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('on this Linux host', () => {
  it('reads real procfs: the test runner starts from a readable node binary, so it is dumpable', () => {
    expect(inspectEnvironExposure()).toEqual({ status: 'exposed', uid: process.getuid?.() });
  });
});

describe('trustedPath', () => {
  const tree: Record<string, DirStat> = {
    '/': { uid: 0, mode: 0o755 },
    '/usr': { uid: 0, mode: 0o755 },
    '/usr/bin': { uid: 0, mode: 0o755 },
    '/usr/local': { uid: 0, mode: 0o755 },
    '/usr/local/bin': { uid: 0, mode: 0o755 },
    '/home': { uid: 0, mode: 0o755 },
    '/home/node': { uid: 1000, mode: 0o755 },
    '/home/node/.local': { uid: 1000, mode: 0o755 },
    '/home/node/.local/bin': { uid: 1000, mode: 0o755 },
    '/home/node/rootdir': { uid: 0, mode: 0o755 },
    '/opt': { uid: 0, mode: 0o755 },
    '/opt/shared': { uid: 0, mode: 0o777 },
    '/opt/group': { uid: 0, mode: 0o775 },
  };
  const statDir = (dir: string) => tree[dir];

  it('keeps only directories root alone can change, checking every ancestor', () => {
    const value = '/home/node/.local/bin:/usr/local/bin:/home/node/rootdir:/opt/shared:/opt/group:relative:/missing:/usr/bin:/usr/bin';
    expect(trustedPath(value, { platform: 'linux', statDir })).toBe('/usr/local/bin:/usr/bin');
  });

  it('leaves PATH alone outside Linux (local development)', () => {
    expect(trustedPath('/Users/me/bin:/usr/bin', { platform: 'darwin', statDir })).toBe('/Users/me/bin:/usr/bin');
  });
});

describe('serviceHelperEnv and serviceGitEnv', () => {
  const source = { ...SERVICE_SECRETS, PATH: '/usr/bin', HOME: '/home/node', HTTPS_PROXY: 'http://proxy:3128',
    KUBERNETES_SERVICE_HOST: '10.0.0.1', AWS_ROLE_ARN: 'arn:aws:iam::1:role/r', EVE_WORKER_FOO: 'x' };

  it('passes only allowlisted, credential-free keys plus per-call extras', () => {
    const env = serviceHelperEnv({ PGPASSWORD: 'one-call', DOCKER_CONFIG: undefined }, source, { platform: 'darwin' });
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/home/node', HTTPS_PROXY: 'http://proxy:3128',
      KUBERNETES_SERVICE_HOST: '10.0.0.1', AWS_ROLE_ARN: 'arn:aws:iam::1:role/r', PGPASSWORD: 'one-call',
    });
    for (const key of Object.keys(SERVICE_SECRETS)) expect(env).not.toHaveProperty(key);
  });

  it('never allowlists a credential-bearing key', () => {
    for (const key of SERVICE_HELPER_ENV_KEYS) {
      expect(key).not.toMatch(/SECRET|PASSWORD|DATABASE|TOKEN$|_KEY$|OAUTH|ACCESS_KEY/);
    }
  });

  it('makes git ignore global config and hooks', () => {
    expect(serviceGitEnv({ GIT_SSH_COMMAND: 'ssh -i /k' }, source, { platform: 'darwin' })).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
      GIT_SSH_COMMAND: 'ssh -i /k',
    });
  });
});

describe('service git children', () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'eve-svc-home-'));
    for (const [key, value] of Object.entries({ ...SERVICE_SECRETS, HOME: home })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function envNames(stdout: string): string[] {
    return stdout.split('\n').map((line) => line.split('=')[0]);
  }

  it('starts git without any service credential in its environment', async () => {
    const { stdout } = await runGit(['-c', 'alias.showenv=!env', 'showenv']);
    for (const key of Object.keys(SERVICE_SECRETS)) expect(envNames(stdout)).not.toContain(key);
    expect(envNames(stdout)).toContain('PATH');
  });

  it('starts workspace git commands without any service credential', async () => {
    const workspace = new GitWorkspace({ repoUrl: 'https://example.invalid/repo.git', workspacePath: tmpdir() });
    const { stdout } = await workspace.runGit(['-c', 'alias.showenv=!env', 'showenv'], { cwd: tmpdir() });
    for (const key of Object.keys(SERVICE_SECRETS)) expect(envNames(stdout)).not.toContain(key);
  });

  it('ignores a ~/.gitconfig planted by job code', async () => {
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = planted\n[alias]\n\tpwn = !touch pwned\n');
    await expect(runGit(['config', '--global', '--get', 'user.name'])).rejects.toThrow();
    await expect(runGit(['pwn'], { cwd: home })).rejects.toThrow();
    expect(existsSync(join(home, 'pwned'))).toBe(false);
  });

  it('runs no hook a job planted in the repository', async () => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    const marker = join(home, 'hook-ran');
    for (const dir of [join(repo, '.git', 'hooks'), join(repo, '.githooks')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(dir, 'pre-commit'), 0o755);
    }
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks']);
    writeFileSync(join(repo, 'file.txt'), 'x');
    await runGit(['add', 'file.txt'], { cwd: repo });
    await runGit(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], { cwd: repo });
    expect(existsSync(marker)).toBe(false);
  });
});

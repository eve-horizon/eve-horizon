import { describe, it, expect } from 'vitest';
import { buildSanitizedHarnessEnv, ALLOWED_SYSTEM_ENV_KEYS } from '../env-builder.js';

/**
 * Simulate a worker-like process.env with secrets that must NOT leak
 * into the harness process.
 */
const WORKER_PROCESS_ENV: Record<string, string | undefined> = {
  PATH: '/usr/bin:/usr/local/bin',
  HOME: '/home/worker',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  USER: 'worker',
  SHELL: '/bin/bash',
  TMPDIR: '/tmp',
  // Worker-internal secrets that must NOT reach the harness
  DATABASE_URL: 'postgres://user:pass@db:5432/eve',
  EVE_SECRETS_MASTER_KEY: 'master-key-0xDEADBEEF',
  EVE_INTERNAL_API_KEY: 'internal-api-key-secret',
  REDIS_URL: 'redis://redis:6379',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  // Other host env that shouldn't leak
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  NPM_TOKEN: 'npm-secret-token',
};

const BASE_PARAMS = {
  binPaths: ['/app/node_modules/.bin'],
  jobId: 'job_123',
  attemptId: 'att_456',
  projectId: 'proj_789',
  repoPath: '/workspace/repo',
  processEnv: WORKER_PROCESS_ENV,
};

describe('buildSanitizedHarnessEnv', () => {
  it('includes allowlisted system env vars', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);

    expect(env.HOME).toBe('/home/worker');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.USER).toBe('worker');
    expect(env.SHELL).toBe('/bin/bash');
    expect(env.TMPDIR).toBe('/tmp');
  });

  it('prepends binPaths to PATH', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);

    expect(env.PATH).toContain('/app/node_modules/.bin');
    expect(env.PATH).toContain('/usr/bin:/usr/local/bin');
  });

  it('includes job metadata', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);

    expect(env.EVE_JOB_ID).toBe('job_123');
    expect(env.EVE_ATTEMPT_ID).toBe('att_456');
    expect(env.EVE_PROJECT_ID).toBe('proj_789');
    expect(env.EVE_REPO_PATH).toBe('/workspace/repo');
    expect(env.CLAUDE_CODE_TEAM_NAME).toBe('att_456');
  });

  it('includes EVE_PARENT_JOB_ID when parentJobId is provided', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      parentJobId: 'parent_job_abc',
    });
    expect(env.EVE_PARENT_JOB_ID).toBe('parent_job_abc');
  });

  it('omits EVE_PARENT_JOB_ID when parentJobId is null', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      parentJobId: null,
    });
    expect(env).not.toHaveProperty('EVE_PARENT_JOB_ID');
  });

  it('omits EVE_PARENT_JOB_ID when parentJobId is not provided', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('EVE_PARENT_JOB_ID');
  });

  it('does NOT include DATABASE_URL', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('does NOT include EVE_SECRETS_MASTER_KEY', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('EVE_SECRETS_MASTER_KEY');
  });

  it('does NOT include EVE_INTERNAL_API_KEY', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('EVE_INTERNAL_API_KEY');
  });

  it('does NOT include any other process env secrets', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);

    expect(env).not.toHaveProperty('REDIS_URL');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env).not.toHaveProperty('NPM_TOKEN');
  });

  it('includes EVE_API_URL when eveApiUrl is provided', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      eveApiUrl: 'http://api.eve.lvh.me',
    });
    expect(env.EVE_API_URL).toBe('http://api.eve.lvh.me');
  });

  it('omits EVE_API_URL when eveApiUrl is not provided', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('EVE_API_URL');
  });

  it('includes EVE_ENV_NAME when envName is provided', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      envName: 'sandbox',
    });
    expect(env.EVE_ENV_NAME).toBe('sandbox');
  });

  it('omits EVE_ENV_NAME when envName is not provided', () => {
    const env = buildSanitizedHarnessEnv(BASE_PARAMS);
    expect(env).not.toHaveProperty('EVE_ENV_NAME');
  });

  it('includes EVE_RESOURCE_INDEX when resourceIndexPath is provided', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      resourceIndexPath: '/workspace/.eve/resources/index.json',
    });
    expect(env.EVE_RESOURCE_INDEX).toBe('/workspace/.eve/resources/index.json');
  });

  it('forwards adapter-provided env vars', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      adapterEnv: {
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      },
    });

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');
  });

  it('merges PATH with adapter PATH instead of clobbering it', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      adapterEnv: {
        PATH: '/custom/bin:/toolchain/bin',
        ANTHROPIC_API_KEY: 'sk-ant-yyy',
      },
    });

    expect(env.PATH).toContain('/app/node_modules/.bin');
    expect(env.PATH).toContain('/custom/bin');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-yyy');
  });

  it('does not leak process env when adapter env is empty', () => {
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      adapterEnv: {},
    });

    const keys = Object.keys(env);
    // Only system allowlist + job metadata + tracking should be present
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('EVE_SECRETS_MASTER_KEY');
  });

  it('uses actual process.env when processEnv param is not provided', () => {
    const env = buildSanitizedHarnessEnv({
      binPaths: [],
      jobId: 'j1',
      attemptId: 'a1',
      projectId: 'p1',
      repoPath: '/repo',
      // no processEnv — defaults to real process.env
    });

    // Should still have PATH from real env
    expect(env.PATH).toBeDefined();
    // And should NOT pick up arbitrary vars from real process.env
    // (the real process.env has many keys, but only allowlisted ones should appear)
    const allowedKeys = new Set([
      ...ALLOWED_SYSTEM_ENV_KEYS,
      'CLAUDE_CODE_TEAM_NAME',
      'EVE_JOB_ID',
      'EVE_ATTEMPT_ID',
      'EVE_PROJECT_ID',
      'EVE_REPO_PATH',
      'EVE_PARENT_JOB_ID',
      'EVE_API_URL',
      'EVE_ENV_NAME',
      'EVE_RESOURCE_INDEX',
      'EVE_JOB_USER_HOME',
    ]);
    for (const key of Object.keys(env)) {
      if (env[key] !== undefined) {
        expect(allowedKeys).toContain(key);
      }
    }
  });

  it('only contains keys from the allowlist, job metadata, and adapter env', () => {
    const adapterKeys = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'];
    const env = buildSanitizedHarnessEnv({
      ...BASE_PARAMS,
      eveApiUrl: 'http://api.eve.lvh.me',
      adapterEnv: {
        ANTHROPIC_API_KEY: 'key',
        CLAUDE_CONFIG_DIR: '/tmp/config',
      },
    });

    const expectedKeys = new Set([
      ...ALLOWED_SYSTEM_ENV_KEYS,
      'CLAUDE_CODE_TEAM_NAME',
      'EVE_JOB_ID',
      'EVE_ATTEMPT_ID',
      'EVE_PROJECT_ID',
      'EVE_REPO_PATH',
      'EVE_PARENT_JOB_ID',
      'EVE_API_URL',
      'EVE_ENV_NAME',
      'EVE_RESOURCE_INDEX',
      'EVE_JOB_USER_HOME',
      ...adapterKeys,
    ]);

    for (const key of Object.keys(env)) {
      if (env[key] !== undefined) {
        expect(expectedKeys).toContain(key);
      }
    }
  });

  // Phase 2: Per-job user home isolation tests
  describe('jobUserHome (Phase 2 secret isolation)', () => {
    it('overrides HOME with jobUserHome when provided', () => {
      const env = buildSanitizedHarnessEnv({
        ...BASE_PARAMS,
        jobUserHome: '/tmp/eve/agent-homes/att_456/home',
      });
      expect(env.HOME).toBe('/tmp/eve/agent-homes/att_456/home');
    });

    it('sets EVE_JOB_USER_HOME marker when jobUserHome is provided', () => {
      const env = buildSanitizedHarnessEnv({
        ...BASE_PARAMS,
        jobUserHome: '/tmp/eve/agent-homes/att_456/home',
      });
      expect(env.EVE_JOB_USER_HOME).toBe('/tmp/eve/agent-homes/att_456/home');
    });

    it('uses host HOME when jobUserHome is not provided', () => {
      const env = buildSanitizedHarnessEnv(BASE_PARAMS);
      expect(env.HOME).toBe('/home/worker');
      expect(env).not.toHaveProperty('EVE_JOB_USER_HOME');
    });

    it('does not set EVE_JOB_USER_HOME when jobUserHome is undefined', () => {
      const env = buildSanitizedHarnessEnv({
        ...BASE_PARAMS,
        jobUserHome: undefined,
      });
      expect(env).not.toHaveProperty('EVE_JOB_USER_HOME');
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  extractSecretRefs,
  interpolateEnvOverrides,
} from '../workspace-secrets.js';
import {
  applyEnvOverrides,
  MissingSecretOverrideError,
} from '../env-overrides.js';
import type { SecretResolveItem } from '../../schemas/secret.js';

function secret(key: string, value: string): SecretResolveItem {
  return {
    key,
    value,
    type: 'plain',
    resolved_at: 'project',
  } as SecretResolveItem;
}

describe('extractSecretRefs', () => {
  it('returns unique keys in first-seen order', () => {
    const raw = {
      A: '${secret.ONE}',
      B: 'prefix-${secret.TWO}-suffix',
      C: '${secret.ONE} and ${secret.THREE}',
    };
    expect(extractSecretRefs(raw)).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('returns empty array when no placeholders', () => {
    expect(extractSecretRefs({ A: 'literal', B: 'also literal' })).toEqual([]);
  });

  it('ignores malformed expressions (handled upstream by Zod)', () => {
    expect(extractSecretRefs({ A: '${env.FOO}', B: '${secret.OK}' })).toEqual(['OK']);
  });
});

describe('interpolateEnvOverrides', () => {
  it('resolves placeholders against secret map', () => {
    const secrets = [secret('BASE_URL', 'https://api.example'), secret('TOKEN', 'abc123')];
    const { resolved, missing } = interpolateEnvOverrides(
      { ANTHROPIC_BASE_URL: '${secret.BASE_URL}', AUTH: 'Bearer ${secret.TOKEN}' },
      secrets,
    );
    expect(resolved).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example',
      AUTH: 'Bearer abc123',
    });
    expect(missing).toEqual([]);
  });

  it('reports missing secrets without leaking values', () => {
    const { resolved, missing } = interpolateEnvOverrides(
      { X: '${secret.DOES_NOT_EXIST}' },
      [secret('OTHER', 'value')],
    );
    expect(missing).toEqual(['DOES_NOT_EXIST']);
    // Resolved value should be empty/blank for the missing portion — never the value of another secret.
    expect(resolved.X).toBe('');
  });

  it('deduplicates missing secret keys across multiple occurrences', () => {
    const { missing } = interpolateEnvOverrides(
      {
        A: '${secret.MISSING}',
        B: 'prefix ${secret.MISSING} suffix',
        C: '${secret.ALSO_MISSING}',
      },
      [],
    );
    expect(missing.sort()).toEqual(['ALSO_MISSING', 'MISSING']);
  });

  it('passes literal values through unchanged', () => {
    const { resolved } = interpolateEnvOverrides({ MODE: 'prod', N: '42' }, []);
    expect(resolved).toEqual({ MODE: 'prod', N: '42' });
  });

  it('throws when any non-secret ${...} expression survives (defence-in-depth)', () => {
    expect(() =>
      interpolateEnvOverrides({ X: '${env.FOO}' }, []),
    ).toThrow(/unsupported expression/);
  });

  it('does not allow secret values to reintroduce placeholders', () => {
    // If a resolved secret value contains ${...}, the post-resolution scan must
    // catch it — otherwise a secret whose value is '${secret.OTHER}' could chain.
    const secrets = [secret('EVIL', '${secret.OTHER}')];
    expect(() =>
      interpolateEnvOverrides({ X: '${secret.EVIL}' }, secrets),
    ).toThrow(/unsupported expression/);
  });
});

describe('applyEnvOverrides', () => {
  it('short-circuits empty overrides without mutating base env', async () => {
    const baseEnv = { BASE: '1' };
    const onMissingSecrets = vi.fn();

    const result = await applyEnvOverrides({
      envOverrides: null,
      resolvedSecrets: [],
      baseEnv,
      onMissingSecrets,
    });

    expect(result).toEqual({
      env: { BASE: '1' },
      appliedKeys: [],
      strippedKeys: [],
    });
    expect(result.env).not.toBe(baseEnv);
    expect(baseEnv).toEqual({ BASE: '1' });
    expect(onMissingSecrets).not.toHaveBeenCalled();

    await expect(applyEnvOverrides({
      envOverrides: undefined,
      resolvedSecrets: [],
      baseEnv,
    })).resolves.toMatchObject({ env: { BASE: '1' }, appliedKeys: [], strippedKeys: [] });
  });

  it('merges literal overrides into a fresh env', async () => {
    const baseEnv = { BASE: '1' };

    const result = await applyEnvOverrides({
      envOverrides: { FOO: 'bar' },
      resolvedSecrets: [],
      baseEnv,
    });

    expect(result.env).toEqual({ BASE: '1', FOO: 'bar' });
    expect(result.appliedKeys).toEqual(['FOO']);
    expect(result.strippedKeys).toEqual([]);
    expect(baseEnv).toEqual({ BASE: '1' });
  });

  it('resolves secret placeholders before merging', async () => {
    const result = await applyEnvOverrides({
      envOverrides: { FOO: '${secret.X}' },
      resolvedSecrets: [secret('X', 'resolved-value')],
      baseEnv: {},
    });

    expect(result.env.FOO).toBe('resolved-value');
    expect(result.env.FOO).not.toBe('${secret.X}');
    expect(result.appliedKeys).toEqual(['FOO']);
  });

  it('throws a typed error and relays missing secret keys once', async () => {
    const onMissingSecrets = vi.fn().mockResolvedValue(undefined);
    const baseEnv = { BASE: '1' };

    await expect(applyEnvOverrides({
      envOverrides: { FOO: '${secret.MISSING}' },
      resolvedSecrets: [],
      baseEnv,
      onMissingSecrets,
    })).rejects.toMatchObject({
      code: 'missing_secret_override',
      missing: ['MISSING'],
    });

    await expect(applyEnvOverrides({
      envOverrides: { FOO: '${secret.MISSING}' },
      resolvedSecrets: [],
      baseEnv,
    })).rejects.toBeInstanceOf(MissingSecretOverrideError);
    expect(onMissingSecrets).toHaveBeenCalledTimes(1);
    expect(onMissingSecrets).toHaveBeenCalledWith(['MISSING']);
    expect(baseEnv).toEqual({ BASE: '1' });
  });

  it('strips reserved keys defensively after interpolation', async () => {
    const result = await applyEnvOverrides({
      envOverrides: {
        PATH: '/evil',
        HOME: '/evil-home',
        EVE_API_URL: 'http://evil',
        CLAUDE_CONFIG_DIR: '/evil-claude',
        FOO: 'bar',
      },
      resolvedSecrets: [],
      baseEnv: { PATH: '/usr/bin', HOME: '/home/eve', EVE_API_URL: 'http://api' },
    });

    expect(result.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/eve',
      EVE_API_URL: 'http://api',
      FOO: 'bar',
    });
    expect(result.appliedKeys).toEqual(['FOO']);
    expect(result.strippedKeys).toEqual(['PATH', 'HOME', 'EVE_API_URL', 'CLAUDE_CONFIG_DIR']);
  });

  it('reports multiple missing secrets in declaration order', async () => {
    await expect(applyEnvOverrides({
      envOverrides: {
        FOO: '${secret.A}',
        BAR: '${secret.B}',
      },
      resolvedSecrets: [],
      baseEnv: {},
    })).rejects.toMatchObject({
      missing: ['A', 'B'],
    });
  });
});

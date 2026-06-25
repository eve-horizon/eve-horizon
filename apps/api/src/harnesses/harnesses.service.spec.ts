import { describe, expect, it } from 'vitest';
import { HarnessesService } from './harnesses.service.js';
import type { SecretsService } from '../secrets/secrets.service.js';

type ResolvedSecret = {
  key: string;
  value: string;
  type: 'env_var';
  scope_type: 'system' | 'org' | 'user' | 'project';
  scope_id: string;
};

function makeSecretsService(resolved: ResolvedSecret[]): SecretsService {
  return {
    resolveForProject: async () => resolved,
    resolveForOrg: async () => resolved.map(({ scope_type: _s, scope_id: _i, ...rest }) => rest),
  } as unknown as SecretsService;
}

describe('HarnessesService.validateInlineOverride', () => {
  it('reports ok=true for a known harness with resolved auth and no env_overrides', async () => {
    const secrets: ResolvedSecret[] = [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-1', type: 'env_var', scope_type: 'org', scope_id: 'org_1' },
    ];
    const service = new HarnessesService(makeSecretsService(secrets));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: { harness_profile_override: { harness: 'claude', model: 'claude-4-sonnet' } },
    });
    expect(result.harness.canonical).toBe('claude');
    expect(result.harness.auth?.available).toBe(true);
    expect(result.env_overrides).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('reports ok=false with canonical=null and a warning for an unknown harness', async () => {
    const service = new HarnessesService(makeSecretsService([]));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: { harness_profile_override: { harness: 'bogus' } },
    });
    expect(result.harness.canonical).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.code === 'harness.unknown')).toBe(true);
  });

  it('canonicalizes harness aliases (coder → code)', async () => {
    const secrets: ResolvedSecret[] = [
      { key: 'OPENAI_API_KEY', value: 'sk-openai-1', type: 'env_var', scope_type: 'project', scope_id: 'proj_1' },
    ];
    const service = new HarnessesService(makeSecretsService(secrets));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: { harness_profile_override: { harness: 'coder' } },
    });
    expect(result.harness.requested).toBe('coder');
    expect(result.harness.canonical).toBe('code');
  });

  it('reports missing secret refs with a remediation hint', async () => {
    const service = new HarnessesService(makeSecretsService([]));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: {
        harness_profile_override: { harness: 'claude' },
        env_overrides: { ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}' },
      },
    });
    expect(result.env_overrides).toHaveLength(1);
    expect(result.env_overrides[0].key).toBe('EDEN_TEST_BASE_URL');
    expect(result.env_overrides[0].status).toBe('missing');
    expect(result.env_overrides[0].hint).toMatch(/EDEN_TEST_BASE_URL/);
    expect(result.ok).toBe(false);
  });

  it('reports resolved scope for each resolved secret ref', async () => {
    const secrets: ResolvedSecret[] = [
      { key: 'ANTHROPIC_API_KEY', value: 'k', type: 'env_var', scope_type: 'org', scope_id: 'org_1' },
      { key: 'EDEN_TEST_BASE_URL', value: 'https://p', type: 'env_var', scope_type: 'project', scope_id: 'proj_1' },
    ];
    const service = new HarnessesService(makeSecretsService(secrets));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: {
        harness_profile_override: { harness: 'claude' },
        env_overrides: { ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}' },
      },
    });
    expect(result.env_overrides[0]).toMatchObject({
      key: 'EDEN_TEST_BASE_URL',
      status: 'resolved',
      resolved_at: 'project',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts env_overrides alone (no harness) and skips auth', async () => {
    const secrets: ResolvedSecret[] = [
      { key: 'EDEN_TEST_BASE_URL', value: 'https://p', type: 'env_var', scope_type: 'project', scope_id: 'proj_1' },
    ];
    const service = new HarnessesService(makeSecretsService(secrets));
    const result = await service.validateInlineOverride({
      projectId: 'proj_1',
      request: {
        env_overrides: { ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}' },
      },
    });
    expect(result.harness.requested).toBe('');
    expect(result.harness.canonical).toBeNull();
    expect(result.harness.auth).toBeNull();
    expect(result.ok).toBe(true);
  });
});

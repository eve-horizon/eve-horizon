import { describe, it, expect, vi } from 'vitest';
import {
  resolveHarnessProfile,
  type ResolverDeps,
} from '../profile-resolver.js';

function makeDeps(xEveYaml?: string, manifestYaml?: string): ResolverDeps {
  return {
    agentConfigs: {
      findLatestByProject: vi.fn().mockResolvedValue(xEveYaml ? { x_eve_yaml: xEveYaml } : null),
    },
    manifests: {
      findLatestByProject: vi.fn().mockResolvedValue(manifestYaml ? { manifest_yaml: manifestYaml } : null),
    },
    logger: { warn: vi.fn() },
  };
}

const X_EVE_YAML = `
agents:
  profiles:
    planner:
      - harness: claude
        model: claude-sonnet-4-6
        reasoning_effort: medium
    fast:
      - harness: zai
        model: glm-4.6
        temperature: 0.2
`;

const MANIFEST_YAML = `
name: test
x-eve:
  agents:
    profiles:
      manifest-only:
        - harness: gemini
          model: gemini-2.5-pro
`;

describe('resolveHarnessProfile — string ref (parity with legacy chat/workflow behavior)', () => {
  it('reads from agent_config.x_eve_yaml first', async () => {
    const deps = makeDeps(X_EVE_YAML, MANIFEST_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', stringRef: 'planner' });
    expect(result.harness).toBe('claude');
    expect(result.harness_options).toEqual({ model: 'claude-sonnet-4-6', reasoning_effort: 'medium' });
    expect(result.source).toBe('string_ref');
    expect(result.profile_name).toBe('planner');
    expect(result.profile_hash).not.toBeNull();
    expect(deps.manifests.findLatestByProject).not.toHaveBeenCalled();
  });

  it('falls back to manifest when agent_config has no profile', async () => {
    const deps = makeDeps(undefined, MANIFEST_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', stringRef: 'manifest-only' });
    expect(result.harness).toBe('gemini');
    expect(result.harness_options).toEqual({ model: 'gemini-2.5-pro' });
  });

  it('returns empty values with source=string_ref on unknown profile (matches legacy behavior)', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', stringRef: 'nonexistent' });
    expect(result.harness).toBeUndefined();
    expect(result.harness_options).toBeUndefined();
    expect(result.source).toBe('string_ref');
    expect(result.profile_name).toBe('nonexistent');
  });

  it('captures temperature when present', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', stringRef: 'fast' });
    expect(result.harness).toBe('zai');
    expect(result.harness_options).toEqual({ model: 'glm-4.6', temperature: 0.2 });
  });
});

describe('resolveHarnessProfile — agent default', () => {
  it('uses agent_default when stringRef is absent', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', agentDefault: 'planner' });
    expect(result.harness).toBe('claude');
    expect(result.source).toBe('agent_default');
    expect(result.profile_name).toBe('planner');
  });
});

describe('resolveHarnessProfile — inline override precedence', () => {
  it('inline override wins over stringRef and agent default', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      agentDefault: 'planner',
      stringRef: 'fast',
      inlineOverride: { harness: 'zai', model: 'glm-4.6', reasoning_effort: 'high' },
    });
    expect(result.harness).toBe('zai');
    expect(result.harness_options).toEqual({ model: 'glm-4.6', reasoning_effort: 'high' });
    expect(result.source).toBe('inline_override');
    expect(result.profile_name).toBeNull();
  });

  it('emits harness.profile.conflict warning when both stringRef and inline are set', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      stringRef: 'planner',
      inlineOverride: { harness: 'zai' },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('harness.profile.conflict');
    expect(result.source).toBe('inline_override');
  });

  it('no conflict warning when only inline override is present', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      inlineOverride: { harness: 'zai' },
    });
    expect(result.warnings).toHaveLength(0);
  });
});

describe('resolveHarnessProfile — workflow template precedence (highest)', () => {
  it('workflow template wins over inline + string + default', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      agentDefault: 'planner',
      stringRef: 'fast',
      inlineOverride: { harness: 'zai' },
      workflowTemplate: { harness: 'gemini', model: 'gemini-2.5-pro' },
    });
    expect(result.source).toBe('workflow_template');
    expect(result.harness).toBe('gemini');
  });
});

describe('resolveHarnessProfile — profile_hash stability', () => {
  it('same inputs produce the same hash', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const a = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      inlineOverride: { harness: 'zai', model: 'glm-4.6' },
      envOverrides: { FOO: '${secret.ONE}', BAR: 'literal' },
    });
    const b = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      inlineOverride: { harness: 'zai', model: 'glm-4.6' },
      envOverrides: { BAR: 'literal', FOO: '${secret.ONE}' }, // different insertion order
    });
    expect(a.profile_hash).toEqual(b.profile_hash);
  });

  it('hash changes when placeholder changes', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const a = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      envOverrides: { FOO: '${secret.ONE}' },
    });
    const b = await resolveHarnessProfile(deps, {
      projectId: 'proj_1',
      envOverrides: { FOO: '${secret.TWO}' },
    });
    expect(a.profile_hash).not.toEqual(b.profile_hash);
  });

  it('returns null hash when nothing is provided', async () => {
    const deps = makeDeps(X_EVE_YAML);
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1' });
    expect(result.profile_hash).toBeNull();
    expect(result.source).toBe('agent_default');
  });
});

describe('resolveHarnessProfile — malformed yaml safety', () => {
  it('tolerates broken yaml without throwing', async () => {
    const deps = makeDeps('::not: valid\n: yaml:');
    const result = await resolveHarnessProfile(deps, { projectId: 'proj_1', stringRef: 'planner' });
    expect(result.harness).toBeUndefined();
    expect(result.source).toBe('string_ref');
  });
});

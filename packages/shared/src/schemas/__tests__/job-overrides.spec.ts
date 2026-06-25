import { describe, expect, it } from 'vitest';
import { CreateJobRequestSchema, mergeEnvOverrides } from '../job.js';
import { ManifestSchema, getManifestRequiredSecrets } from '../manifest.js';
import { WorkflowInvokeRequestSchema } from '../workflow.js';

describe('CreateJobRequestSchema harness overrides', () => {
  it('accepts inline profile and secret-backed env overrides', () => {
    const parsed = CreateJobRequestSchema.safeParse({
      description: 'Run with override',
      harness_profile_override: {
        harness: 'zai',
        model: 'glm-4.6',
        reasoning_effort: 'medium',
      },
      env_overrides: {
        ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects reserved env override keys', () => {
    const parsed = CreateJobRequestSchema.safeParse({
      description: 'Invalid env',
      env_overrides: {
        EVE_JOB_TOKEN: '${secret.TOKEN}',
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message).join('\n')).toContain('reserved by Eve');
  });

  it('rejects unsupported env expressions', () => {
    const parsed = CreateJobRequestSchema.safeParse({
      description: 'Invalid expression',
      env_overrides: {
        PROVIDER_URL: '${env.PROVIDER_URL}',
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(issue => issue.message).join('\n')).toContain('only ${secret.KEY} is allowed');
  });

  it('rejects extra inline profile fields', () => {
    const parsed = CreateJobRequestSchema.safeParse({
      description: 'Invalid inline profile',
      harness_profile_override: {
        harness: 'zai',
        permission_policy: 'yolo',
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('workflow env_overrides schemas', () => {
  it('accepts workflow invoke request env overrides', () => {
    const parsed = WorkflowInvokeRequestSchema.safeParse({
      input: { topic: 'search' },
      env_overrides: {
        WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('preserves workflow-level and step-level env overrides in manifests', () => {
    const parsed = ManifestSchema.safeParse({
      name: 'test',
      workflows: {
        research: {
          env_overrides: {
            WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
          },
          steps: [
            {
              name: 'search',
              agent: { prompt: 'Search' },
              env_overrides: {
                STEP_API_KEY: '${secret.STEP_API_KEY}',
              },
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected manifest to parse');
    const workflow = parsed.data?.workflows?.research;
    expect(workflow?.env_overrides).toEqual({
      WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
    });
    expect(workflow?.steps?.[0]?.env_overrides).toEqual({
      STEP_API_KEY: '${secret.STEP_API_KEY}',
    });
  });

  it('rejects invalid workflow env override keys, reserved keys, oversize payloads, and unsupported expressions', () => {
    const oversizePayload = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`KEY_${index}`, 'x'.repeat(500)]),
    );
    const cases = [
      { bad_key: 'value' },
      { EVE_JOB_TOKEN: '${secret.TOKEN}' },
      { PROVIDER_URL: '${env.PROVIDER_URL}' },
      oversizePayload,
    ];

    for (const env_overrides of cases) {
      expect(WorkflowInvokeRequestSchema.safeParse({ env_overrides }).success).toBe(false);
      expect(ManifestSchema.safeParse({
        workflows: {
          invalid: {
            env_overrides,
            steps: [{ agent: { prompt: 'Run' } }],
          },
        },
      }).success).toBe(false);
    }
  });

  it('collects workflow env override secret refs as manifest required secrets', () => {
    const parsed = ManifestSchema.parse({
      'x-eve': {
        requires: {
          secrets: ['EXPLICIT_SECRET'],
        },
      },
      workflows: {
        research: {
          env_overrides: {
            WEB_SEARCH_API_KEY: '${secret.WEB_SEARCH_API_KEY}',
          },
          steps: [
            {
              name: 'search',
              agent: { prompt: 'Search' },
              requires: { secrets: ['STEP_REQUIRED'] },
              env_overrides: {
                STEP_API_KEY: '${secret.STEP_API_KEY}',
              },
            },
          ],
        },
      },
    });

    expect(getManifestRequiredSecrets(parsed).sort()).toEqual([
      'EXPLICIT_SECRET',
      'STEP_API_KEY',
      'STEP_REQUIRED',
      'WEB_SEARCH_API_KEY',
    ]);
  });

  it('merges workflow, step, and invocation env overrides with invocation precedence', () => {
    expect(mergeEnvOverrides(
      { GLOBAL_KEY: 'workflow', SHARED_KEY: 'workflow' },
      { STEP_KEY: 'step', SHARED_KEY: 'step' },
      { INVOCATION_KEY: '${secret.INVOCATION_KEY}', SHARED_KEY: 'invocation' },
    )).toEqual({
      GLOBAL_KEY: 'workflow',
      STEP_KEY: 'step',
      INVOCATION_KEY: '${secret.INVOCATION_KEY}',
      SHARED_KEY: 'invocation',
    });
  });

  it('returns null when merged env overrides are empty', () => {
    expect(mergeEnvOverrides(undefined, undefined, undefined)).toBeNull();
  });
});

describe('workflow token scope schemas', () => {
  it('accepts workflow invoke request scope and manifest workflow/step scopes', () => {
    expect(WorkflowInvokeRequestSchema.safeParse({
      scope: {
        orgfs: { allow_prefixes: ['/groups/projects/proj-a/**'] },
        cloud_fs: { allow_mount_ids: ['mount_a'] },
      },
    }).success).toBe(true);

    const parsed = ManifestSchema.safeParse({
      name: 'test',
      workflows: {
        scoped: {
          scope: {
            orgfs: { allow_prefixes: ['/groups/projects/proj-a/**'] },
          },
          steps: [
            {
              name: 'run',
              agent: { prompt: 'Run' },
              scope: {
                cloud_fs: { allow_mount_ids: ['mount_a'] },
              },
            },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected manifest to parse');
    expect(parsed.data.workflows?.scoped.scope).toEqual({
      orgfs: { allow_prefixes: ['/groups/projects/proj-a/**'] },
    });
    expect(parsed.data.workflows?.scoped.steps?.[0]?.scope).toEqual({
      cloud_fs: { allow_mount_ids: ['mount_a'] },
    });
  });

  it('rejects invalid workflow scope shapes', () => {
    expect(WorkflowInvokeRequestSchema.safeParse({
      scope: {
        cloud_fs: { allow_mount_ids: 'mount_a' },
      },
    }).success).toBe(false);

    expect(ManifestSchema.safeParse({
      name: 'test',
      workflows: {
        scoped: {
          steps: [
            {
              agent: { prompt: 'Run' },
              scope: { cloud_fs: { allow_mount_ids: 'mount_a' } },
            },
          ],
        },
      },
    }).success).toBe(false);
  });
});

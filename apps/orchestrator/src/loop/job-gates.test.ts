import { describe, expect, it } from 'vitest';
import type { Job } from '@eve/db';
import { resolveRequiredJobGates } from './job-gates';

function createJob(overrides: Partial<Job> = {}): Pick<Job, 'project_id' | 'env_name' | 'action_type' | 'git_json' | 'hints'> {
  return {
    project_id: 'proj_test',
    env_name: null,
    action_type: null,
    git_json: null,
    hints: {},
    ...overrides,
  };
}

describe('resolveRequiredJobGates', () => {
  it('does not add an env gate for ad-hoc jobs that only target an environment', () => {
    const gates = resolveRequiredJobGates(createJob({
      env_name: 'sandbox',
      action_type: null,
      hints: { gates: ['custom:gate'] },
    }));

    expect(gates).toEqual(['custom:gate']);
  });

  it('adds an env gate for action jobs targeting an environment', () => {
    const gates = resolveRequiredJobGates(createJob({
      env_name: 'sandbox',
      action_type: 'deploy',
    }));

    expect(gates).toEqual(['env:proj_test:sandbox']);
  });

  it('adds a branch gate when the job can write to git', () => {
    const gates = resolveRequiredJobGates(createJob({
      git_json: {
        branch: 'main',
        push: 'on_success',
      },
    }));

    expect(gates).toEqual(['git:branch:proj_test:main']);
  });

  it('does not add a branch gate for read-only git settings', () => {
    const gates = resolveRequiredJobGates(createJob({
      git_json: {
        branch: 'main',
        push: 'never',
        commit: 'manual',
      },
    }));

    expect(gates).toEqual([]);
  });
});

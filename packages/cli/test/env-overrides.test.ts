import { describe, expect, it } from 'vitest';
import {
  mergeEnvOverrides,
  parseEnvOverrideFlags,
} from '../src/lib/env-overrides';

describe('env override CLI helpers', () => {
  it('parses repeatable env-override flags and underscore aliases', () => {
    expect(parseEnvOverrideFlags({
      'env-override': ['A=1', 'B=2'],
      env_override: 'C=3',
    })).toEqual({
      A: '1',
      B: '2',
      C: '3',
    });
  });

  it('uses last write wins for duplicate keys', () => {
    expect(parseEnvOverrideFlags({
      'env-override': ['A=workflow', 'A=step'],
      env_override: 'A=invocation',
    })).toEqual({
      A: 'invocation',
    });
  });

  it('merges workflow, step, and invocation env overrides with invocation precedence', () => {
    expect(mergeEnvOverrides(
      { A: 'workflow', B: 'workflow' },
      { B: 'step', C: 'step' },
      { C: 'invocation', D: '${secret.API_KEY}' },
    )).toEqual({
      A: 'workflow',
      B: 'step',
      C: 'invocation',
      D: '${secret.API_KEY}',
    });
  });

  it('rejects invalid keys', () => {
    expect(() => parseEnvOverrideFlags({ 'env-override': 'lower=1' })).toThrow(/UPPER_SNAKE_CASE/);
  });
});

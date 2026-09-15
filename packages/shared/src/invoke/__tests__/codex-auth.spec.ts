import { describe, expect, it } from 'vitest';
import { selectedCodexAuth } from '../codex-auth.js';

describe('selectedCodexAuth', () => {
  it('records the key name and scope of the selected secret, never its value', () => {
    const selection = selectedCodexAuth('api_key', {
      key: 'OPENAI_API_KEY',
      value: 'sk-live-secret',
      type: 'env_var',
      scope_type: 'project',
      scope_id: 'proj_1',
    });

    expect(selection).toEqual({
      source: 'api_key',
      secret_key: 'OPENAI_API_KEY',
      scope_type: 'project',
      scope_id: 'proj_1',
    });
    expect(JSON.stringify(selection)).not.toContain('sk-live-secret');
  });

  it('omits scope fields the secret does not carry', () => {
    expect(selectedCodexAuth('auth_json', { key: 'CODEX_AUTH_JSON_B64' })).toStrictEqual({
      source: 'auth_json',
      secret_key: 'CODEX_AUTH_JSON_B64',
    });
  });

  it('records only the source when no secret backed the selection', () => {
    expect(selectedCodexAuth('preexisting')).toStrictEqual({ source: 'preexisting' });
  });
});

import { describe, expect, it } from 'vitest';
import { extractCodexAuthVerifyFacts } from '../src/commands/auth';

describe('eve auth verify --harness codex parsing', () => {
  it('reads the codex selection from a codex_auth_selected attempt log', () => {
    const facts = extractCodexAuthVerifyFacts([
      { type: 'system', line: { kind: 'init' } },
      {
        type: 'codex_auth_selected',
        line: {
          event: 'codex_auth_selected',
          harness: 'codex',
          source: 'api_key',
          secret_key: 'OPENAI_API_KEY',
          scope_type: 'project',
          scope_id: 'proj_1',
        },
      },
    ]);

    expect(facts.selected).toEqual({
      source: 'api_key',
      secret_key: 'OPENAI_API_KEY',
      scope_type: 'project',
      scope_id: 'proj_1',
    });
  });

  it('accepts a line whose event field names the selection', () => {
    const facts = extractCodexAuthVerifyFacts([
      { type: 'event', line: { event: 'codex_auth_selected', source: 'auth_json', secret_key: 'CODEX_AUTH_JSON_B64' } },
    ]);

    expect(facts.selected).toEqual({
      source: 'auth_json',
      secret_key: 'CODEX_AUTH_JSON_B64',
      scope_type: null,
      scope_id: null,
    });
  });

  it('nulls the fields a preexisting selection does not carry', () => {
    const facts = extractCodexAuthVerifyFacts([
      { type: 'codex_auth_selected', line: { event: 'codex_auth_selected', source: 'preexisting' } },
    ]);

    expect(facts.selected).toEqual({ source: 'preexisting', secret_key: null, scope_type: null, scope_id: null });
  });

  it('keeps the latest selection and ignores claude selection events', () => {
    const facts = extractCodexAuthVerifyFacts([
      { type: 'claude_auth_selected', line: { event: 'claude_auth_selected', source: 'secret', secret_key: 'CLAUDE_CODE_OAUTH_TOKEN' } },
      { type: 'codex_auth_selected', line: { source: 'auth_json', secret_key: 'CODEX_AUTH_JSON_B64' } },
      { type: 'codex_auth_selected', line: { source: 'oauth_access_token', secret_key: 'CODEX_OAUTH_ACCESS_TOKEN' } },
    ]);

    expect(facts.selected?.source).toBe('oauth_access_token');
    expect(facts.selected?.secret_key).toBe('CODEX_OAUTH_ACCESS_TOKEN');
  });

  it('reports no selection when the attempt never logged one', () => {
    expect(extractCodexAuthVerifyFacts([]).selected).toBeNull();
    expect(extractCodexAuthVerifyFacts([
      { type: 'claude_auth_selected', line: { event: 'claude_auth_selected', source: 'secret' } },
    ]).selected).toBeNull();
  });
});

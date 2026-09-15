import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
} from '../default-rate-card.js';
import { assembleAttemptReceiptV2, type ExecutionLogLike } from '../receipt/assemble-attempt-receipt.js';

function assemble(logs: ExecutionLogLike[]) {
  const now = new Date('2026-09-15T00:00:00.000Z');
  return assembleAttemptReceiptV2({
    job: {
      id: 'job_x',
      project_id: 'proj_x',
      created_at: now,
      ready_at: now,
      defer_until: null,
      phase: 'done',
      hints: null,
    },
    attempt: {
      id: 'att_x',
      job_id: 'job_x',
      started_at: new Date(now.getTime() + 1_000),
      execution_started_at: new Date(now.getTime() + 2_000),
      ended_at: new Date(now.getTime() + 12_000),
      duration_ms: null,
      runtime_meta: { runtime: 'k8s' },
    },
    org_id: 'org_x',
    logs,
    pricing: {
      rate_card: {
        name: DEFAULT_RATE_CARD_NAME,
        version: DEFAULT_RATE_CARD_VERSION,
        effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
        rates: DEFAULT_RATE_CARD_V1,
      },
      markup_pct: 0,
      billing_currency: 'usd',
      fx: null,
    },
  }).receipt;
}

describe('assembleAttemptReceiptV2 auth block', () => {
  it('records the codex credential selection from codex_auth_selected', () => {
    const receipt = assemble([
      {
        type: 'codex_auth_selected',
        content: {
          event: 'codex_auth_selected',
          harness: 'codex',
          source: 'api_key',
          secret_key: 'OPENAI_API_KEY',
          scope_type: 'project',
          scope_id: 'proj_x',
        },
      },
    ]);

    expect(receipt.auth).toEqual({
      harness: 'codex',
      source: 'api_key',
      secret_key: 'OPENAI_API_KEY',
      scope_type: 'project',
      scope_id: 'proj_x',
    });
  });

  it('records the claude credential selection from claude_auth_selected', () => {
    const receipt = assemble([
      {
        type: 'claude_auth_selected',
        content: {
          event: 'claude_auth_selected',
          harness: 'claude',
          selected: true,
          source: 'secret',
          secret_key: 'CLAUDE_CODE_OAUTH_TOKEN',
          scope_type: 'org',
          scope_id: 'org_x',
          token_class: 'setup-token',
          token_fingerprint: 'abcd',
        },
      },
    ]);

    expect(receipt.auth).toEqual({
      harness: 'claude',
      source: 'secret',
      secret_key: 'CLAUDE_CODE_OAUTH_TOKEN',
      scope_type: 'org',
      scope_id: 'org_x',
    });
  });

  it('nulls the fields a selection does not carry', () => {
    const receipt = assemble([
      { type: 'codex_auth_selected', content: { event: 'codex_auth_selected', harness: 'code', source: 'preexisting' } },
    ]);

    expect(receipt.auth).toEqual({
      harness: 'code',
      source: 'preexisting',
      secret_key: null,
      scope_type: null,
      scope_id: null,
    });
  });

  it('uses the latest selection event when several were logged', () => {
    const receipt = assemble([
      { type: 'codex_auth_selected', content: { harness: 'codex', source: 'auth_json', secret_key: 'CODEX_AUTH_JSON_B64' } },
      { type: 'lifecycle_secrets_log', content: { phase: 'secrets', action: 'log', meta: { kind: 'codex_auth_selected' } } },
      { type: 'codex_auth_selected', content: { harness: 'codex', source: 'api_key', secret_key: 'OPENAI_API_KEY' } },
    ]);

    expect(receipt.auth?.source).toBe('api_key');
    expect(receipt.auth?.secret_key).toBe('OPENAI_API_KEY');
  });

  it('leaves auth null when no selection event was logged', () => {
    expect(assemble([]).auth).toBeNull();
    expect(assemble([{ type: 'system', content: { kind: 'init' } }]).auth).toBeNull();
  });
});

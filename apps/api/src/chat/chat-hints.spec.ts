import { describe, expect, it } from 'vitest';
import { ChatService } from './chat.service.js';
import { ThreadChatRequestSchema } from '@eve/shared';
import type { Db } from '@eve/db';
import type { JobsService } from '../jobs/jobs.service.js';
import type { RbacService } from '../auth/rbac.service.js';

function makeService(): ChatService {
  // We only call private helpers that don't touch injected deps.
  return new ChatService(
    (() => ({})) as unknown as Db,
    {} as JobsService,
    {} as RbacService,
  );
}

type Priv = {
  resolveChatHints(data: { metadata?: Record<string, unknown>; hints?: Record<string, unknown> }): {
    harness_profile_override?: Record<string, unknown>;
    env_overrides?: Record<string, string>;
  };
  buildHarnessOverridesSnapshot(hints: {
    harness_profile_override?: Record<string, unknown>;
    env_overrides?: Record<string, string>;
  }): Record<string, unknown> | null;
  buildThreadMetadata(
    data: {
      provider: string;
      account_id: string;
      channel_id?: string;
      user_id?: string;
      metadata?: Record<string, unknown>;
    },
    existingMetadata: Record<string, unknown> | null,
    continuation?: unknown,
    hints?: {
      harness_profile_override?: Record<string, unknown>;
      env_overrides?: Record<string, string>;
    },
  ): Record<string, unknown>;
  matchRoute(
    routes: Array<{
      id: string;
      match: string;
      target: string;
      providers?: string[];
      account_ids?: string[];
    }>,
    defaultRoute: string | undefined,
    data: {
      provider: string;
      account_id: string;
      text: string;
    },
  ): { id: string } | null;
};

describe('ChatService chat hints', () => {
  it('keeps continuation hints through ThreadChatRequest validation', () => {
    const parsed = ThreadChatRequestSchema.parse({
      text: 'continue with codex',
      hints: { harness_profile_override: { harness: 'codex' } },
    });
    expect(parsed.hints?.harness_profile_override).toEqual({ harness: 'codex' });
  });

  it('reads harness_profile_override from the typed hints field', () => {
    const service = makeService() as unknown as Priv;
    const resolved = service.resolveChatHints({
      hints: { harness_profile_override: { harness: 'zai', model: 'glm-4.6' } },
    });
    expect(resolved.harness_profile_override).toEqual({ harness: 'zai', model: 'glm-4.6' });
  });

  it('falls back to legacy metadata.hints when typed hints is absent', () => {
    const service = makeService() as unknown as Priv;
    const resolved = service.resolveChatHints({
      metadata: { hints: { harness_profile_override: { harness: 'gemini' } } },
    });
    expect(resolved.harness_profile_override).toEqual({ harness: 'gemini' });
  });

  it('prefers typed hints over legacy metadata.hints when both are set', () => {
    const service = makeService() as unknown as Priv;
    const resolved = service.resolveChatHints({
      hints: { harness_profile_override: { harness: 'zai' } },
      metadata: { hints: { harness_profile_override: { harness: 'gemini' } } },
    });
    expect(resolved.harness_profile_override).toEqual({ harness: 'zai' });
  });

  it('returns an empty object when nothing is set', () => {
    const service = makeService() as unknown as Priv;
    const resolved = service.resolveChatHints({ metadata: { foo: 'bar' } });
    expect(resolved.harness_profile_override).toBeUndefined();
    expect(resolved.env_overrides).toBeUndefined();
  });

  it('builds a snapshot for thread metadata with placeholders intact', () => {
    const service = makeService() as unknown as Priv;
    const snapshot = service.buildHarnessOverridesSnapshot({
      harness_profile_override: { harness: 'zai', model: 'glm-4.6' },
      env_overrides: { ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}' },
    });
    expect(snapshot).toEqual({
      profile_override: { harness: 'zai', model: 'glm-4.6' },
      env_overrides: { ANTHROPIC_BASE_URL: '${secret.EDEN_TEST_BASE_URL}' },
    });
  });

  it('returns null when no override hints are present', () => {
    const service = makeService() as unknown as Priv;
    expect(service.buildHarnessOverridesSnapshot({})).toBeNull();
  });

  it('clears stale thread metadata when a later turn has no override hints', () => {
    const service = makeService() as unknown as Priv;
    const metadata = service.buildThreadMetadata(
      {
        provider: 'slack',
        account_id: 'T1',
        channel_id: 'C1',
        metadata: {},
      },
      {
        provider: 'slack',
        account_id: 'T1',
        harness_overrides: { profile_override: { harness: 'zai' } },
      },
      undefined,
      {},
    );
    expect(metadata.harness_overrides).toBeUndefined();
  });

  it('matches provider/account route predicates before falling back', () => {
    const service = makeService() as unknown as Priv;
    const route = service.matchRoute(
      [
        { id: 'slack_factory', match: '^factory', target: 'agent:slack', providers: ['slack'] },
        { id: 'app_factory', match: '^factory', target: 'agent:app', providers: ['app'], account_ids: ['designer'] },
        { id: 'route_default', match: '.*', target: 'agent:default' },
      ],
      'route_default',
      { provider: 'app', account_id: 'designer', text: 'factory layout' },
    );

    expect(route?.id).toBe('app_factory');
  });

  it('does not use an inapplicable default route', () => {
    const service = makeService() as unknown as Priv;
    const route = service.matchRoute(
      [
        { id: 'route_default', match: '.*', target: 'agent:default', providers: ['slack'] },
      ],
      'route_default',
      { provider: 'app', account_id: 'designer', text: 'hello' },
    );

    expect(route).toBeNull();
  });
});

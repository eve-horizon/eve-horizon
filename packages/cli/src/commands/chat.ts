import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type ChatRouteResponse = {
  thread_id: string;
  thread_key: string | null;
  route_id: string | null;
  target: string | null;
  job_ids: string[];
  event_id: string | null;
};

type GatewaySimulateResponse = {
  immediate_reply: { text: string; blocks?: unknown } | null;
  duplicate: boolean;
  route: {
    thread_id: string;
    thread_key: string | null;
    route_id: string | null;
    target: string | null;
    job_ids: string[];
    event_id: string | null;
    denied?: boolean;
    denial_reason?: string;
  } | null;
};

export async function handleChat(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'simulate': {
      const projectId = getStringFlag(flags, ['project']);
      const teamId = getStringFlag(flags, ['team-id']);
      const text = getStringFlag(flags, ['text']);

      // If --project is provided, use the legacy API simulate path
      if (projectId) {
        if (!teamId || !text) {
          throw new Error('Usage: eve chat simulate --project <id> --team-id <team> --text <message>');
        }
        process.stderr.write('⚠ --project routes through the legacy API simulate path. Use --team-id without --project for gateway routing.\n');
        const provider = getStringFlag(flags, ['provider']) ?? 'slack';
        const channelId = getStringFlag(flags, ['channel-id']);
        const userId = getStringFlag(flags, ['user-id']);
        const threadKey = getStringFlag(flags, ['thread-key']);
        const metadataFlag = getStringFlag(flags, ['metadata']);
        let metadata: Record<string, unknown> | undefined;
        if (metadataFlag) {
          try {
            const parsed = JSON.parse(metadataFlag);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed as Record<string, unknown>;
            }
          } catch {
            throw new Error('Invalid --metadata (must be JSON object)');
          }
        }

        const response = await requestJson<ChatRouteResponse>(
          context,
          `/projects/${projectId}/chat/simulate`,
          {
            method: 'POST',
            body: {
              provider,
              team_id: teamId,
              channel_id: channelId,
              user_id: userId,
              text,
              thread_key: threadKey,
              metadata,
            },
          },
        );
        outputJson(response, json, `✓ Chat simulated (thread: ${response.thread_id})`);
        return;
      }

      // Gateway simulate path (default)
      if (!teamId || !text) {
        throw new Error('Usage: eve chat simulate --team-id <team> --text <message>');
      }

      const provider = getStringFlag(flags, ['provider']) ?? 'slack';
      const channelId = getStringFlag(flags, ['channel-id']);
      const userId = getStringFlag(flags, ['user-id']);
      const threadId = getStringFlag(flags, ['thread-id', 'thread-key']);
      const externalEmail = getStringFlag(flags, ['external-email']);
      const dedupeKey = getStringFlag(flags, ['dedupe-key']);
      const eventType = getStringFlag(flags, ['event-type']);
      const metadataFlag = getStringFlag(flags, ['metadata']);

      // Extract external_email from --metadata for backward compat
      let metadataEmail: string | undefined;
      if (metadataFlag) {
        try {
          const parsed = JSON.parse(metadataFlag);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadataEmail = typeof parsed.external_email === 'string' ? parsed.external_email : undefined;
          }
        } catch {
          throw new Error('Invalid --metadata (must be JSON object)');
        }
      }

      const response = await requestJson<GatewaySimulateResponse>(
        context,
        '/gateway/providers/simulate',
        {
          method: 'POST',
          body: {
            provider,
            account_id: teamId,
            channel_id: channelId || undefined,
            user_id: userId || undefined,
            text,
            external_email: externalEmail ?? metadataEmail,
            event_type: eventType || undefined,
            thread_id: threadId || undefined,
            dedupe_key: dedupeKey || undefined,
          },
        },
      );

      // Normalize gateway response for output
      const normalized = {
        thread_id: response.route?.thread_id ?? null,
        thread_key: response.route?.thread_key ?? null,
        route_id: response.route?.route_id ?? null,
        target: response.route?.target ?? null,
        job_ids: response.route?.job_ids ?? [],
        event_id: response.route?.event_id ?? null,
        immediate_reply: response.immediate_reply,
        duplicate: response.duplicate,
      };

      const summary = response.duplicate
        ? '✓ Duplicate (deduplicated)'
        : response.route?.job_ids?.length
          ? `✓ Chat routed via gateway (thread: ${response.route.thread_id})`
          : response.immediate_reply
            ? `✓ Gateway reply: ${response.immediate_reply.text.slice(0, 80)}`
            : '✓ Chat simulated via gateway';

      outputJson(normalized, json, summary);
      return;
    }
    case 'send': {
      const threadId = getStringFlag(flags, ['thread']) ?? positionals[0];
      const text = getStringFlag(flags, ['text']);

      if (!threadId || !text) {
        throw new Error('Usage: eve chat send --thread <thread-id> --text <message>');
      }

      const actorId = getStringFlag(flags, ['actor-id']);
      const metadataFlag = getStringFlag(flags, ['metadata']);
      let metadata: Record<string, unknown> | undefined;
      if (metadataFlag) {
        try {
          const parsed = JSON.parse(metadataFlag);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          throw new Error('Invalid --metadata (must be JSON object)');
        }
      }

      const response = await requestJson<ChatRouteResponse>(
        context,
        `/threads/${threadId}/chat`,
        {
          method: 'POST',
          body: {
            text,
            actor_id: actorId ?? undefined,
            metadata,
          },
        },
      );

      outputJson(response, json, `✓ Chat sent to thread ${response.thread_id}`);
      return;
    }
    default:
      throw new Error('Usage: eve chat <simulate|send>');
  }
}

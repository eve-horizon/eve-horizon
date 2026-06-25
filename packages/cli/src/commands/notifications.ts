import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type NotificationSendResponse = {
  delivered: boolean;
  provider: 'slack';
  integration_id: string;
  channel: string;
  channel_id: string;
  message_ts?: string;
};

export async function handleNotifications(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'send': {
      const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      const channel = getStringFlag(flags, ['channel']);
      const message = getStringFlag(flags, ['message', 'text']) ?? positionals.join(' ').trim();
      const provider = getStringFlag(flags, ['provider']) ?? 'slack';
      const threadId = getStringFlag(flags, ['thread', 'thread-id', 'thread_id']);
      const integrationId = getStringFlag(flags, ['integration-id', 'integration_id']);

      if (!projectId || !channel || !message) {
        throw new Error(
          'Usage: eve notifications send --project <project> --channel <channel> --message <text> [--integration-id <id>]',
        );
      }
      if (provider !== 'slack') {
        throw new Error('Only --provider slack is currently supported');
      }

      const body: Record<string, unknown> = {
        provider,
        channel,
        message,
      };
      if (threadId) body.thread_id = threadId;
      if (integrationId) body.integration_id = integrationId;

      const response = await requestJson<NotificationSendResponse>(
        context,
        `/projects/${projectId}/notifications/send`,
        { method: 'POST', body },
      );

      outputJson(
        response,
        json,
        `Notification delivered to ${response.provider}:${response.channel_id}`,
      );
      return;
    }

    default:
      throw new Error(
        'Usage: eve notifications <send>\n' +
        '  send --project <project> --channel <channel> --message <text> [--integration-id <id>]',
      );
  }
}

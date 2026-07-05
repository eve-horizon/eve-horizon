import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

export async function handleWebhooks(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing --org flag or profile default org.');
  }

  switch (subcommand) {
    case 'create': {
      const url = getStringFlag(flags, ['url']);
      const events = typeof flags.events === 'string'
        ? flags.events.split(',').map((e) => e.trim()).filter(Boolean)
        : undefined;
      const secret = getStringFlag(flags, ['secret']);
      const filter = typeof flags.filter === 'string' ? flags.filter : undefined;
      const projectId = getStringFlag(flags, ['project']);

      if (!url || !events || events.length === 0 || !secret) {
        throw new Error(
          'Usage: eve webhooks create --org <org_id> --url <url> --events <evt1,evt2> --secret <secret> [--filter \'{"key":"val"}\'] [--project <id>]',
        );
      }

      const body: Record<string, unknown> = { url, events, secret };
      if (filter) {
        try {
          body.filter = JSON.parse(filter);
        } catch {
          throw new Error('--filter must be valid JSON');
        }
      }

      const basePath = projectId
        ? `/projects/${projectId}/webhooks`
        : `/orgs/${orgId}/webhooks`;

      const response = await requestJson(context, basePath, {
        method: 'POST',
        body,
      });
      outputJson(response, json, `Webhook created: ${(response as { id?: string }).id}`);
      return;
    }

    case 'list': {
      const response = await requestJson(context, `/orgs/${orgId}/webhooks`);
      outputJson(response, json);
      return;
    }

    case 'show': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks show <webhook_id> --org <org_id>');
      }
      const response = await requestJson(context, `/orgs/${orgId}/webhooks/${webhookId}`);
      outputJson(response, json);
      return;
    }

    case 'deliveries': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks deliveries <webhook_id> --org <org_id>');
      }
      const limit = typeof flags.limit === 'string' ? `?limit=${flags.limit}` : '';
      const response = await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}/deliveries${limit}`,
      );
      outputJson(response, json);
      return;
    }

    case 'test': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks test <webhook_id> --org <org_id>');
      }
      const response = await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}/test`,
        { method: 'POST' },
      );
      outputJson(response, json, 'Test event enqueued');
      return;
    }

    case 'delete': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks delete <webhook_id> --org <org_id>');
      }
      await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}`,
        { method: 'DELETE' },
      );
      outputJson({ ok: true }, json, `Webhook ${webhookId} deleted`);
      return;
    }

    case 'enable': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks enable <webhook_id> --org <org_id>');
      }
      const response = await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}/enable`,
        { method: 'PATCH' },
      );
      outputJson(response, json, `Webhook ${webhookId} enabled`);
      return;
    }

    case 'replay': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      if (!webhookId) {
        throw new Error('Usage: eve webhooks replay <webhook_id> --org <org_id> [--from-event <id>] [--to <iso>] [--max-events <n>] [--dry-run]');
      }

      const fromEvent = typeof flags['from-event'] === 'string' ? flags['from-event'] : undefined;
      const toTime = getStringFlag(flags, ['to']);
      const maxEvents = typeof flags['max-events'] === 'string'
        ? Number.parseInt(flags['max-events'], 10)
        : undefined;
      const dryRun = Boolean(flags['dry-run']);

      const body: Record<string, unknown> = {};
      if (fromEvent) {
        body.from = { event_id: fromEvent };
      }
      if (toTime) {
        body.to = { time: toTime };
      }
      if (Number.isFinite(maxEvents)) {
        body.max_events = maxEvents;
      }
      if (dryRun) {
        body.dry_run = true;
      }

      const response = await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}/replays`,
        { method: 'POST', body },
      );
      outputJson(response, json, dryRun ? 'Replay dry-run complete' : 'Replay created');
      return;
    }

    case 'replay-status': {
      const webhookId = positionals[0] ?? (getStringFlag(flags, ['webhook']));
      const replayId = positionals[1] ?? (getStringFlag(flags, ['replay']));
      if (!webhookId || !replayId) {
        throw new Error('Usage: eve webhooks replay-status <webhook_id> <replay_id> --org <org_id>');
      }

      const response = await requestJson(
        context,
        `/orgs/${orgId}/webhooks/${webhookId}/replays/${replayId}`,
      );
      outputJson(response, json);
      return;
    }

    default:
      throw new Error(
        'Usage: eve webhooks <create|list|show|deliveries|test|delete|enable|replay|replay-status>',
      );
  }
}

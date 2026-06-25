import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseCsv(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function resolveAgentSlug(flags: Record<string, FlagValue>): string {
  const agent = getStringFlag(flags, ['agent', 'agent-slug', 'agent_slug']);
  if (!agent) {
    throw new Error('Missing --agent <slug>');
  }
  return agent;
}

function resolveNamespace(flags: Record<string, FlagValue>): string {
  return getStringFlag(flags, ['namespace']) ?? 'default';
}

export async function handleKv(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }

  const agentSlug = resolveAgentSlug(flags);
  const namespace = resolveNamespace(flags);

  switch (subcommand) {
    case 'set': {
      const key = getStringFlag(flags, ['key']) ?? positionals[0];
      const rawValue = getStringFlag(flags, ['value']);
      if (!key || rawValue === undefined) {
        throw new Error('Usage: eve kv set --org <org> --agent <slug> --key <key> --value <json-or-string> [--namespace <ns>] [--ttl <seconds>]');
      }

      const ttlRaw = getStringFlag(flags, ['ttl', 'ttl-seconds', 'ttl_seconds']);
      const ttlSeconds = ttlRaw ? Number.parseInt(ttlRaw, 10) : undefined;
      if (ttlRaw && (!Number.isFinite(ttlSeconds) || ttlSeconds! <= 0)) {
        throw new Error(`Invalid TTL value: ${ttlRaw}`);
      }

      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          body: {
            value: parseJsonValue(rawValue),
            ttl_seconds: ttlSeconds,
          },
        },
      );
      outputJson(result, json, `KV value set: ${namespace}/${key}`);
      return;
    }

    case 'get': {
      const key = getStringFlag(flags, ['key']) ?? positionals[0];
      if (!key) {
        throw new Error('Usage: eve kv get --org <org> --agent <slug> --key <key> [--namespace <ns>]');
      }
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      );
      outputJson(result, json);
      return;
    }

    case 'list': {
      const limit = getStringFlag(flags, ['limit']);
      const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : '';
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/kv/${encodeURIComponent(namespace)}${suffix}`,
      );
      outputJson(result, json);
      return;
    }

    case 'mget': {
      const keysCsv = getStringFlag(flags, ['keys']) ?? positionals[0];
      if (!keysCsv) {
        throw new Error('Usage: eve kv mget --org <org> --agent <slug> --keys a,b,c [--namespace <ns>]');
      }
      const keys = parseCsv(keysCsv);
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/kv/${encodeURIComponent(namespace)}/mget`,
        {
          method: 'POST',
          body: { keys },
        },
      );
      outputJson(result, json);
      return;
    }

    case 'delete': {
      const key = getStringFlag(flags, ['key']) ?? positionals[0];
      if (!key) {
        throw new Error('Usage: eve kv delete --org <org> --agent <slug> --key <key> [--namespace <ns>]');
      }
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
        { method: 'DELETE' },
      );
      outputJson(result, json, `KV value deleted: ${namespace}/${key}`);
      return;
    }

    default:
      throw new Error(
        'Usage: eve kv <set|get|list|mget|delete>\n\n' +
        '  set    --org <org> --agent <slug> --key <key> --value <json-or-string> [--namespace <ns>] [--ttl <seconds>]\n' +
        '  get    --org <org> --agent <slug> --key <key> [--namespace <ns>]\n' +
        '  list   --org <org> --agent <slug> [--namespace <ns>] [--limit <n>]\n' +
        '  mget   --org <org> --agent <slug> --keys a,b,c [--namespace <ns>]\n' +
        '  delete --org <org> --agent <slug> --key <key> [--namespace <ns>]',
      );
  }
}

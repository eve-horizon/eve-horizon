import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

function parseCsv(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseConfidence(raw?: string): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid --confidence value: ${raw}`);
  }
  return value;
}

function parseFutureIsoOrDuration(raw: string, flagName: string): string {
  const trimmed = raw.trim();
  const durationMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (durationMatch) {
    const value = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const ms = unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
    return new Date(Date.now() + (value * ms)).toISOString();
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${flagName}: ${raw}. Use ISO timestamp or duration like 30d.`);
  }
  return date.toISOString();
}

function resolveAgentSlug(flags: Record<string, FlagValue>): string {
  if (flags.shared === true || flags.shared === 'true') {
    return 'shared';
  }
  const agent = getStringFlag(flags, ['agent', 'agent-slug', 'agent_slug']);
  if (!agent) {
    throw new Error('Provide --agent <slug> or --shared');
  }
  return agent;
}

export async function handleMemory(
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

  switch (subcommand) {
    case 'set': {
      const agentSlug = resolveAgentSlug(flags);
      const category = getStringFlag(flags, ['category']);
      const key = getStringFlag(flags, ['key']);
      if (!category || !key) {
        throw new Error('Usage: eve memory set --org <org> (--agent <slug>|--shared) --category <category> --key <key> (--file <path>|--stdin|--content <text>)');
      }

      const contentInline = getStringFlag(flags, ['content']);
      const filePath = getStringFlag(flags, ['file']);
      const useStdin = flags.stdin === true || flags.stdin === 'true';
      let content = '';

      if (contentInline !== undefined) {
        content = contentInline;
      } else if (filePath) {
        content = readFileSync(resolvePath(filePath), 'utf-8');
      } else if (useStdin) {
        content = readFileSync(0, 'utf-8');
      } else {
        throw new Error('Provide --file <path>, --stdin, or --content <text>');
      }

      const reviewIn = getStringFlag(flags, ['review-in', 'review_in']);
      const reviewDueRaw = getStringFlag(flags, ['review-due', 'review_due']);
      if (reviewIn && reviewDueRaw) {
        throw new Error('Specify only one of --review-in or --review-due');
      }
      const expiresIn = getStringFlag(flags, ['expires-in', 'expires_in']);
      const expiresAtRaw = getStringFlag(flags, ['expires-at', 'expires_at']);
      if (expiresIn && expiresAtRaw) {
        throw new Error('Specify only one of --expires-in or --expires-at');
      }
      const reviewDue = reviewDueRaw
        ? parseFutureIsoOrDuration(reviewDueRaw, '--review-due')
        : (reviewIn ? parseFutureIsoOrDuration(reviewIn, '--review-in') : undefined);
      const expiresAt = expiresAtRaw
        ? parseFutureIsoOrDuration(expiresAtRaw, '--expires-at')
        : (expiresIn ? parseFutureIsoOrDuration(expiresIn, '--expires-in') : undefined);

      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/memory`,
        {
          method: 'POST',
          body: {
            category,
            key,
            content,
            mime_type: getStringFlag(flags, ['mime-type', 'mime_type']) ?? undefined,
            confidence: parseConfidence(getStringFlag(flags, ['confidence'])),
            tags: parseCsv(getStringFlag(flags, ['tags'])),
            supersedes: getStringFlag(flags, ['supersedes']),
            lifecycle_status: getStringFlag(flags, ['lifecycle-status', 'lifecycle_status']),
            review_due: reviewDue,
            expires_at: expiresAt,
          },
        },
      );
      outputJson(result, json, `Memory entry saved: ${agentSlug}/${category}/${key}`);
      return;
    }

    case 'get': {
      const agentSlug = resolveAgentSlug(flags);
      const key = getStringFlag(flags, ['key']) ?? positionals[0];
      if (!key) {
        throw new Error('Usage: eve memory get --org <org> (--agent <slug>|--shared) --key <key> [--category <category>]');
      }
      const category = getStringFlag(flags, ['category']);
      const params = new URLSearchParams();
      if (category) params.set('category', category);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/memory/${encodeURIComponent(key)}${suffix}`,
      );
      outputJson(result, json);
      return;
    }

    case 'list': {
      const agentSlug = resolveAgentSlug(flags);
      const params = new URLSearchParams();
      const category = getStringFlag(flags, ['category']);
      const tags = getStringFlag(flags, ['tags']);
      const limit = getStringFlag(flags, ['limit']);
      if (category) params.set('category', category);
      if (tags) params.set('tags', tags);
      if (limit) params.set('limit', limit);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/memory${suffix}`,
      );
      outputJson(result, json);
      return;
    }

    case 'delete': {
      const agentSlug = resolveAgentSlug(flags);
      const key = getStringFlag(flags, ['key']) ?? positionals[0];
      const category = getStringFlag(flags, ['category']);
      if (!key || !category) {
        throw new Error('Usage: eve memory delete --org <org> (--agent <slug>|--shared) --category <category> --key <key>');
      }
      const result = await requestJson(
        context,
        `/orgs/${orgId}/agents/${agentSlug}/memory/${encodeURIComponent(key)}?category=${encodeURIComponent(category)}`,
        { method: 'DELETE' },
      );
      outputJson(result, json, `Memory entry deleted: ${agentSlug}/${category}/${key}`);
      return;
    }

    case 'search': {
      const query = getStringFlag(flags, ['query', 'q']) ?? positionals[0];
      if (!query) {
        throw new Error('Usage: eve memory search --org <org> --query <text> [--agent <slug>] [--limit <n>]');
      }
      const params = new URLSearchParams({ q: query });
      const limit = getStringFlag(flags, ['limit']);
      const agent = getStringFlag(flags, ['agent', 'agent-slug', 'agent_slug']);
      if (limit) params.set('limit', limit);
      if (agent) params.set('agent', agent);
      const result = await requestJson(
        context,
        `/orgs/${orgId}/memory/search?${params.toString()}`,
      );
      outputJson(result, json);
      return;
    }

    default:
      throw new Error(
        'Usage: eve memory <set|get|list|delete|search>\n\n' +
        '  set    --org <org> (--agent <slug>|--shared) --category <cat> --key <key> (--file <path>|--stdin|--content <text>)\n' +
        '  get    --org <org> (--agent <slug>|--shared) --key <key> [--category <cat>]\n' +
        '  list   --org <org> (--agent <slug>|--shared) [--category <cat>] [--tags a,b] [--limit <n>]\n' +
        '  delete --org <org> (--agent <slug>|--shared) --category <cat> --key <key>\n' +
        '  search --org <org> --query <text> [--agent <slug>] [--limit <n>]',
      );
  }
}

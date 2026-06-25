import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

export async function handleSearch(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;
  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }

  const query = getStringFlag(flags, ['query', 'q']) ?? positionals[0];
  if (!query) {
    throw new Error('Usage: eve search --org <org_id> --query <text> [--sources memory,docs,threads,attachments,events] [--limit <n>] [--agent <slug>]');
  }

  const params = new URLSearchParams({ q: query });
  const sources = getStringFlag(flags, ['sources']);
  const limit = getStringFlag(flags, ['limit']);
  const agent = getStringFlag(flags, ['agent', 'agent-slug', 'agent_slug']);
  if (sources) params.set('sources', sources);
  if (limit) params.set('limit', limit);
  if (agent) params.set('agent', agent);

  const result = await requestJson(
    context,
    `/orgs/${orgId}/search?${params.toString()}`,
  );
  outputJson(result, json);
}

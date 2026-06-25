import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type SuperviseResponse = {
  events: Array<{ type: string; job_id?: string; phase?: string; timestamp: string }>;
  children: Array<{ id: string; title: string; phase: string; assignee: string | null }>;
  inbox: Array<{ id: string; actor_id: string | null; body: string; created_at: string }>;
  cursor: string;
};

export async function handleSupervise(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const jobId = positionals[0] ?? process.env.EVE_JOB_ID;
  if (!jobId) {
    throw new Error('Usage: eve supervise [job-id] [--timeout <seconds>] [--since <cursor>] [--json]');
  }

  const timeout = getStringFlag(flags, ['timeout']) ?? '30';
  const since = getStringFlag(flags, ['since']);

  const params = new URLSearchParams();
  params.set('timeout', timeout);
  if (since) {
    params.set('since', since);
  }

  const result = await requestJson<SuperviseResponse>(
    context,
    `/jobs/${jobId}/supervise?${params.toString()}`,
  );

  if (json) {
    outputJson(result, true);
    return;
  }

  // Pretty print
  if (result.events.length === 0) {
    console.log('No new events (timeout).');
  } else {
    console.log(`${result.events.length} event(s):\n`);
    for (const evt of result.events) {
      const time = new Date(evt.timestamp).toLocaleTimeString();
      if (evt.type === 'child_update') {
        console.log(`  [child] ${evt.job_id} → ${evt.phase} (${time})`);
      } else if (evt.type === 'message') {
        console.log(`  [msg] ${time}`);
      } else {
        console.log(`  [${evt.type}] ${time}`);
      }
    }
  }

  if (result.children.length > 0) {
    console.log(`\nChildren (${result.children.length}):`);
    for (const child of result.children) {
      const assignee = child.assignee ? ` (${child.assignee})` : '';
      console.log(`  ${child.id} [${child.phase}]${assignee} ${child.title}`);
    }
  }

  if (result.inbox.length > 0) {
    console.log(`\nInbox (${result.inbox.length}):`);
    for (const msg of result.inbox) {
      const actor = msg.actor_id ?? 'unknown';
      const time = new Date(msg.created_at).toLocaleTimeString();
      console.log(`  ${time} ${actor}: ${msg.body.slice(0, 120)}`);
    }
  }

  console.log(`\nCursor: ${result.cursor}`);
}

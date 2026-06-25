import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

// ============================================================================
// Types
// ============================================================================

interface TriggerEvaluationEntry {
  type: string;
  name: string;
  matched: boolean;
  reason?: string;
}

interface Event {
  id: string;
  project_id: string;
  type: string;
  source: string;
  env_name?: string | null;
  ref_sha?: string | null;
  ref_branch?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  payload_json?: Record<string, unknown> | null;
  dedupe_key?: string | null;
  job_id?: string | null;
  trigger_match_count?: number | null;
  triggers_evaluated?: TriggerEvaluationEntry[] | null;
  status: string;
  processed_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface EventListResponse {
  data: Event[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleEvent(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
      return handleList(positionals, flags, context, json);

    case 'show':
      return handleShow(positionals, flags, context, json);

    case 'emit':
      return handleEmit(flags, context, json);

    default:
      throw new Error(
        'Usage: eve event <list|show|emit>\n' +
        '  list [project]                             - list events for a project\n' +
        '  show <event_id>                            - show details of an event\n' +
        '  emit --type=<type> --source=<source>       - emit a new event (for testing)',
      );
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * eve event list [project] [--type] [--source] [--status] [--limit] [--offset]
 * List events for a project
 */
async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve event list [project] [--project=<id>] [--type=<type>] [--source=<source>] [--status=<status>]');
  }

  const query = buildQuery({
    type: getStringFlag(flags, ['type']),
    source: getStringFlag(flags, ['source']),
    status: getStringFlag(flags, ['status']),
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<EventListResponse>(
    context,
    `/projects/${projectId}/events${query}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.data.length === 0) {
      console.log('No events found.');
      return;
    }
    formatEventsTable(response.data);
  }
}

/**
 * eve event show <event_id>
 * Show details of an event
 */
async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const eventId = positionals[0] ?? getStringFlag(flags, ['id', 'event']);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!eventId) {
    throw new Error('Usage: eve event show <event_id> [--id=<id>]');
  }

  if (!projectId) {
    throw new Error('Project ID is required. Use --project=<id> or set a default project in your profile.');
  }

  const response = await requestJson<Event>(
    context,
    `/projects/${projectId}/events/${eventId}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    formatEventDetails(response);
  }
}

/**
 * eve event emit --type=<type> --source=<source> [--env] [--payload]
 * Emit a new event (for testing)
 */
async function handleEmit(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const type = getStringFlag(flags, ['type']);
  const source = getStringFlag(flags, ['source']);

  if (!projectId) {
    throw new Error('Usage: eve event emit --project=<id> --type=<type> --source=<source> [options]');
  }

  if (!type) {
    throw new Error('--type is required (e.g., "doc.ingest" with --source system → "system.doc.ingest")');
  }

  if (!source) {
    throw new Error('--source is required (e.g., "github", "cron", "manual", "app", "system")');
  }

  // Auto-prefix event type with source when the source follows the prefix convention.
  // E.g., --type doc.ingest --source system → type becomes system.doc.ingest
  // This matches how events are created internally (e.g., ingest.service creates system.doc.ingest)
  const PREFIXED_SOURCES = ['system', 'github', 'slack'];
  let normalizedType = type;
  if (PREFIXED_SOURCES.includes(source) && !type.startsWith(`${source}.`)) {
    normalizedType = `${source}.${type}`;
    console.log(`  (Auto-prefixed type: ${type} → ${normalizedType})`);
  }

  const body: Record<string, unknown> = {
    type: normalizedType,
    source,
  };

  // Optional fields
  const envName = getStringFlag(flags, ['env', 'env-name']);
  if (envName) {
    body.env_name = envName;
  }

  const refSha = getStringFlag(flags, ['ref-sha', 'sha']);
  if (refSha) {
    body.ref_sha = refSha;
  }

  const refBranch = getStringFlag(flags, ['ref-branch', 'branch']);
  if (refBranch) {
    body.ref_branch = refBranch;
  }

  const actorType = getStringFlag(flags, ['actor-type']);
  if (actorType) {
    body.actor_type = actorType;
  }

  const actorId = getStringFlag(flags, ['actor-id', 'actor']);
  if (actorId) {
    body.actor_id = actorId;
  }

  const dedupeKey = getStringFlag(flags, ['dedupe-key']);
  if (dedupeKey) {
    body.dedupe_key = dedupeKey;
  }

  // Payload as JSON string
  const payloadStr = getStringFlag(flags, ['payload']);
  if (payloadStr) {
    try {
      body.payload_json = JSON.parse(payloadStr);
    } catch (error) {
      throw new Error(`Invalid JSON in --payload: ${(error as Error).message}`);
    }
  }

  const response = await requestJson<Event>(
    context,
    `/projects/${projectId}/events`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Event created: ${response.id}`);
    console.log(`  Type:     ${response.type}`);
    console.log(`  Source:   ${response.source}`);
    console.log(`  Status:   ${response.status}`);
    if (response.env_name) {
      console.log(`  Env:      ${response.env_name}`);
    }
    if (response.ref_sha) {
      console.log(`  SHA:      ${response.ref_sha}`);
    }
    if (response.ref_branch) {
      console.log(`  Branch:   ${response.ref_branch}`);
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build query string from parameters
 */
function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Format events as a human-readable table
 */
function formatEventsTable(events: Event[]): void {
  if (events.length === 0) {
    console.log('No events found.');
    return;
  }

  // Calculate column widths
  const idWidth = Math.max(8, ...events.map((e) => e.id.length));
  const typeWidth = Math.max(4, ...events.map((e) => e.type.length));
  const sourceWidth = Math.max(6, ...events.map((e) => e.source.length));
  const statusWidth = Math.max(6, ...events.map((e) => e.status.length));
  const jobIdWidth = Math.max(6, ...events.map((e) => (e.job_id || '-').length));

  // Header
  const header = [
    padRight('ID', idWidth),
    padRight('Type', typeWidth),
    padRight('Source', sourceWidth),
    padRight('Status', statusWidth),
    padRight('Triggers', 8),
    padRight('Job ID', jobIdWidth),
    padRight('Env', 12),
    padRight('Branch', 20),
    'Created',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const event of events) {
    const triggersCol = formatTriggersCompact(event);

    const row = [
      padRight(event.id, idWidth),
      padRight(event.type, typeWidth),
      padRight(event.source, sourceWidth),
      padRight(event.status, statusWidth),
      padRight(triggersCol, 8),
      padRight(event.job_id || '-', jobIdWidth),
      padRight(event.env_name || '-', 12),
      padRight(event.ref_branch || '-', 20),
      formatDate(event.created_at),
    ].join('  ');

    console.log(row);
  }

  console.log('');
  console.log(`Total: ${events.length} event(s)`);
}

/**
 * Format a single event's details
 */
function formatEventDetails(event: Event): void {
  console.log(`Event: ${event.id}`);
  console.log('');
  console.log(`  Project:      ${event.project_id}`);
  console.log(`  Type:         ${event.type}`);
  console.log(`  Source:       ${event.source}`);
  console.log(`  Status:       ${event.status}`);

  if (event.env_name) {
    console.log(`  Environment:  ${event.env_name}`);
  }

  if (event.ref_sha) {
    console.log(`  Ref SHA:      ${event.ref_sha}`);
  }

  if (event.ref_branch) {
    console.log(`  Ref Branch:   ${event.ref_branch}`);
  }

  if (event.actor_type) {
    console.log(`  Actor Type:   ${event.actor_type}`);
  }

  if (event.actor_id) {
    console.log(`  Actor ID:     ${event.actor_id}`);
  }

  if (event.dedupe_key) {
    console.log(`  Dedupe Key:   ${event.dedupe_key}`);
  }

  if (event.job_id) {
    console.log(`  Job ID:       ${event.job_id}`);
  }

  // Trigger evaluation metadata
  if (event.trigger_match_count != null) {
    const evalCount = event.triggers_evaluated?.length ?? 0;
    console.log(`  Triggers:     matched ${event.trigger_match_count} of ${evalCount} evaluated`);
  }

  if (event.triggers_evaluated && event.triggers_evaluated.length > 0) {
    console.log('');
    console.log('  Trigger Evaluations:');
    for (const te of event.triggers_evaluated) {
      const status = te.matched ? 'MATCHED' : 'no match';
      const reason = te.reason ? ` (${te.reason})` : '';
      console.log(`    ${te.type}:${te.name} - ${status}${reason}`);
    }
  }

  if (event.payload_json && Object.keys(event.payload_json).length > 0) {
    console.log('');
    console.log('  Payload:');
    console.log(`    ${JSON.stringify(event.payload_json, null, 2).split('\n').join('\n    ')}`);
  }

  console.log('');
  console.log(`  Created:      ${formatDate(event.created_at)}`);
  console.log(`  Updated:      ${formatDate(event.updated_at)}`);

  if (event.processed_at) {
    console.log(`  Processed:    ${formatDate(event.processed_at)}`);
  }
}

/**
 * Format trigger match info as a compact column value (e.g., "1/3", "-")
 */
function formatTriggersCompact(event: Event): string {
  if (event.trigger_match_count == null) return '-';
  const evalCount = event.triggers_evaluated?.length ?? 0;
  return `${event.trigger_match_count}/${evalCount}`;
}

/**
 * Format a date string for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString();
  } catch {
    return dateStr;
  }
}

/**
 * Pad a string to the right with spaces
 */
function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

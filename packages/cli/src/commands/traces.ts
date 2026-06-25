import type { FlagValue } from '../lib/args';
import { getStringFlag, toBoolean } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

type TraceSpan = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name: string;
  service?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration_ms?: number | null;
  error?: boolean;
  fault?: boolean;
  throttle?: boolean;
};

type TraceQueryResponse = {
  project_id: string;
  service?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  backend: string;
  backend_available: boolean;
  traces: Array<{
    trace_id: string;
    duration_ms?: number | null;
    response_time_ms?: number | null;
    has_error?: boolean;
    spans: TraceSpan[];
  }>;
  summary: {
    trace_count: number;
    span_count: number;
    p99_ms?: number | null;
  };
  warnings?: string[];
};

export async function handleTraces(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  switch (subcommand) {
    case 'query':
      return handleQuery(positionals, flags, context);
    default:
      throw new Error(
        'Usage: eve traces query [--project <id>] [--service <name>] (--request-id <id>|--trace-id <id>|--since <duration>|--error|--route <route>) [--json]',
      );
  }
}

async function handleQuery(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    throw new Error('Usage: eve traces query --project <id> [options]');
  }

  const requestId = getStringFlag(flags, ['request-id', 'request']);
  const traceId = getStringFlag(flags, ['trace-id']);
  const since = getStringFlag(flags, ['since']);
  const route = getStringFlag(flags, ['route']);
  const error = toBoolean(flags.error) ?? false;

  if (!requestId && !traceId && !since && !route && !error) {
    throw new Error('Provide --request-id, --trace-id, --since, --route, or --error');
  }

  const query = buildQuery({
    service: getStringFlag(flags, ['service']) ?? positionals[0],
    request_id: requestId,
    trace_id: traceId,
    since,
    error: error || undefined,
    route,
    p99: toBoolean(flags.p99) ?? undefined,
    limit: getStringFlag(flags, ['limit']),
    no_cache: toBoolean(flags['no-cache']) ?? toBoolean(flags.no_cache) ?? undefined,
  });

  const response = await requestJson<TraceQueryResponse>(
    context,
    `/projects/${projectId}/traces/query${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  formatTraceQuery(response);
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

function formatTraceQuery(response: TraceQueryResponse): void {
  console.log('Trace Query');
  console.log('');
  console.log(`  Project: ${response.project_id}`);
  if (response.service) console.log(`  Service: ${response.service}`);
  if (response.request_id) console.log(`  Request: ${response.request_id}`);
  if (response.trace_id) console.log(`  Trace:   ${response.trace_id}`);
  console.log(`  Backend: ${response.backend}${response.backend_available ? '' : ' (unavailable)'}`);
  console.log(`  Results: ${response.summary.trace_count} trace(s), ${response.summary.span_count} span(s)`);
  if (typeof response.summary.p99_ms === 'number') {
    console.log(`  P99:     ${formatMs(response.summary.p99_ms)}`);
  }

  if (response.warnings?.length) {
    console.log('');
    console.log('Warnings:');
    for (const warning of response.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  for (const trace of response.traces) {
    console.log('');
    console.log(`${trace.trace_id} ${trace.has_error ? '(error)' : ''}`.trim());
    if (typeof trace.duration_ms === 'number') {
      console.log(`  Duration: ${formatMs(trace.duration_ms)}`);
    }
    for (const span of trace.spans) {
      const flags = [span.error ? 'error' : '', span.fault ? 'fault' : '', span.throttle ? 'throttle' : '']
        .filter(Boolean)
        .join(',');
      const suffix = flags ? ` [${flags}]` : '';
      console.log(`  - ${span.name} ${formatMs(span.duration_ms)}${suffix}`);
    }
  }
}

function formatMs(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'n/a';
  }
  return `${Math.round(value)}ms`;
}

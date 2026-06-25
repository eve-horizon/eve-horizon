import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';

// ── Response shapes ────────────────────────────────────────────────

interface PipelineStats {
  runs: number;
  success_rate: number;
  avg_duration_seconds?: number;
  avg_duration_s?: number;
}

interface AnalyticsSummary {
  as_of: string;
  window: string;
  projects: number;
  jobs: { created: number; completed: number; failed: number; active: number };
  pipelines: PipelineStats;
  environments: { total: number; healthy: number; degraded: number; unknown: number };
}

interface JobAnalytics {
  as_of: string;
  created: number;
  completed: number;
  failed: number;
  active: number;
}

interface PipelineAnalytics {
  as_of: string;
  runs: number;
  success_rate: number;
  avg_duration_seconds?: number;
  avg_duration_s?: number;
}

interface EnvHealthAnalytics {
  as_of: string;
  total: number;
  healthy: number;
  degraded: number;
  unknown: number;
}

// ── Formatting helpers ─────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function pad(label: string, value: string | number, width = 12): string {
  return `  ${label.padEnd(width)}${value}`;
}

function parseAvgDurationSeconds(stats: PipelineStats): number {
  return stats.avg_duration_seconds ?? stats.avg_duration_s ?? 0;
}

// ── Subcommand handlers ────────────────────────────────────────────

async function analyticsSummary(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  orgId: string,
): Promise<void> {
  const json = Boolean(flags.json);
  const window = getStringFlag(flags, ['window']) ?? '7d';

  const data = await requestJson<AnalyticsSummary>(
    context,
    `/orgs/${orgId}/analytics/summary?window=${encodeURIComponent(window)}`,
  );

  if (json) {
    outputJson(data, true);
    return;
  }

  const { jobs, pipelines, environments } = data;

  console.log(`Org Analytics Summary (${data.window || window} window)`);
  console.log('\u2550'.repeat(36));
  console.log(pad('As of:', data.as_of));
  console.log(pad('Projects:', data.projects));
  console.log('');
  console.log('Jobs');
  console.log(pad('Created:', jobs.created));
  console.log(pad('Completed:', jobs.completed));
  console.log(pad('Failed:', jobs.failed));
  console.log(pad('Active:', jobs.active));
  console.log('');
  console.log('Pipelines');
  console.log(pad('Runs:', pipelines.runs));
  console.log(pad('Success Rate:', `${pipelines.success_rate.toFixed(1)}%`));
  console.log(pad('Avg Duration:', formatDuration(parseAvgDurationSeconds(pipelines))));
  console.log('');
  console.log('Environments');
  console.log(pad('Total:', environments.total));
  console.log(pad('Healthy:', environments.healthy));
  console.log(pad('Degraded:', environments.degraded));
  console.log(pad('Unknown:', environments.unknown));
}

async function analyticsJobs(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  orgId: string,
): Promise<void> {
  const json = Boolean(flags.json);
  const window = getStringFlag(flags, ['window']) ?? '7d';

  const data = await requestJson<JobAnalytics>(
    context,
    `/orgs/${orgId}/analytics/jobs?window=${encodeURIComponent(window)}`,
  );

  if (json) {
    outputJson(data, true);
    return;
  }

  console.log(`Job Analytics (${window} window)`);
  console.log('\u2550'.repeat(36));
  console.log(pad('As of:', data.as_of));
  console.log('');
  console.log('Jobs');
  console.log(pad('Created:', data.created));
  console.log(pad('Completed:', data.completed));
  console.log(pad('Failed:', data.failed));
  console.log(pad('Active:', data.active));
}

async function analyticsPipelines(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  orgId: string,
): Promise<void> {
  const json = Boolean(flags.json);
  const window = getStringFlag(flags, ['window']) ?? '7d';

  const data = await requestJson<PipelineAnalytics>(
    context,
    `/orgs/${orgId}/analytics/pipelines?window=${encodeURIComponent(window)}`,
  );

  if (json) {
    outputJson(data, true);
    return;
  }

  console.log(`Pipeline Analytics (${window} window)`);
  console.log('\u2550'.repeat(36));
  console.log(pad('As of:', data.as_of));
  console.log('');
  console.log('Pipelines');
  console.log(pad('Runs:', data.runs));
  console.log(pad('Success Rate:', `${data.success_rate.toFixed(1)}%`));
  console.log(pad('Avg Duration:', formatDuration(parseAvgDurationSeconds(data))));
}

async function analyticsEnvHealth(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  orgId: string,
): Promise<void> {
  const json = Boolean(flags.json);

  const data = await requestJson<EnvHealthAnalytics>(
    context,
    `/orgs/${orgId}/analytics/env-health`,
  );

  if (json) {
    outputJson(data, true);
    return;
  }

  console.log('Environment Health');
  console.log('\u2550'.repeat(36));
  console.log('');
  console.log(pad('As of:', data.as_of));
  console.log(pad('Total:', data.total));
  console.log(pad('Healthy:', data.healthy));
  console.log(pad('Degraded:', data.degraded));
  console.log(pad('Unknown:', data.unknown));
}

// ── Cost by agent ────────────────────────────────────────────────

interface AgentCostItem {
  agent: string;
  attempts: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

interface CostByAgentResponse {
  as_of: string;
  window: string;
  agents: AgentCostItem[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function analyticsCostByAgent(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  orgId: string,
): Promise<void> {
  const json = Boolean(flags.json);
  const window = getStringFlag(flags, ['window']) ?? '7d';

  const data = await requestJson<CostByAgentResponse>(
    context,
    `/orgs/${orgId}/analytics/cost-by-agent?window=${encodeURIComponent(window)}`,
  );

  if (json) {
    outputJson(data, true);
    return;
  }

  console.log(`Agent Cost Breakdown (${window} window)`);
  console.log('\u2550'.repeat(60));

  if (data.agents.length === 0) {
    console.log('  No cost data for this period.');
    return;
  }

  let totalCost = 0;
  for (const agent of data.agents) {
    const cost = `$${agent.total_cost_usd.toFixed(2)}`;
    const attempts = `${agent.attempts} attempts`;
    const tokens = `${formatTokens(agent.total_input_tokens)} input`;
    console.log(`  ${agent.agent.padEnd(20)} ${cost.padStart(8)}  (${attempts}, ${tokens})`);
    totalCost += agent.total_cost_usd;
  }
  console.log('  ' + '\u2500'.repeat(56));
  console.log(`  ${'Total'.padEnd(20)} $${totalCost.toFixed(2).padStart(7)}`);
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleAnalytics(
  subcommand: string | undefined,
  _positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const orgId = getStringFlag(flags, ['org', 'org-id', 'org_id']) ?? context.orgId;

  if (!orgId) {
    throw new Error('Missing org id. Provide --org or set a profile default.');
  }

  switch (subcommand) {
    case 'summary':
      return analyticsSummary(flags, context, orgId);
    case 'jobs':
      return analyticsJobs(flags, context, orgId);
    case 'pipelines':
      return analyticsPipelines(flags, context, orgId);
    case 'env-health':
      return analyticsEnvHealth(flags, context, orgId);
    case 'cost-by-agent':
      return analyticsCostByAgent(flags, context, orgId);
    default:
      throw new Error(
        'Usage: eve analytics <summary|jobs|pipelines|env-health|cost-by-agent>\n\n' +
        '  summary        Org-wide activity summary\n' +
        '  jobs           Job counters for the window\n' +
        '  pipelines      Pipeline success rates and durations\n' +
        '  env-health     Current environment health snapshot\n' +
        '  cost-by-agent  Cost breakdown by agent',
      );
  }
}

import type { RateCardV1 } from '../types.js';
import type { ExecutionReceiptV2 } from './receipt-v2.js';
import { calculateBilledCost, estimateComputeCostUsd, getTokenRate } from '../cost-calculator.js';
import type { LlmUsageByModel, ComputeUsage } from '../cost-calculator.js';
import { inferProviderName } from '../../providers/registry.js';

export type ExecutionLogLike = {
  type: string;
  content: Record<string, unknown>;
};

export type AssembleAttemptReceiptV2Input = {
  job: {
    id: string;
    project_id: string;
    created_at: Date;
    ready_at: Date | null;
    defer_until: Date | null;
    phase: string;
    hints?: Record<string, unknown> | null;
  };
  attempt: {
    id: string;
    job_id: string;
    started_at: Date;
    execution_started_at: Date | null;
    ended_at: Date | null;
    duration_ms: number | null;
    runtime_meta?: Record<string, unknown> | null;
  };
  org_id: string;
  logs: ExecutionLogLike[];
  resource_class?: {
    name: string | null;
    requested_vcpu: number | null;
    requested_memory_gib: number | null;
  };
  pricing: {
    rate_card: { name: string; version: number; effective_at: string; rates: RateCardV1 };
    markup_pct: number;
    billing_currency: string;
    fx: { rate: string; fetched_at: string; source: string } | null;
  };
};

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function msBetween(a: Date | null | undefined, b: Date | null | undefined): number | null {
  if (!a || !b) return null;
  return b.getTime() - a.getTime();
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findLifecycleDurationMs(logs: ExecutionLogLike[], type: string): number | null {
  const entry = [...logs].reverse().find((l) => l.type === type);
  if (!entry) return null;
  return readNumber(entry.content.duration_ms) ?? null;
}

function sumLifecycleDurationMs(logs: ExecutionLogLike[], type: string): number | null {
  const entries = logs.filter((l) => l.type === type);
  if (entries.length === 0) return null;
  let sum = 0;
  for (const entry of entries) {
    sum += readNumber(entry.content.duration_ms) ?? 0;
  }
  return sum;
}

function findFirstLifecycleTs(logs: ExecutionLogLike[], type: string): Date | null {
  const entry = logs.find((l) => l.type === type);
  if (!entry) return null;
  const ts = entry.content.ts;
  if (typeof ts !== 'string') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** @deprecated Delegates to inferProviderName from provider registry */
function inferProviderFromHarness(harness: string | null | undefined): string {
  return inferProviderName(harness);
}

function detectHarnessIdentity(logs: ExecutionLogLike[]): { harness: string | null; model: string | null } {
  const start = logs.find((l) => l.type === 'lifecycle_harness_start');
  if (!start) return { harness: null, model: null };
  const meta = start.content.meta as Record<string, unknown> | undefined;
  const harness = typeof meta?.harness === 'string' ? meta.harness : null;
  const modelFromMeta = typeof meta?.model === 'string' ? meta.model : null;
  const opts = meta?.harness_options as Record<string, unknown> | undefined;
  const modelFromOpts = typeof opts?.model === 'string' ? opts.model : null;
  return { harness, model: modelFromMeta ?? modelFromOpts };
}

function extractLegacyTokenUsage(logs: ExecutionLogLike[]): {
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
} {
  const entries = logs.filter((l) => {
    const raw = l.content.raw as Record<string, unknown> | undefined;
    const message = raw?.message as Record<string, unknown> | undefined;
    return message?.usage !== undefined;
  });

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;

  for (const entry of entries) {
    const raw = entry.content.raw as Record<string, unknown> | undefined;
    const message = raw?.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    input += Number(usage.input_tokens) || 0;
    output += Number(usage.output_tokens) || 0;
    cacheRead += Number(usage.cache_read_tokens) || 0;
    cacheWrite += Number(usage.cache_write_tokens) || 0;
    reasoning += Number(usage.reasoning_tokens) || 0;
  }

  return {
    calls: entries.length,
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    reasoning,
  };
}

export function assembleAttemptReceiptV2(input: AssembleAttemptReceiptV2Input): {
  receipt: ExecutionReceiptV2;
  materialized: { base_total_usd: string; billed_total: string; billed_currency: string };
} {
  const job = input.job;
  const attempt = input.attempt;

  const readyAt = job.ready_at ?? (job.phase === 'ready' ? job.created_at : null);
  const claimedAt = attempt.started_at;
  const startedAt =
    attempt.execution_started_at
    ?? findFirstLifecycleTs(input.logs, 'lifecycle_workspace_start')
    ?? claimedAt;

  const endedAt = attempt.ended_at ?? null;
  const wallMs = endedAt ? endedAt.getTime() - claimedAt.getTime() : null;
  const billableMs =
    endedAt
      ? Math.max(0, endedAt.getTime() - startedAt.getTime())
      : (typeof attempt.duration_ms === 'number' ? attempt.duration_ms : null);

  const queueStart = maxDate(readyAt ?? job.created_at, job.defer_until);
  const queueWaitMs = msBetween(queueStart, claimedAt);
  const orchestratorMs = msBetween(claimedAt, startedAt);

  const workspaceMs = findLifecycleDurationMs(input.logs, 'lifecycle_workspace_end');
  const secretsMs = findLifecycleDurationMs(input.logs, 'lifecycle_secrets_end');
  const harnessMs = findLifecycleDurationMs(input.logs, 'lifecycle_harness_end');
  const runnerMs = findLifecycleDurationMs(input.logs, 'lifecycle_runner_end');
  const hooksMs = sumLifecycleDurationMs(input.logs, 'lifecycle_hook_end');

  const llmCallLogs = input.logs.filter((l) => l.type === 'llm.call');
  const llmUsageByModel: LlmUsageByModel[] = [];
  let totalCalls = 0;
  let totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  };

  const byModelAgg = new Map<string, {
    provider: string;
    model: string;
    source: 'byok' | 'managed';
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  }>();

  if (llmCallLogs.length > 0) {
    for (const log of llmCallLogs) {
      const provider = typeof log.content.provider === 'string' ? log.content.provider : 'unknown';
      const model = typeof log.content.model === 'string' ? log.content.model : 'unknown';
      const source: 'byok' = 'byok';
      const status = typeof log.content.status === 'string' ? log.content.status : 'ok';
      const ok = status === 'ok';
      const usage = log.content.usage as Record<string, unknown> | undefined;

      totalCalls += 1;

      const key = `${source}:${provider}:${model}`;
      const existing = byModelAgg.get(key) ?? {
        provider,
        model,
        source,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      };
      existing.calls += 1;

      if (ok && usage) {
        existing.input_tokens += Number(usage.input_tokens) || 0;
        existing.output_tokens += Number(usage.output_tokens) || 0;
        existing.cache_read_tokens += Number(usage.cache_read_tokens) || 0;
        existing.cache_write_tokens += Number(usage.cache_write_tokens) || 0;
        existing.reasoning_tokens += Number(usage.reasoning_tokens) || 0;
      }

      byModelAgg.set(key, existing);
    }
  } else {
    const legacy = extractLegacyTokenUsage(input.logs);
    const identity = detectHarnessIdentity(input.logs);
    const harness = identity.harness;
    const provider = inferProviderFromHarness(harness);
    const model = identity.model ?? 'unknown';
    const source: 'byok' = 'byok';

    totalCalls = legacy.calls;
    byModelAgg.set(`${source}:${provider}:${model}`, {
      provider,
      model,
      source,
      calls: legacy.calls,
      input_tokens: legacy.input,
      output_tokens: legacy.output,
      cache_read_tokens: legacy.cache_read,
      cache_write_tokens: legacy.cache_write,
      reasoning_tokens: legacy.reasoning,
    });
  }

  for (const entry of byModelAgg.values()) {
    totals = {
      input_tokens: totals.input_tokens + entry.input_tokens,
      output_tokens: totals.output_tokens + entry.output_tokens,
      cache_read_tokens: totals.cache_read_tokens + entry.cache_read_tokens,
      cache_write_tokens: totals.cache_write_tokens + entry.cache_write_tokens,
      reasoning_tokens: totals.reasoning_tokens + entry.reasoning_tokens,
    };

    llmUsageByModel.push({
      provider: entry.provider,
      model: entry.model,
      source: entry.source,
      usage: {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_read_tokens: entry.cache_read_tokens,
        cache_write_tokens: entry.cache_write_tokens,
        reasoning_tokens: entry.reasoning_tokens,
      },
    });
  }

  const runtimeRaw = (attempt.runtime_meta?.runtime ?? '') as unknown;
  const runtime = runtimeRaw === 'k8s' ? 'k8s' : 'local';

  const resourceClass =
    input.resource_class?.name
    ?? (typeof job.hints?.resource_class === 'string' ? job.hints.resource_class : null);

  const requestedVcpu =
    typeof input.resource_class?.requested_vcpu === 'number'
      ? input.resource_class.requested_vcpu
      : null;
  const requestedMemoryGib =
    typeof input.resource_class?.requested_memory_gib === 'number'
      ? input.resource_class.requested_memory_gib
      : null;

  const billableSeconds = typeof billableMs === 'number' ? billableMs / 1000 : null;
  const compute: ComputeUsage | null =
    billableSeconds !== null
      ? {
        resource_class: resourceClass,
        vcpu_seconds: (requestedVcpu ?? 0) * billableSeconds,
        memory_gib_seconds: (requestedMemoryGib ?? 0) * billableSeconds,
      }
      : null;

  const costs = calculateBilledCost({
    rate_card: input.pricing.rate_card.rates,
    llm_usage: llmUsageByModel,
    compute_usage: compute,
    markup_pct: input.pricing.markup_pct,
    billing_currency: input.pricing.billing_currency,
    fx_usd_to_billing: input.pricing.fx,
  });

  const computeEst = compute ? estimateComputeCostUsd(input.pricing.rate_card.rates, compute) : { compute_rate: null, cost_usd: null };

  const llmRates = llmUsageByModel.map((entry) => {
    const rate = getTokenRate(input.pricing.rate_card.rates, entry);
    return {
      provider: entry.provider,
      model: entry.model,
      source: entry.source,
      input_per_million_usd: rate?.input_per_million_usd ?? '0',
      output_per_million_usd: rate?.output_per_million_usd ?? '0',
      cache_read_per_million_usd: rate?.cache_read_per_million_usd ?? null,
      cache_write_per_million_usd: rate?.cache_write_per_million_usd ?? null,
      reasoning_per_million_usd: rate?.reasoning_per_million_usd ?? null,
    };
  });

  const receipt: ExecutionReceiptV2 = {
    version: 2,
    scope: {
      type: 'attempt',
      attempt_id: attempt.id,
      job_id: job.id,
      project_id: job.project_id,
      org_id: input.org_id,
    },
    timing: {
      created_at: job.created_at.toISOString(),
      ready_at: toIso(readyAt),
      claimed_at: claimedAt.toISOString(),
      execution_started_at: startedAt ? startedAt.toISOString() : null,
      ended_at: toIso(endedAt),
      wall_ms: wallMs,
      billable_ms: billableMs,
    },
    phases: {
      queue_wait_ms: queueWaitMs,
      orchestrator_ms: orchestratorMs,
      runner_ms: runnerMs,
      workspace_ms: workspaceMs,
      secrets_ms: secretsMs,
      hooks_ms: hooksMs,
      harness_ms: harnessMs,
    },
    llm: {
      total_calls: totalCalls,
      totals,
      by_model: [...byModelAgg.values()].map((m) => ({ ...m })),
    },
    compute: {
      runtime,
      resource_class: resourceClass,
      requested: { vcpu: requestedVcpu, memory_gib: requestedMemoryGib },
      usage: compute
        ? { vcpu_seconds: compute.vcpu_seconds, memory_gib_seconds: compute.memory_gib_seconds }
        : { vcpu_seconds: 0, memory_gib_seconds: 0 },
    },
    pricing: {
      rate_card: {
        name: input.pricing.rate_card.name,
        version: input.pricing.rate_card.version,
        effective_at: input.pricing.rate_card.effective_at,
      },
      markup_pct: input.pricing.markup_pct,
      billing_currency: input.pricing.billing_currency,
      fx: input.pricing.fx
        ? {
          from_currency: 'usd',
          to_currency: input.pricing.billing_currency,
          rate: input.pricing.fx.rate,
          fetched_at: input.pricing.fx.fetched_at,
          source: input.pricing.fx.source,
        }
        : null,
    },
    base_cost_usd: {
      ...costs.base_cost_usd,
      llm_rates: llmRates,
      compute_rates: computeEst.compute_rate,
    },
    billed_cost: costs.billed_cost,
  };

  return {
    receipt,
    materialized: {
      base_total_usd: receipt.base_cost_usd.total_usd.amount,
      billed_total: receipt.billed_cost.total.amount,
      billed_currency: receipt.billed_cost.total.currency,
    },
  };
}

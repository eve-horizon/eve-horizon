import type { FxSnapshot, Money } from '../types.js';

export type ExecutionReceiptScope = {
  type: 'attempt';
  attempt_id: string;
  job_id: string;
  project_id: string;
  org_id: string;
};

export type ExecutionReceiptTiming = {
  created_at: string;
  ready_at: string | null;
  claimed_at: string;
  execution_started_at: string | null;
  ended_at: string | null;
  wall_ms: number | null;
  billable_ms: number | null;
};

export type ExecutionReceiptPhases = {
  queue_wait_ms: number | null;
  orchestrator_ms: number | null;
  runner_ms: number | null;
  workspace_ms: number | null;
  secrets_ms: number | null;
  hooks_ms: number | null;
  harness_ms: number | null;
};

export type ExecutionReceiptLlmTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
};

export type ExecutionReceiptLlmModelBreakdown = {
  provider: string;
  model: string;
  source: 'byok' | 'managed';
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
};

export type ExecutionReceiptCompute = {
  runtime: 'local' | 'k8s';
  resource_class: string | null;
  requested: { vcpu: number | null; memory_gib: number | null };
  usage: { vcpu_seconds: number; memory_gib_seconds: number };
};

export type ExecutionReceiptPricing = {
  rate_card: { name: string; version: number; effective_at: string };
  markup_pct: number;
  billing_currency: string;
  fx: FxSnapshot | null;
};

export type ExecutionReceiptBaseCostUsd = {
  llm_usd: Money;
  llm_byok_usd: Money;
  llm_managed_usd: Money;
  compute_usd: Money;
  total_usd: Money;
  llm_rates: Array<{
    provider: string;
    model: string;
    source: 'byok' | 'managed';
    input_per_million_usd: string;
    output_per_million_usd: string;
    cache_read_per_million_usd: string | null;
    cache_write_per_million_usd: string | null;
    reasoning_per_million_usd: string | null;
  }>;
  compute_rates: {
    resource_class: string | null;
    vcpu_hour_usd: string | null;
    memory_gib_hour_usd: string | null;
  } | null;
};

export type ExecutionReceiptBilledCost = {
  total: Money;
  llm: Money;
  compute: Money;
};

export type ExecutionReceiptV2 = {
  version: 2;
  scope: ExecutionReceiptScope;
  timing: ExecutionReceiptTiming;
  phases: ExecutionReceiptPhases;
  llm: {
    total_calls: number;
    totals: ExecutionReceiptLlmTotals;
    by_model: ExecutionReceiptLlmModelBreakdown[];
  };
  compute: ExecutionReceiptCompute;
  pricing: ExecutionReceiptPricing;
  base_cost_usd: ExecutionReceiptBaseCostUsd;
  billed_cost: ExecutionReceiptBilledCost;
};


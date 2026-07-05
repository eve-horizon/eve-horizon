/**
 * Shared types for the invoke module.
 *
 * Both agent-runtime and worker import these types when calling shared
 * invoke utilities. Functions accept explicit dependencies (composition)
 * rather than reaching for `this`.
 */

import type { LifecyclePhase, LifecycleAction } from '../types/lifecycle.js';

// ---------------------------------------------------------------------------
// Log entry types (used by result extraction)
// ---------------------------------------------------------------------------

export interface LogEntry {
  type: string;
  content: Record<string, unknown>;
}

export interface ExtractedResult {
  resultText?: string;
  resultJson?: Record<string, unknown>;
  tokenInput: number;
  tokenOutput: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Dependency injection types
// ---------------------------------------------------------------------------

/** Minimal logging sink — both worker and agent-runtime can provide this. */
export interface LogSink {
  appendLog(attemptId: string, type: string, content: unknown): Promise<void>;
}

/** Lifecycle event logger callback. */
export type LifecycleLogger = (
  attemptId: string,
  phase: LifecyclePhase,
  action: LifecycleAction,
  meta: Record<string, unknown>,
  opts?: { duration_ms?: number; success?: boolean; error?: string; [key: string]: unknown },
) => Promise<void>;

// ---------------------------------------------------------------------------
// Git auth
// ---------------------------------------------------------------------------

export type GitAuth = {
  cloneUrl?: string;
  env?: NodeJS.ProcessEnv;
};

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

export interface BudgetConfig {
  max_tokens: number | null;
  max_cost: { currency: string; amount: number } | null;
  pricing: {
    rate_card: { name: string; version: number; effective_at: string; rates: unknown };
    markup_pct: number;
    currency: string;
    fx_usd_to_currency: { rate: string; fetched_at: string; source: string } | null;
  };
  compute: {
    resource_class: string | null;
    requested_vcpu: number | null;
    requested_memory_gib: number | null;
    execution_started_at_ms: number;
  };
}

export interface LlmUsageEntry {
  provider: string;
  model: string;
  source: 'byok' | 'managed';
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  };
}

export interface BudgetState {
  currency: string;
  total_tokens: number;
  weighted_tokens: number;
  cache_read_tokens: number;
  cache_read_token_weight: number | null;
  cache_read_tokens_excluded: number;
  estimated_total: number;
  byok_total: number;
  billed_total: number;
}

// ---------------------------------------------------------------------------
// Resource hydration events
// ---------------------------------------------------------------------------

export type ResourceHydrationEventType =
  | 'system.resource.hydration.started'
  | 'system.resource.hydration.completed'
  | 'system.resource.hydration.failed';

// ---------------------------------------------------------------------------
// Chat delivery context (for EveMessageRelay)
// ---------------------------------------------------------------------------

export interface ChatDeliveryContext {
  threadId: string;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Helper parser functions (shared by budget enforcement + carryover context)
// ---------------------------------------------------------------------------

export function readPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function readMaxCostHint(value: unknown): { currency: string; amount: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const currency = typeof obj.currency === 'string' ? obj.currency.trim().toLowerCase() : '';
  const amount = typeof obj.amount === 'number' ? obj.amount : (typeof obj.amount === 'string' ? Number(obj.amount) : NaN);
  if (!currency) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { currency, amount };
}

export function parseDurationToMs(input: unknown): number | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const match = input.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

// ---------------------------------------------------------------------------
// Database abstraction interfaces
//
// These replace direct @eve/db imports so that packages/shared stays
// dependency-free from the database layer.  Callers (agent-runtime, worker)
// construct concrete implementations from their own Db + query factories.
// ---------------------------------------------------------------------------

/** Thread message row shape (subset) used by coordination + relay. */
export interface ThreadMessageRow {
  direction: string;
  actor_id: string | null;
  actor_type: string | null;
  created_at: Date;
  body: string;
}

/** Reads a job's hints via an explicit hints query. */
export interface JobHintsReader {
  /** SELECT hints FROM jobs WHERE id = jobId */
  queryJobHints(jobId: string): Promise<{ hints: Record<string, unknown> | null } | undefined>;
}

/** Reads a job row (hints subset) by ID. Same data as {@link JobHintsReader};
 * kept as a separate name until the worker invoke fallback is deleted
 * (slim-down G1), after which the pair collapses to one `getJobHints`. */
export interface JobByIdReader {
  findJobById(jobId: string): Promise<{ hints: Record<string, unknown> | null } | undefined>;
}

/** Lists thread messages, newest first. */
export interface ThreadMessageReader {
  listThreadMessages(threadId: string, opts: { limit: number }): Promise<ThreadMessageRow[]>;
}

/** DB facade for coordination inbox + thread context. */
export interface CoordinationDb extends JobHintsReader, JobByIdReader, ThreadMessageReader {}

/** Org document row shape (subset). */
export interface OrgDocumentRow {
  path: string;
  content: string;
  updated_at: Date;
}

/** Job attachment row shape (subset). */
export interface JobAttachmentRow {
  name: string;
  content: string;
}

/** DB facade for carryover context materialisation. */
export interface CarryoverContextDb extends JobHintsReader, JobByIdReader, ThreadMessageReader {
  findProjectById(projectId: string): Promise<{ org_id: string } | undefined>;
  listOrgDocsByPrefix(orgId: string, prefix: string, limit: number): Promise<OrgDocumentRow[]>;
  findOrgDocByPath(orgId: string, path: string): Promise<{ content: string } | undefined>;
  findJobAttachment(jobId: string, name: string): Promise<{ content: string } | undefined>;
}

/** DB facade for EveMessageRelay. */
export interface RelayDb extends JobHintsReader {
  createThreadMessage(msg: {
    id: string;
    thread_id: string;
    direction: string;
    actor_type: string;
    actor_id: string;
    body: string;
    job_id: string;
  }): Promise<void>;
}

/** DB facade for budget enforcement. */
export interface BudgetDb extends JobByIdReader {
  getSystemSetting(key: string): Promise<{ value: string } | undefined>;
  findLatestRateCard(name: string, at: Date): Promise<{
    name: string;
    version: number;
    effective_at: Date;
    rates_json: unknown;
  } | undefined>;
  findLatestExchangeRate(from: string, to: string): Promise<{
    rate: string;
    fetched_at: Date;
    source: string;
  } | undefined>;
  findLatestProjectManifest(projectId: string): Promise<{
    parsed_defaults: Record<string, unknown> | null;
  } | undefined>;
  getOrgBillingConfig(projectId: string): Promise<{
    org_id: string;
    billing_config: Record<string, unknown> | null;
  } | undefined>;
  getAttemptExecutionStart(attemptId: string): Promise<{
    execution_started_at: Date | null;
  } | undefined>;
}

/** Callback to persist git metadata on an attempt row. */
export type UpdateAttemptGitMetaFn = (
  attemptId: string,
  gitMeta: Record<string, unknown>,
) => Promise<void>;

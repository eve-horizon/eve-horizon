import type { AccessBindingScope, InlineProfileBundle, HarnessProfileSource } from '@eve/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Scheduling hints - optional preferences for job execution.
 * The scheduler uses these when claiming jobs, but may override based on
 * availability or policy.
 */
export interface JobHints {
  /** Worker type preference (e.g., "default", "gpu") */
  worker_type?: string;
  /** Permission policy for execution (e.g., "default", "auto_edit", "yolo") */
  permission_policy?: string;
  /** Execution timeout in seconds */
  timeout_seconds?: number;
  /** Required gates to acquire before execution (e.g., ["env:staging", "project:myproj"]) */
  gates?: string[];
  /** Whether this job is a supervising lead in a team dispatch (skips orphan detection) */
  supervising?: boolean;
  /** Team coordination metadata */
  coordination?: {
    thread_id: string;
    dispatch_mode?: string;
  };
  /** Index signature for JSON compatibility */
  [key: string]: unknown;
}

export interface JobHarnessOptions {
  variant?: string;
  model?: string;
  reasoning_effort?: import('@eve/shared').ReasoningEffort;
  [key: string]: unknown;
}

/**
 * Git controls configuration for a job.
 * See JobGitSchema in @eve/shared for the canonical schema definition.
 */
export interface JobGitConfig {
  ref?: string;
  ref_policy?: 'auto' | 'env' | 'project_default' | 'explicit';
  branch?: string;
  create_branch?: 'never' | 'if_missing' | 'always';
  commit?: 'never' | 'manual' | 'auto' | 'required';
  commit_message?: string;
  push?: 'never' | 'on_success' | 'required';
  remote?: string;
}

/**
 * Workspace configuration for a job.
 * See JobWorkspaceSchema in @eve/shared for the canonical schema definition.
 */
export interface JobWorkspaceConfig {
  mode?: 'job' | 'session' | 'isolated';
  key?: string;
}

export interface Job {
  // Identity
  id: string;
  project_id: string;
  parent_id: string | null;
  depth: number;

  // Content
  title: string;
  description: string | null;
  issue_type: string;
  labels: string[];

  // Lifecycle
  phase: 'idea' | 'backlog' | 'ready' | 'active' | 'review' | 'done' | 'cancelled';
  priority: number;
  assignee: string | null;

  // Review gate
  review_required: 'none' | 'human' | 'agent';
  review_status: 'pending' | 'approved' | 'rejected' | null;
  reviewer: string | null;

  // Scheduling
  defer_until: Date | null;
  due_at: Date | null;
  // The last time this job entered the `ready` phase (used for queue wait receipts).
  ready_at: Date | null;

  // Scheduling hints (worker_type, permission_policy, timeout_seconds)
  hints: JobHints;

  // Harness selection
  harness: string | null;
  harness_profile: string | null;
  harness_options: JobHarnessOptions | null;

  // Per-job harness and env overrides
  // harness_profile_override stores the inline bundle exactly as provided.
  // env_overrides stores values with ${secret.KEY} placeholders intact (resolved at spawn time).
  // harness_profile_source records provenance for audit + analytics.
  // harness_profile_hash is computed from normalized override + env keys + placeholders — never plaintext secrets.
  harness_profile_override: InlineProfileBundle | null;
  env_overrides: Record<string, string> | null;
  token_scope: AccessBindingScope | null;
  token_permissions: string[] | null;
  harness_profile_source: HarnessProfileSource | null;
  harness_profile_hash: string | null;

  // Git controls (ref, branch, commit/push policies)
  git_json: JobGitConfig | null;

  // Resolved git metadata (promoted from successful attempt)
  resolved_git_json: JobAttemptGitMeta | null;

  // Workspace configuration (mode, key)
  workspace_json: JobWorkspaceConfig | null;

  // Gates (concurrency control)
  blocked_on_gates: string[];

  // Environment targeting
  env_name: string | null;
  execution_mode: 'persistent' | 'ephemeral';

  // Execution type and pipeline context
  execution_type: 'agent' | 'script' | 'action';
  run_id: string | null;
  step_name: string | null;

  // Action-specific fields
  action_type: string | null;
  action_input: Record<string, unknown> | null;

  // Script-specific fields
  script_command: string | null;
  script_timeout_seconds: number | null;

  // Targeting (intent-level routing)
  target: { agent_slug?: string; team?: string; workflow?: string } | null;
  resource_refs: Array<{ uri: string; label?: string; required?: boolean; mount_path?: string; mime_type?: string; metadata?: Record<string, unknown> }>;

  // Sync support
  content_hash: string | null;

  // Audit
  actor_user_id: string | null;
  failure_disposition: 'cancelled' | 'failed' | 'upstream_failed' | null;

  // Timestamps
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  close_reason: string | null;
}

export interface JobIdGeneration {
  id: string;
  projectId: string;
}

export interface GetReadyJobsOptions {
  assignee?: string | null;
  limit?: number;
}

export interface UpdatePhaseResult {
  success: boolean;
  job?: Job;
  error?: string;
}

export interface JobAttemptGitMeta {
  resolved_ref?: string;
  resolved_sha?: string;
  resolved_branch?: string;
  ref_source?: 'env_release' | 'manifest' | 'project_default' | 'explicit';
  pushed?: boolean;
  commits?: string[];
}

export interface JobAttempt {
  id: string;
  job_id: string;
  attempt_number: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  trigger_type: 'manual' | 'auto_retry' | 'scheduled';
  harness: string | null;
  agent_id: string | null;
  started_at: Date;
  // The first time the worker begins the attempt execution pipeline (idempotent).
  execution_started_at: Date | null;
  ended_at: Date | null;
  result_summary: string | null;
  runtime_meta: Record<string, unknown>;

  // Git controls resolved metadata (for audit)
  git_json: JobAttemptGitMeta | null;

  // Result columns (populated when attempt ends)
  exit_code: number | null;
  result_text: string | null;
  result_json: Record<string, unknown> | null;
  duration_ms: number | null;
  token_input: number | null;
  token_output: number | null;
  error_message: string | null;

  // Receipt v2 materialization (JSONB + fast aggregation columns)
  receipt_json?: Record<string, unknown> | null;
  receipt_base_total_usd?: string | null;
  receipt_billed_total?: string | null;
  receipt_billed_currency?: string | null;

  // Harness profile attribution snapshot (copied from jobs at attempt start)
  harness_profile_source: HarnessProfileSource | null;
  harness_profile_hash: string | null;
}

/**
 * Result fields for completing an attempt.
 * All fields are optional - only provided fields will be updated.
 */
export interface CompleteAttemptResult {
  exitCode?: number;
  resultText?: string;
  resultJson?: Record<string, unknown>;
  durationMs?: number;
  tokenInput?: number;
  tokenOutput?: number;
  errorMessage?: string;
  resultSummary?: string;
}

/**
 * Result data returned by getAttemptResult
 */
export interface AttemptResultData {
  exitCode: number | null;
  resultText: string | null;
  resultJson: Record<string, unknown> | null;
  durationMs: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  errorMessage: string | null;
  status: string;
}

export interface ClaimResult {
  success: boolean;
  attempt?: JobAttempt;
  error?: string;
  blocked_on_gates?: string[];
}

export interface ReleaseResult {
  success: boolean;
  job?: Job;
  error?: string;
}

export interface RequeueReadyOptions {
  deferUntil?: Date | null;
  reason?: string;
}

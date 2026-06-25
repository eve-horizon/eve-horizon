import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag, getStringFlags } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { DEFAULT_RATE_CARD_V1, calculateBilledCost } from '@eve/shared';
import { normalizeLogLine } from '../lib/logs';
import { parseEnvOverrideFlags } from '../lib/env-overrides';

// ============================================================================
// Types
// ============================================================================

interface JobHints {
  harness?: string;
  worker_type?: string;
  permission_policy?: string;
  timeout_seconds?: number;
  resource_class?: string;
  toolchains?: string[];
  max_cost?: { currency: string; amount: number };
  max_tokens?: number;
  budget_blocked?: boolean;
  budget_blocked_reason?: string;
  gates?: string[];
  [key: string]: unknown;
}

interface JobGit {
  ref?: string;
  ref_policy?: 'auto' | 'env' | 'project_default' | 'explicit';
  branch?: string;
  create_branch?: 'never' | 'if_missing' | 'always';
  commit?: 'never' | 'manual' | 'auto' | 'required';
  commit_message?: string;
  push?: 'never' | 'on_success' | 'required';
  remote?: string;
}

interface JobWorkspace {
  mode?: 'job' | 'session' | 'isolated';
  key?: string;
}

interface Job {
  id: string;
  project_id: string;
  parent_id?: string | null;
  depth: number;
  title: string;
  description?: string | null;
  issue_type: string;
  labels: string[];
  phase: string;
  priority: number;
  assignee?: string | null;
  execution_type?: string | null;
  action_type?: string | null;
  review_required: string;
  review_status?: string | null;
  reviewer?: string | null;
  defer_until?: string | null;
  due_at?: string | null;
  hints?: JobHints;
  git?: JobGit;
  workspace?: JobWorkspace;
  resolved_git?: {
    resolved_ref?: string;
    resolved_sha?: string;
    resolved_branch?: string;
    ref_source?: string;
    pushed?: boolean;
    commits?: string[];
  };
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
}

interface JobListResponse {
  jobs: Job[];
  total?: number;
}

interface JobTreeNode extends Job {
  children?: JobTreeNode[];
}

interface JobContextResponse {
  job: Job;
  parent?: Job | null;
  children?: Job[];
  relations?: DependenciesResponse;
  latest_attempt?: JobAttempt | null;
  latest_rejection_reason?: string | null;
}

interface JobAttempt {
  id: string;
  job_id: string;
  attempt_number: number;
  status: string;
  trigger_type: string;
  harness?: string | null;
  agent_id?: string | null;
  started_at: string;
  execution_started_at?: string | null;
  ended_at?: string | null;
  result_summary?: string | null;
  runtime_meta?: Record<string, unknown>;
  result_json?: Record<string, unknown> | string | null;
  error_message?: string | null;
}

interface JobAttemptListResponse {
  attempts: JobAttempt[];
}

interface JobAttemptWithResult extends JobAttempt {
  result?: JobResultResponse;
}

interface JobResultResponse {
  jobId: string;
  attemptNumber: number;
  status: string;
  exitCode: number | null;
  resultText: string | null;
  resultJson: Record<string, unknown> | null;
  durationMs: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenUsage?: { input?: number | null; output?: number | null } | null;
  errorMessage: string | null;
}

interface WaitTimeoutResponse {
  jobId: string;
  status: string;
  phase: string;
  elapsed: number;
  message: string;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleJob(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'create':
      return handleCreate(flags, context, json);

    case 'list':
      return handleList(flags, context, json);

    case 'ready':
      return handleReady(flags, context, json);

    case 'blocked':
      return handleBlocked(flags, context, json);

    case 'show':
      return handleShow(positionals, flags, context, json);

    case 'current':
      return handleCurrent(positionals, flags, context, json);

    case 'diagnose':
      return handleDiagnose(positionals, context, json);

    case 'tree':
      return handleTree(positionals, context, json);

    case 'update':
      return handleUpdate(positionals, flags, context, json);

    case 'close':
      return handleClose(positionals, flags, context, json);

    case 'cancel':
      return handleCancel(positionals, flags, context, json);

    case 'dep':
      return handleDep(positionals, flags, context, json);

    case 'claim':
      return handleClaim(positionals, flags, context, json);

    case 'release':
      return handleRelease(positionals, flags, context, json);

    case 'attempts':
      return handleAttempts(positionals, context, json);

    case 'logs':
      return handleLogs(positionals, flags, context, json);

    case 'submit':
      return handleSubmit(positionals, flags, context, json);

    case 'approve':
      return handleApprove(positionals, flags, context, json);

    case 'reject':
      return handleReject(positionals, flags, context, json);

    case 'result':
      return handleResult(positionals, flags, context);

    case 'receipt':
      return handleReceipt(positionals, flags, context, json);

    case 'compare':
      return handleCompare(positionals, flags, context, json);

    case 'follow':
      return handleFollow(positionals, flags, context);

    case 'wait':
      return handleWait(positionals, flags, context);

    case 'watch':
      return handleWatch(positionals, flags, context);

    case 'runner-logs':
      return handleRunnerLogs(positionals, flags, context);

    case 'attach':
      return handleAttach(positionals, flags, context, json);

    case 'attachments':
      return handleAttachments(positionals, flags, context, json);

    case 'attachment':
      return handleAttachment(positionals, flags, context, json);

    case 'batch':
      return handleBatch(flags, context, json);

    case 'batch-validate':
      return handleBatchValidate(flags, context, json);

    default:
      throw new Error(
        'Usage: eve jobs <create|list|ready|blocked|show|current|diagnose|tree|update|close|cancel|dep|claim|release|attempts|logs|submit|approve|reject|result|receipt|compare|follow|wait|watch|runner-logs|attach|attachments|attachment|batch|batch-validate>',
      );
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

function parseHintValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^[\[{"]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * eve jobs create --project=X --description="..." [--title="..."] [--parent=X] [--type=task] [--priority=2] [--phase=ready] [--review=none|human|agent]
 *
 * --description is required (the work prompt sent to the harness)
 * --title is optional (defaults to first 64 chars of description's first line)
 *
 * Scheduling hints (optional, used when scheduler claims the job):
 *   --harness=mclaude:fast    Preferred harness (with optional :variant)
 *   --worker-type=default     Worker type preference
 *   --permission=auto_edit    Permission policy (default, auto_edit, yolo)
 *   --timeout=3600            Execution timeout in seconds
 *   --resource-class=job.c1   Compute SKU (used for runner sizing + compute accounting)
 *   --hint=KEY=VALUE          Generic scheduling hint; repeatable
 *
 * Environment options:
 *   --env=<name>              Environment name for persistent execution
 *   --execution-mode=<mode>   Execution mode: 'persistent' or 'ephemeral' (default: persistent)
 *
 * Inline execution:
 *   --claim                   Create and immediately claim the job for execution
 *   --agent=<id>              Agent ID for claim (default: $EVE_AGENT_ID or cli-user)
 *
 * Git controls (optional, override project/manifest defaults):
 *   --git-ref=<ref>                 Target ref (branch, tag, or SHA)
 *   --git-ref-policy=<policy>       auto|env|project_default|explicit
 *   --git-branch=<branch>           Branch to create/checkout
 *   --git-create-branch=<mode>      never|if_missing|always
 *   --git-commit=<policy>           never|manual|auto|required
 *   --git-commit-message=<template> Commit message template
 *   --git-push=<policy>             never|on_success|required
 *   --git-remote=<remote>           Remote to push to (default: origin)
 *
 * Workspace options (optional):
 *   --workspace-mode=<mode>   job|session|isolated (default: job)
 *   --workspace-key=<key>     Workspace key for session mode
 *
 * Resource refs (optional):
 *   --resource-refs=<json>    JSON array of resource refs (uri, label, mount_path)
 *
 * App API awareness:
 *   --with-apis=<names>          Comma-separated API names to include in job instructions
 *   --with-links=<aliases>       Comma-separated app-link aliases to include in job instructions
 *
 * Retry policy (optional):
 *   --retry-max=<n>              Max attempts before permanent failure (default: 1 = no retry)
 *   --retry-backoff=<seconds>    Base backoff delay in seconds (default: 60)
 */
async function handleCreate(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const parentId = getStringFlag(flags, ['parent']);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const description = getStringFlag(flags, ['description']);
  let title = getStringFlag(flags, ['title']);
  const issueType = getStringFlag(flags, ['type']) ?? 'task';
  const priority = getStringFlag(flags, ['priority']);
  const phase = getStringFlag(flags, ['phase']);  // API defaults to 'ready'
  const review = getStringFlag(flags, ['review']) ?? 'none';
  const labels = getStringFlag(flags, ['labels']);
  const assignee = getStringFlag(flags, ['assignee']);
  const deferUntil = getStringFlag(flags, ['defer-until']);
  const dueAt = getStringFlag(flags, ['due-at']);

  // App API awareness
  const withApis = getStringFlag(flags, ['with-apis']);
  const withLinks = getStringFlag(flags, ['with-links']);

  // Scheduling hints
  const harness = getStringFlag(flags, ['harness']);
  const profile = getStringFlag(flags, ['profile', 'harness-profile', 'harness_profile']);
  const variant = getStringFlag(flags, ['variant']);
  const model = getStringFlag(flags, ['model']);
  const reasoning = getStringFlag(flags, ['reasoning']);
  const workerType = getStringFlag(flags, ['worker-type']);
  const permission = getStringFlag(flags, ['permission']);
  const timeout = getStringFlag(flags, ['timeout']);
  const resourceClass = getStringFlag(flags, ['resource-class']);

  // Per-job harness + env overrides (plan §3.4)
  const harnessOverrideFile = getStringFlag(flags, ['harness-override-file']);
  const envOverrides = parseEnvOverrideFlags(flags);

  // Environment options
  const envName = getStringFlag(flags, ['env']);
  const executionMode = getStringFlag(flags, ['execution-mode']) ?? 'persistent';

  // Validate execution mode
  if (executionMode !== 'persistent' && executionMode !== 'ephemeral') {
    throw new Error('--execution-mode must be either "persistent" or "ephemeral"');
  }

  // Inline execution
  const shouldClaim = Boolean(flags.claim);
  const agentId = getStringFlag(flags, ['agent']) ?? process.env.EVE_AGENT_ID ?? 'cli-user';

  // For root jobs, project is required. For child jobs, project is inherited from parent.
  if (!parentId && !projectId) {
    throw new Error(
      'Usage: eve jobs create --project=<id> --description="..." [options]\n' +
        '       eve jobs create --parent=<id> --description="..." [options]',
    );
  }

  if (!description) {
    throw new Error('--description is required (the work prompt)');
  }

  // Auto-generate title from first line of description if not provided
  if (!title) {
    const firstLine = description.split('\n')[0].trim();
    title = firstLine.length > 64 ? firstLine.substring(0, 61) + '...' : firstLine;
  }

  const body: Record<string, unknown> = {
    title,
    description,
    issue_type: issueType,
    review_required: review,
    execution_mode: executionMode,
  };

  // Add environment name (can be null)
  body.env_name = envName ?? null;

  if (parentId) {
    body.parent_id = parentId;
  }
  if (phase) {
    body.phase = phase;
  }
  if (priority !== undefined) {
    body.priority = parseInt(priority, 10);
  }
  if (labels) {
    body.labels = labels.split(',').map((l) => l.trim());
  }
  if (assignee) {
    body.assignee = assignee;
  }
  if (deferUntil) {
    body.defer_until = deferUntil;
  }
  if (dueAt) {
    body.due_at = dueAt;
  }
  if (harness) {
    body.harness = harness;
  }
  if (profile) {
    body.harness_profile = profile;
  }
  if (variant || model || reasoning) {
    const allowedEfforts = new Set(['low', 'medium', 'high', 'x-high']);
    if (reasoning && !allowedEfforts.has(reasoning)) {
      throw new Error('--reasoning must be one of: low, medium, high, x-high');
    }
    body.harness_options = {
      ...(variant ? { variant } : {}),
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    };
  }

  if (harnessOverrideFile) {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(harnessOverrideFile, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse --harness-override-file ${harnessOverrideFile}: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--harness-override-file must contain a JSON object {harness, model?, reasoning_effort?, variant?, temperature?}');
    }
    body.harness_profile_override = parsed;
  }

  if (envOverrides) {
    body.env_overrides = envOverrides;
  }

  // Build hints object if any hint flags are provided
  const hints: JobHints = {};
  if (workerType) hints.worker_type = workerType;
  if (permission) hints.permission_policy = permission;
  if (timeout) hints.timeout_seconds = parseInt(timeout, 10);
  if (resourceClass) hints.resource_class = resourceClass;

  for (const entry of getStringFlags(flags, ['hint'])) {
    const eq = entry.indexOf('=');
    if (eq < 1) {
      throw new Error(`--hint expects KEY=VALUE (got "${entry}")`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`--hint key ${key} must start with a letter or underscore and contain only letters, numbers, and underscores`);
    }
    if (key === 'gates') {
      const gates = value.split(',').map((gate) => gate.trim()).filter(Boolean);
      if (gates.length === 0) {
        throw new Error('--hint gates=... must include at least one gate');
      }
      hints.gates = [...(hints.gates ?? []), ...gates];
    } else {
      hints[key] = parseHintValue(value);
    }
  }

  const maxTokensRaw = getStringFlag(flags, ['max-tokens', 'max_tokens']);
  if (maxTokensRaw) {
    const n = parseInt(maxTokensRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('--max-tokens must be a positive integer');
    }
    hints.max_tokens = n;
  }

  const maxCostRaw = getStringFlag(flags, ['max-cost', 'max_cost']);
  if (maxCostRaw) {
    const amount = Number(maxCostRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('--max-cost must be a positive number');
    }
    const currency = (getStringFlag(flags, ['max-cost-currency', 'max_cost_currency']) ?? 'usd').toLowerCase();
    hints.max_cost = { currency, amount };
  }

  // Retry policy
  const retryMax = getStringFlag(flags, ['retry-max']);
  const retryBackoff = getStringFlag(flags, ['retry-backoff']);
  if (retryMax) {
    const n = parseInt(retryMax, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error('--retry-max must be a positive integer');
    }
    hints.retry = {
      max_attempts: n,
      backoff_seconds: retryBackoff ? parseInt(retryBackoff, 10) : 60,
      backoff_multiplier: 2,
    };
  }

  if (Object.keys(hints).length > 0) {
    body.hints = hints;
  }

  // Git controls
  const gitRef = getStringFlag(flags, ['git-ref']);
  const gitRefPolicy = getStringFlag(flags, ['git-ref-policy']);
  const gitBranch = getStringFlag(flags, ['git-branch']);
  const gitCreateBranch = getStringFlag(flags, ['git-create-branch']);
  const gitCommit = getStringFlag(flags, ['git-commit']);
  const gitCommitMessage = getStringFlag(flags, ['git-commit-message']);
  const gitPush = getStringFlag(flags, ['git-push']);
  const gitRemote = getStringFlag(flags, ['git-remote']);

  // Validate git policies
  if (gitRefPolicy && !['auto', 'env', 'project_default', 'explicit'].includes(gitRefPolicy)) {
    throw new Error('--git-ref-policy must be one of: auto, env, project_default, explicit');
  }
  if (gitCreateBranch && !['never', 'if_missing', 'always'].includes(gitCreateBranch)) {
    throw new Error('--git-create-branch must be one of: never, if_missing, always');
  }
  if (gitCommit && !['never', 'manual', 'auto', 'required'].includes(gitCommit)) {
    throw new Error('--git-commit must be one of: never, manual, auto, required');
  }
  if (gitPush && !['never', 'on_success', 'required'].includes(gitPush)) {
    throw new Error('--git-push must be one of: never, on_success, required');
  }

  // Build git object if any git flags are provided
  const git: Record<string, unknown> = {};
  if (gitRef) git.ref = gitRef;
  if (gitRefPolicy) git.ref_policy = gitRefPolicy;
  if (gitBranch) git.branch = gitBranch;
  if (gitCreateBranch) git.create_branch = gitCreateBranch;
  if (gitCommit) git.commit = gitCommit;
  if (gitCommitMessage) git.commit_message = gitCommitMessage;
  if (gitPush) git.push = gitPush;
  if (gitRemote) git.remote = gitRemote;

  if (Object.keys(git).length > 0) {
    body.git = git;
  }

  // Workspace options
  const workspaceMode = getStringFlag(flags, ['workspace-mode']);
  const workspaceKey = getStringFlag(flags, ['workspace-key']);

  // Resource refs
  const resourceRefsRaw = getStringFlag(flags, ['resource-refs']);

  // Validate workspace mode
  if (workspaceMode && !['job', 'session', 'isolated'].includes(workspaceMode)) {
    throw new Error('--workspace-mode must be one of: job, session, isolated');
  }

  // Build workspace object if any workspace flags are provided
  const workspace: Record<string, unknown> = {};
  if (workspaceMode) workspace.mode = workspaceMode;
  if (workspaceKey) workspace.key = workspaceKey;

  if (Object.keys(workspace).length > 0) {
    body.workspace = workspace;
  }

  if (resourceRefsRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resourceRefsRaw);
    } catch (err) {
      throw new Error(`--resource-refs must be valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('--resource-refs must be a JSON array');
    }
    for (const ref of parsed) {
      if (!ref || typeof ref !== 'object') {
        throw new Error('--resource-refs entries must be objects');
      }
      const uri = (ref as { uri?: unknown }).uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new Error('--resource-refs entries must include a non-empty "uri" string');
      }
    }
    body.resource_refs = parsed;
  }

  // Determine endpoint: root jobs use project endpoint, child jobs can use job-based endpoint
  // For simplicity, always use project endpoint. If parent_id is set, the API inherits project from parent.
  const resolvedProjectId = projectId ?? (parentId ? await getProjectFromJob(context, parentId) : undefined);

  if (!resolvedProjectId) {
    throw new Error('Could not determine project. Provide --project or ensure --parent exists.');
  }

  // --with-apis: pass API names in hints for server-side resolution
  if (withApis) {
    const apiNames = withApis.split(',').map(n => n.trim()).filter(Boolean);
    if (apiNames.length > 0) {
      if (!body.hints || typeof body.hints !== 'object') {
        body.hints = {};
      }
      (body.hints as Record<string, unknown>).app_apis = apiNames;
    }
  }
  if (withLinks) {
    const linkAliases = withLinks.split(',').map(n => n.trim()).filter(Boolean);
    if (linkAliases.length > 0) {
      if (!body.hints || typeof body.hints !== 'object') {
        body.hints = {};
      }
      (body.hints as Record<string, unknown>).app_links = linkAliases;
    }
  }

  const response = await requestJson<Job>(context, `/projects/${resolvedProjectId}/jobs`, {
    method: 'POST',
    body,
  });

  // If --claim flag is set, immediately claim the job
  if (shouldClaim) {
    const claimBody: Record<string, unknown> = { agent_id: agentId };
    // Use harness from hints if available
    if (harness) {
      claimBody.harness = harness;
    }

    const claimResponse = await requestJson<{ attempt: JobAttempt }>(
      context,
      `/jobs/${response.id}/claim`,
      { method: 'POST', body: claimBody },
    );

    if (json) {
      outputJson({ job: response, attempt: claimResponse.attempt }, json);
    } else {
      console.log(`Created and claimed job: ${response.id}`);
      console.log(`  Title:       ${response.title}`);
      console.log(`  Phase:       active`);
      console.log(`  Priority:    P${response.priority}`);
      console.log(`  Attempt:     #${claimResponse.attempt.attempt_number}`);
      console.log(`  Agent:       ${claimResponse.attempt.agent_id}`);
      if (claimResponse.attempt.harness) {
        console.log(`  Harness:     ${claimResponse.attempt.harness}`);
      }
      if (response.parent_id) {
        console.log(`  Parent:      ${response.parent_id}`);
      }
    }
    return;
  }

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Created job: ${response.id}`);
    console.log(`  Title:    ${response.title}`);
    console.log(`  Phase:    ${response.phase}`);
    console.log(`  Priority: P${response.priority}`);
    if (response.parent_id) {
      console.log(`  Parent:   ${response.parent_id}`);
    }
    if (Object.keys(hints).length > 0) {
      console.log(`  Hints:    ${JSON.stringify(hints)}`);
    }
    if (Object.keys(git).length > 0) {
      console.log(`  Git:      ${JSON.stringify(git)}`);
    }
    if (Object.keys(workspace).length > 0) {
      console.log(`  Workspace: ${JSON.stringify(workspace)}`);
    }
  }
}

/**
 * Parse a relative time string (e.g., "1h", "30m", "2d") into an ISO timestamp
 */
function parseSinceValue(since: string): string {
  // If it looks like an ISO date, return as-is
  if (since.includes('T') || since.includes('-')) {
    return since;
  }

  const match = since.match(/^(\d+)([mhd])$/);
  if (!match) {
    throw new Error(`Invalid --since format: "${since}". Use formats like "1h", "30m", "2d", or ISO timestamp.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'd':
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString();
}

/**
 * eve jobs list [--project=X] [--phase=ready] [--assignee=X] [--since=1h] [--stuck] [--label=X] [--type=X] [--root] [--dead-letters] [--disposition=X] [--limit=50] [--offset=0]
 * eve jobs list --all [--org=X] [--project=X] [--phase=X] [--label=X] [--type=X] [--root] [--dead-letters] [--disposition=X] [--limit=50] [--offset=0]
 */
async function handleList(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  // Check for --all flag (admin mode - cross-project listing)
  const all = Boolean(flags.all);

  if (all) {
    // Admin mode: list all jobs across projects
    const root = Boolean(flags.root);
    const deadLetters = Boolean(flags['dead-letters']);
    const disposition = getStringFlag(flags, ['disposition']);
    const query = buildQuery({
      org_id: getStringFlag(flags, ['org']),
      project_id: getStringFlag(flags, ['project']),
      phase: deadLetters ? 'cancelled' : getStringFlag(flags, ['phase']),
      label: getStringFlag(flags, ['label']),
      type: getStringFlag(flags, ['type']),
      parent: root ? 'null' : undefined,
      failure_disposition: deadLetters ? 'failed' : disposition,
      limit: getStringFlag(flags, ['limit']) ?? '50',
      offset: getStringFlag(flags, ['offset']),
    });

    const response = await requestJson<JobListResponse>(
      context,
      `/jobs${query}`,
    );

    if (json) {
      outputJson(response, json);
    } else {
      if (response.jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }
      console.log('All jobs (admin view):');
      console.log('');
      formatJobsTable(response.jobs);
    }
    return;
  }

  // Standard mode: project-scoped listing
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve jobs list --project=<id> [--phase=X] [--assignee=X] [--since=1h] [--stuck]\n       eve jobs list --all [--org=X] [--project=X] [--phase=X]');
  }

  // Parse --since into ISO timestamp
  const sinceRaw = getStringFlag(flags, ['since']);
  const since = sinceRaw ? parseSinceValue(sinceRaw) : undefined;

  // --stuck is a boolean flag
  const stuck = Boolean(flags.stuck);
  const stuckMinutes = getStringFlag(flags, ['stuck-minutes']);
  const root = Boolean(flags.root);
  const deadLetters = Boolean(flags['dead-letters']);
  const disposition = getStringFlag(flags, ['disposition']);

  const query = buildQuery({
    phase: deadLetters ? 'cancelled' : getStringFlag(flags, ['phase']),
    assignee: getStringFlag(flags, ['assignee']),
    priority: getStringFlag(flags, ['priority']),
    since,
    stuck: stuck ? 'true' : undefined,
    stuck_minutes: stuckMinutes,
    label: getStringFlag(flags, ['label']),
    type: getStringFlag(flags, ['type']),
    parent: root ? 'null' : undefined,
    failure_disposition: deadLetters ? 'failed' : disposition,
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<JobListResponse>(
    context,
    `/projects/${projectId}/jobs${query}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (stuck && response.jobs.length === 0) {
      console.log('No stuck jobs found.');
      return;
    }
    formatJobsTable(response.jobs);
  }
}

/**
 * eve jobs ready [--project=X] [--limit=10]
 * Shortcut for showing schedulable jobs
 */
async function handleReady(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve jobs ready --project=<id> [--limit=10]');
  }

  const query = buildQuery({
    limit: getStringFlag(flags, ['limit']) ?? '10',
  });

  const response = await requestJson<JobListResponse>(
    context,
    `/projects/${projectId}/jobs/ready${query}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.jobs.length === 0) {
      console.log('No ready jobs found.');
      return;
    }
    console.log('Ready jobs (schedulable):');
    console.log('');
    formatJobsTable(response.jobs);
  }
}

/**
 * eve jobs blocked [--project=X]
 * Show jobs that are blocked by dependencies
 */
async function handleBlocked(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve jobs blocked --project=<id>');
  }

  const response = await requestJson<JobListResponse>(
    context,
    `/projects/${projectId}/jobs/blocked`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.jobs.length === 0) {
      console.log('No blocked jobs found.');
      return;
    }
    console.log('Blocked jobs (waiting on dependencies):');
    console.log('');
    formatJobsTable(response.jobs);
  }
}

/**
 * eve jobs show <id>
 */
async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  const verbose = Boolean(flags.verbose || flags.v);

  if (!jobId) {
    throw new Error('Usage: eve jobs show <job-id> [--verbose]');
  }

  const job = await requestJson<Job>(context, `/jobs/${jobId}`);

  // Fetch attempts if verbose
  let attempts: JobAttempt[] = [];
  let latestAttempt: JobAttemptWithResult | undefined;
  if (verbose) {
    const attemptsResponse = await requestJson<JobAttemptListResponse>(
      context,
      `/jobs/${jobId}/attempts`,
    );
    attempts = attemptsResponse.attempts || [];

    // Get result details for the latest attempt
    if (attempts.length > 0) {
      const latest = attempts[attempts.length - 1];
      try {
        const result = await requestJson<JobResultResponse>(
          context,
          `/jobs/${jobId}/result?attempt=${latest.attempt_number}`,
        );
        latestAttempt = { ...latest, result };
      } catch {
        latestAttempt = { ...latest };
      }
    }
  }

  if (json) {
    outputJson(verbose ? { ...job, attempts, latestAttempt } : job, json);
  } else {
    formatJobDetails(job);
    if (verbose && attempts.length > 0) {
      formatAttemptsVerbose(attempts, latestAttempt);
    }
  }
}

/**
 * eve jobs current [<job-id>] [--json|--tree]
 * Defaults to EVE_JOB_ID when present
 */
async function handleCurrent(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0] ?? process.env.EVE_JOB_ID;
  const tree = getBooleanFlag(flags, ['tree']) ?? false;

  if (!jobId) {
    throw new Error('Usage: eve job current [<job-id>] [--json|--tree]');
  }

  if (tree) {
    const response = await requestJson<JobTreeNode>(context, `/jobs/${jobId}/tree`);
    if (json) {
      outputJson(response, json);
    } else {
      formatJobTree(response, 0);
    }
    return;
  }

  const response = await requestJobContext(context, jobId);
  outputJson(response, true);
}

/**
 * eve jobs diagnose <id>
 * Comprehensive job debugging - shows job state, attempts, timeline, logs, and recommendations
 */
async function handleDiagnose(
  positionals: string[],
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs diagnose <job-id>');
  }

  // Fetch job details
  const job = await requestJson<Job>(context, `/jobs/${jobId}`);

  // Fetch attempts
  const attemptsResponse = await requestJson<JobAttemptListResponse>(
    context,
    `/jobs/${jobId}/attempts`,
  );
  const attempts = attemptsResponse.attempts || [];

  // Fetch latest result
  let latestResult: JobResultResponse | null = null;
  if (attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    try {
      latestResult = await requestJson<JobResultResponse>(
        context,
        `/jobs/${jobId}/result?attempt=${latest.attempt_number}`,
      );
    } catch {
      // No result available
    }
  }

  // Fetch recent logs (if we have attempts)
  let logs: DiagnoseLogEntry[] = [];
  if (attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    try {
      const logsResponse = await requestJson<DiagnoseLogsResponse>(
        context,
        `/jobs/${jobId}/attempts/${latest.attempt_number}/logs?limit=50`,
      );
      logs = logsResponse.logs || [];
    } catch {
      // No logs available
    }
  }

  // Fetch receipt (best-effort)
  let receipt: ExecutionReceiptV2Like | null = null;
  if (attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    try {
      receipt = await requestJson<ExecutionReceiptV2Like>(
        context,
        `/jobs/${jobId}/receipt?attempt=${latest.attempt_number}`,
      );
    } catch {
      // Receipt missing
    }
  }

  // Fetch pod status for active jobs (best-effort)
  let podStatus: { pod_name: string; status: string; stale: boolean; last_heartbeat_at: string } | null = null;
  if (job.phase === 'active' && attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    const podName = latest.runtime_meta?.pod_name as string | undefined;
    if (podName) {
      try {
        // Look up org_id via project
        const project = await requestJson<{ id: string; org_id: string }>(
          context,
          `/projects/${job.project_id}`,
        );
        const rtResponse = await requestJson<{ pods: Array<{ pod_name: string; status: string; stale?: boolean; last_heartbeat_at: string }> }>(
          context,
          `/orgs/${project.org_id}/agent-runtime/status`,
        );
        const matchingPod = rtResponse.pods.find(p => p.pod_name === podName);
        if (matchingPod) {
          podStatus = {
            pod_name: matchingPod.pod_name,
            status: matchingPod.status,
            stale: matchingPod.stale ?? false,
            last_heartbeat_at: matchingPod.last_heartbeat_at,
          };
        }
      } catch {
        // Non-fatal — project lookup or agent-runtime status may fail
      }
    }
  }

  if (json) {
    outputJson({ job, attempts, latestResult, logs, receipt, podStatus }, json);
  } else {
    formatDiagnose(job, attempts, latestResult, logs, receipt, podStatus);
  }
}

/**
 * eve jobs tree <id>
 * Show job hierarchy
 */
async function handleTree(
  positionals: string[],
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs tree <job-id>');
  }

  const response = await requestJson<JobTreeNode>(context, `/jobs/${jobId}/tree`);

  if (json) {
    outputJson(response, json);
  } else {
    formatJobTree(response, 0);
  }
}

/**
 * eve jobs update <id> --phase=X --priority=X --assignee=X
 *
 * Git controls (optional, override project/manifest defaults):
 *   --git-ref=<ref>                 Target ref (branch, tag, or SHA)
 *   --git-ref-policy=<policy>       auto|env|project_default|explicit
 *   --git-branch=<branch>           Branch to create/checkout
 *   --git-create-branch=<mode>      never|if_missing|always
 *   --git-commit=<policy>           never|manual|auto|required
 *   --git-commit-message=<template> Commit message template
 *   --git-push=<policy>             never|on_success|required
 *   --git-remote=<remote>           Remote to push to (default: origin)
 *
 * Workspace options (optional):
 *   --workspace-mode=<mode>   job|session|isolated (default: job)
 *   --workspace-key=<key>     Workspace key for session mode
 */
async function handleUpdate(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs update <job-id> [--phase=X] [--priority=X] [--assignee=X] [--git-*] [--workspace-*]');
  }

  const body: Record<string, unknown> = {};

  const phase = getStringFlag(flags, ['phase']);
  const priority = getStringFlag(flags, ['priority']);
  const assignee = getStringFlag(flags, ['assignee']);
  const title = getStringFlag(flags, ['title']);
  const description = getStringFlag(flags, ['description']);
  const labels = getStringFlag(flags, ['labels']);
  const deferUntil = getStringFlag(flags, ['defer-until']);
  const dueAt = getStringFlag(flags, ['due-at']);
  const review = getStringFlag(flags, ['review']);

  if (phase) body.phase = phase;
  if (priority !== undefined) body.priority = parseInt(priority, 10);
  if (assignee) body.assignee = assignee;
  if (title) body.title = title;
  if (description) body.description = description;
  if (labels) body.labels = labels.split(',').map((l) => l.trim());
  if (deferUntil) body.defer_until = deferUntil;
  if (dueAt) body.due_at = dueAt;
  if (review) body.review_required = review;

  // Git controls
  const gitRef = getStringFlag(flags, ['git-ref']);
  const gitRefPolicy = getStringFlag(flags, ['git-ref-policy']);
  const gitBranch = getStringFlag(flags, ['git-branch']);
  const gitCreateBranch = getStringFlag(flags, ['git-create-branch']);
  const gitCommit = getStringFlag(flags, ['git-commit']);
  const gitCommitMessage = getStringFlag(flags, ['git-commit-message']);
  const gitPush = getStringFlag(flags, ['git-push']);
  const gitRemote = getStringFlag(flags, ['git-remote']);

  // Validate git policies
  if (gitRefPolicy && !['auto', 'env', 'project_default', 'explicit'].includes(gitRefPolicy)) {
    throw new Error('--git-ref-policy must be one of: auto, env, project_default, explicit');
  }
  if (gitCreateBranch && !['never', 'if_missing', 'always'].includes(gitCreateBranch)) {
    throw new Error('--git-create-branch must be one of: never, if_missing, always');
  }
  if (gitCommit && !['never', 'manual', 'auto', 'required'].includes(gitCommit)) {
    throw new Error('--git-commit must be one of: never, manual, auto, required');
  }
  if (gitPush && !['never', 'on_success', 'required'].includes(gitPush)) {
    throw new Error('--git-push must be one of: never, on_success, required');
  }

  // Build git object if any git flags are provided
  const git: Record<string, unknown> = {};
  if (gitRef) git.ref = gitRef;
  if (gitRefPolicy) git.ref_policy = gitRefPolicy;
  if (gitBranch) git.branch = gitBranch;
  if (gitCreateBranch) git.create_branch = gitCreateBranch;
  if (gitCommit) git.commit = gitCommit;
  if (gitCommitMessage) git.commit_message = gitCommitMessage;
  if (gitPush) git.push = gitPush;
  if (gitRemote) git.remote = gitRemote;

  if (Object.keys(git).length > 0) {
    body.git = git;
  }

  // Workspace options
  const workspaceMode = getStringFlag(flags, ['workspace-mode']);
  const workspaceKey = getStringFlag(flags, ['workspace-key']);

  // Validate workspace mode
  if (workspaceMode && !['job', 'session', 'isolated'].includes(workspaceMode)) {
    throw new Error('--workspace-mode must be one of: job, session, isolated');
  }

  // Build workspace object if any workspace flags are provided
  const workspace: Record<string, unknown> = {};
  if (workspaceMode) workspace.mode = workspaceMode;
  if (workspaceKey) workspace.key = workspaceKey;

  if (Object.keys(workspace).length > 0) {
    body.workspace = workspace;
  }

  if (Object.keys(body).length === 0) {
    throw new Error('No updates provided. Use --phase, --priority, --assignee, --git-*, --workspace-*, etc.');
  }

  const response = await requestJson<Job>(context, `/jobs/${jobId}`, {
    method: 'PATCH',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Updated job: ${response.id}`);
    console.log(`  Phase:    ${response.phase}`);
    console.log(`  Priority: P${response.priority}`);
    if (response.assignee) {
      console.log(`  Assignee: ${response.assignee}`);
    }
    if (response.git && Object.keys(response.git).length > 0) {
      console.log(`  Git:      ${JSON.stringify(response.git)}`);
    }
    if (response.workspace && Object.keys(response.workspace).length > 0) {
      console.log(`  Workspace: ${JSON.stringify(response.workspace)}`);
    }
  }
}

/**
 * eve jobs close <id> [--reason="..."]
 * Mark job as done
 */
async function handleClose(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs close <job-id> [--reason="..."]');
  }

  const reason = getStringFlag(flags, ['reason']);

  const body: Record<string, unknown> = {
    phase: 'done',
  };

  if (reason) {
    body.close_reason = reason;
  }

  const response = await requestJson<Job>(context, `/jobs/${jobId}`, {
    method: 'PATCH',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Closed job: ${response.id}`);
    console.log(`  Phase: ${response.phase}`);
    if (response.close_reason) {
      console.log(`  Reason: ${response.close_reason}`);
    }
  }
}

/**
 * eve jobs cancel <id> [--reason="..."]
 * Mark job as cancelled
 */
async function handleCancel(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs cancel <job-id> [--reason="..."]');
  }

  const reason = getStringFlag(flags, ['reason']);

  const body: Record<string, unknown> = {
    phase: 'cancelled',
  };

  if (reason) {
    body.close_reason = reason;
  }

  const response = await requestJson<Job>(context, `/jobs/${jobId}`, {
    method: 'PATCH',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Cancelled job: ${response.id}`);
    console.log(`  Phase: ${response.phase}`);
    if (response.close_reason) {
      console.log(`  Reason: ${response.close_reason}`);
    }
  }
}

/**
 * eve jobs dep <add|remove|list> [args]
 * Manage job dependencies
 */
async function handleDep(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const depSubcommand = positionals[0];

  switch (depSubcommand) {
    case 'add':
      return handleDepAdd(positionals.slice(1), flags, context, json);
    case 'remove':
      return handleDepRemove(positionals.slice(1), context, json);
    case 'list':
      return handleDepList(positionals.slice(1), context, json);
    default:
      throw new Error('Usage: eve jobs dep <add|remove|list> [args]');
  }
}

/**
 * eve jobs dep add <from> <to> [--type=blocks]
 * Add dependency: "from depends on to" (to blocks from)
 */
async function handleDepAdd(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const fromId = positionals[0];
  const toId = positionals[1];

  if (!fromId || !toId) {
    throw new Error('Usage: eve jobs dep add <from> <to> [--type=blocks]');
  }

  const relationType = getStringFlag(flags, ['type']) ?? 'blocks';

  const response = await requestJson<{ success: boolean; message: string }>(
    context,
    `/jobs/${fromId}/dependencies`,
    {
      method: 'POST',
      body: {
        related_job_id: toId,
        relation_type: relationType,
      },
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Added dependency: ${fromId} depends on ${toId} (${relationType})`);
  }
}

/**
 * eve jobs dep remove <from> <to>
 * Remove dependency
 */
async function handleDepRemove(
  positionals: string[],
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const fromId = positionals[0];
  const toId = positionals[1];

  if (!fromId || !toId) {
    throw new Error('Usage: eve jobs dep remove <from> <to>');
  }

  const response = await requestJson<{ success: boolean; message: string }>(
    context,
    `/jobs/${fromId}/dependencies/${toId}`,
    {
      method: 'DELETE',
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Removed dependency: ${fromId} no longer depends on ${toId}`);
  }
}

interface JobWithRelation extends Job {
  relation_type: string;
}

interface DependenciesResponse {
  dependencies: JobWithRelation[];
  dependents: JobWithRelation[];
  blocking: JobWithRelation[];
}

/**
 * eve jobs dep list <id>
 * Show dependencies and dependents for a job
 */
async function handleDepList(
  positionals: string[],
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs dep list <job-id>');
  }

  const response = await requestJson<DependenciesResponse>(
    context,
    `/jobs/${jobId}/dependencies`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    formatDependencies(response);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function requestJobContext(
  context: ResolvedContext,
  jobId: string,
): Promise<JobContextResponse | { job: Job }> {
  const response = await requestRaw(context, `/jobs/${jobId}/context`);

  if (response.ok) {
    return response.data as JobContextResponse;
  }

  if (response.status !== 404) {
    const message = typeof response.data === 'string' ? response.data : response.text;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  const job = await requestJson<Job>(context, `/jobs/${jobId}`);
  return { job };
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

/**
 * Get project ID from an existing job (used when creating child jobs)
 */
async function getProjectFromJob(context: ResolvedContext, jobId: string): Promise<string | undefined> {
  try {
    const job = await requestJson<Job>(context, `/jobs/${jobId}`);
    return job.project_id;
  } catch {
    return undefined;
  }
}

/**
 * Format jobs as a human-readable table
 */
function formatJobsTable(jobs: Job[]): void {
  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  // Calculate column widths
  const idWidth = Math.max(4, ...jobs.map((j) => j.id.length));
  const phaseWidth = Math.max(5, ...jobs.map((j) => j.phase.length));
  const titleWidth = Math.min(50, Math.max(5, ...jobs.map((j) => j.title.length)));

  // Header
  const header = [
    padRight('ID', idWidth),
    padRight('P', 2),
    padRight('Phase', phaseWidth),
    padRight('Type', 8),
    padRight('Title', titleWidth),
    'Assignee',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const job of jobs) {
    const title = job.title.length > titleWidth ? job.title.slice(0, titleWidth - 3) + '...' : job.title;
    const row = [
      padRight(job.id, idWidth),
      padRight(`P${job.priority}`, 2),
      padRight(job.phase, phaseWidth),
      padRight(job.issue_type, 8),
      padRight(title, titleWidth),
      job.assignee ?? '-',
    ].join('  ');

    console.log(row);
  }

  console.log('');
  console.log(`Total: ${jobs.length} job(s)`);
}

/**
 * Format a single job's details
 */
function formatJobDetails(job: Job): void {
  console.log(`Job: ${job.id}`);
  console.log('');
  console.log(`  Title:       ${job.title}`);
  console.log(`  Phase:       ${job.phase}`);
  console.log(`  Priority:    P${job.priority}`);
  console.log(`  Type:        ${job.issue_type}`);
  console.log(`  Project:     ${job.project_id}`);

  if (job.parent_id) {
    console.log(`  Parent:      ${job.parent_id}`);
  }

  console.log(`  Depth:       ${job.depth}`);

  if (job.description) {
    console.log(`  Description: ${job.description}`);
  }

  if (job.labels && job.labels.length > 0) {
    console.log(`  Labels:      ${job.labels.join(', ')}`);
  }

  if (job.assignee) {
    console.log(`  Assignee:    ${job.assignee}`);
  }

  console.log(`  Review:      ${job.review_required}`);
  if (job.review_status) {
    console.log(`  Review Status: ${job.review_status}`);
  }
  if (job.reviewer) {
    console.log(`  Reviewer:    ${job.reviewer}`);
  }

  if (job.defer_until) {
    console.log(`  Defer Until: ${job.defer_until}`);
  }

  if (job.due_at) {
    console.log(`  Due At:      ${job.due_at}`);
  }

  const hints = job.hints;
  if (hints && Object.keys(hints).length > 0) {
    console.log('');
    console.log('  Hints:');
    if (hints.worker_type) console.log(`    Worker Type:   ${hints.worker_type}`);
    if (hints.permission_policy) console.log(`    Permission:    ${hints.permission_policy}`);
    if (typeof hints.timeout_seconds === 'number') console.log(`    Timeout:       ${hints.timeout_seconds}s`);
    if (hints.resource_class) console.log(`    Resource Class: ${hints.resource_class}`);
    if (Array.isArray(hints.toolchains) && hints.toolchains.length > 0) {
      console.log(`    Toolchains:    ${hints.toolchains.join(', ')}`);
    }
    if (hints.max_tokens) console.log(`    Max Tokens:    ${hints.max_tokens}`);
    if (hints.max_cost) console.log(`    Max Cost:      ${hints.max_cost.amount} ${hints.max_cost.currency}`);
    if (hints.budget_blocked) {
      console.log(`    Budget Blocked:true${hints.budget_blocked_reason ? ` (${hints.budget_blocked_reason})` : ''}`);
    }
  }

  // Git configuration
  if (job.git && Object.keys(job.git).length > 0) {
    console.log('');
    console.log('  Git Controls:');
    if (job.git.ref) {
      console.log(`    Ref:            ${job.git.ref}`);
    }
    if (job.git.ref_policy) {
      console.log(`    Ref Policy:     ${job.git.ref_policy}`);
    }
    if (job.git.branch) {
      console.log(`    Branch:         ${job.git.branch}`);
    }
    if (job.git.create_branch) {
      console.log(`    Create Branch:  ${job.git.create_branch}`);
    }
    if (job.git.commit) {
      console.log(`    Commit:         ${job.git.commit}`);
    }
    if (job.git.commit_message) {
      console.log(`    Commit Msg:     ${job.git.commit_message}`);
    }
    if (job.git.push) {
      console.log(`    Push:           ${job.git.push}`);
    }
    if (job.git.remote) {
      console.log(`    Remote:         ${job.git.remote}`);
    }
  }

  // Token scope & permissions (set by workflow/pipeline expanders)
  const tokenPermissions = (job as { token_permissions?: string[] | null }).token_permissions;
  const tokenScope = (job as { token_scope?: Record<string, unknown> | null }).token_scope;
  if ((tokenPermissions && tokenPermissions.length > 0) || tokenScope) {
    console.log('');
    console.log('  Token:');
    if (tokenPermissions && tokenPermissions.length > 0) {
      console.log(`    Permissions:    ${tokenPermissions.join(', ')}`);
    }
    if (tokenScope) {
      console.log(`    Scope:          ${JSON.stringify(tokenScope)}`);
    }
  }

  // Workspace configuration
  if (job.workspace && Object.keys(job.workspace).length > 0) {
    console.log('');
    console.log('  Workspace:');
    if (job.workspace.mode) {
      console.log(`    Mode:           ${job.workspace.mode}`);
    }
    if (job.workspace.key) {
      console.log(`    Key:            ${job.workspace.key}`);
    }
  }

  // Resolved Git
  if (job.resolved_git) {
    const rg = job.resolved_git;
    console.log('');
    console.log('  Resolved Git:');
    if (rg.resolved_sha) console.log(`    SHA:      ${rg.resolved_sha}`);
    if (rg.resolved_branch) console.log(`    Branch:   ${rg.resolved_branch}`);
    if (rg.ref_source) console.log(`    Source:   ${rg.ref_source}`);
    if (rg.pushed !== undefined) console.log(`    Pushed:   ${rg.pushed}`);
    if (rg.commits?.length) console.log(`    Commits:  ${rg.commits.join(', ')}`);
  }

  console.log('');
  console.log(`  Created:     ${formatDate(job.created_at)}`);
  console.log(`  Updated:     ${formatDate(job.updated_at)}`);

  if (job.closed_at) {
    console.log(`  Closed:      ${formatDate(job.closed_at)}`);
  }

  if (job.close_reason) {
    console.log(`  Close Reason: ${job.close_reason}`);
  }
}

/**
 * Format attempts with verbose details (for --verbose flag)
 */
function formatAttemptsVerbose(
  attempts: JobAttempt[],
  latestAttempt?: JobAttemptWithResult,
): void {
  console.log('');
  console.log('Attempts:');

  for (const attempt of attempts) {
    const isLatest = latestAttempt && attempt.id === latestAttempt.id;
    const statusIcon = attempt.status === 'succeeded' ? '✓' :
                       attempt.status === 'failed' ? '✗' :
                       attempt.status === 'running' ? '▶' : '○';

    console.log(`  ${statusIcon} Attempt #${attempt.attempt_number} (${attempt.status})`);
    console.log(`      ID:       ${attempt.id}`);
    console.log(`      Started:  ${formatDate(attempt.started_at)}`);

    if (attempt.ended_at) {
      console.log(`      Ended:    ${formatDate(attempt.ended_at)}`);
    }

    if (attempt.harness) {
      console.log(`      Harness:  ${attempt.harness}`);
    }

    if (attempt.agent_id) {
      console.log(`      Agent:    ${attempt.agent_id}`);
    }

    // Show result details for latest attempt
    if (isLatest && latestAttempt?.result) {
      const r = latestAttempt.result;
      if (r.exitCode !== null) {
        console.log(`      Exit:     ${r.exitCode}`);
      }
      if (r.durationMs !== null) {
        console.log(`      Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
      }
      if (r.errorMessage) {
        console.log(`      Error:    ${r.errorMessage}`);
      }
      if (r.tokenInput || r.tokenOutput) {
        console.log(`      Tokens:   ${r.tokenInput || 0} in / ${r.tokenOutput || 0} out`);
      }
    }
    console.log('');
  }
}

/**
 * Format comprehensive diagnostic output
 */
function formatDiagnose(
  job: Job,
  attempts: JobAttempt[],
  latestResult: JobResultResponse | null,
  logs: DiagnoseLogEntry[],
  receipt: ExecutionReceiptV2Like | null,
  podStatus?: { pod_name: string; status: string; stale: boolean; last_heartbeat_at: string } | null,
): void {
  // Header
  console.log('╭────────────────────────────────────────────────────────────────╮');
  console.log(`│ Job Diagnosis: ${job.id.padEnd(47)} │`);
  console.log('╰────────────────────────────────────────────────────────────────╯');
  console.log('');

  // Status summary
  // Note: 'failed' is not a valid job phase - failures are 'cancelled' with a close_reason
  const statusIcon = job.phase === 'done' ? '✓' :
                     job.phase === 'cancelled' ? '⊘' :
                     job.phase === 'active' ? '▶' : '○';
  console.log(`Status: ${statusIcon} ${job.phase.toUpperCase()}`);
  if (job.phase === 'cancelled' && (job as any).failure_disposition) {
    console.log(`  Disposition: ${(job as any).failure_disposition}`);
  }
  console.log(`  Priority:  P${job.priority}`);
  console.log(`  Assignee:  ${job.assignee || '(none)'}`);
  if ((job as any).actor_user_id) {
    console.log(`  Created by: ${(job as any).actor_user_id}`);
  }
  console.log(`  Created:   ${formatDate(job.created_at)}`);
  console.log(`  Updated:   ${formatDate(job.updated_at)}`);
  console.log('');

  // Token scope & permissions (set by workflow/pipeline expanders)
  const diagTokenPermissions = (job as { token_permissions?: string[] | null }).token_permissions;
  const diagTokenScope = (job as { token_scope?: Record<string, unknown> | null }).token_scope;
  if ((diagTokenPermissions && diagTokenPermissions.length > 0) || diagTokenScope) {
    console.log('Token:');
    if (diagTokenPermissions && diagTokenPermissions.length > 0) {
      console.log(`  Permissions: ${diagTokenPermissions.join(', ')}`);
    }
    if (diagTokenScope) {
      console.log(`  Scope:       ${JSON.stringify(diagTokenScope)}`);
    }
    const misalignment = detectTokenMisalignment(diagTokenPermissions ?? null, diagTokenScope ?? null);
    for (const warning of misalignment) {
      console.log(`  ⚠ ${warning}`);
    }
    console.log('');
  }

  if (job.hints?.budget_blocked) {
    console.log('Budget: BLOCKED');
    if (job.hints.budget_blocked_reason) {
      console.log(`  Reason: ${job.hints.budget_blocked_reason}`);
    }
    console.log('');
  } else if (job.hints?.max_cost || job.hints?.max_tokens) {
    console.log('Budget:');
    if (job.hints.max_cost) {
      console.log(`  Max cost:   ${job.hints.max_cost.amount} ${job.hints.max_cost.currency}`);
    }
    if (job.hints.max_tokens) {
      console.log(`  Max tokens: ${job.hints.max_tokens}`);
    }
    console.log('');
  }

  const toolchains = Array.isArray(job.hints?.toolchains) ? job.hints.toolchains : [];
  if (toolchains.length > 0) {
    console.log('Toolchains:');
    console.log(`  Requested: ${toolchains.join(', ')}`);
    if (job.execution_type === 'script' || (job.execution_type === 'action' && (job as any).action_type === 'run')) {
      console.log('  Runtime:   worker local cache (/opt/eve/toolchains)');
    } else if (job.execution_type === 'agent') {
      console.log('  Runtime:   agent-runtime inline cache or runner pod');
    }
    console.log('');
  }

  const retryPolicy = (job.hints as any)?.retry;
  if (retryPolicy) {
    console.log('Retry Policy:');
    console.log(`  Max Attempts: ${retryPolicy.max_attempts}`);
    console.log(`  Backoff:      ${retryPolicy.backoff_seconds ?? 60}s x${retryPolicy.backoff_multiplier ?? 2}`);
    if (retryPolicy.retryable_errors) {
      console.log(`  Retryable:    [${retryPolicy.retryable_errors.join(', ')}]`);
    }
    if (attempts.length > 0) {
      console.log(`  Attempts:     ${attempts.length}/${retryPolicy.max_attempts}`);
    }
    console.log('');
  }

  // Title and description
  console.log(`Title: ${job.title}`);
  if (job.description && job.description !== job.title) {
    const desc = job.description.length > 200
      ? job.description.substring(0, 200) + '...'
      : job.description;
    console.log(`Description: ${desc}`);
  }
  console.log('');

  // Attempts timeline
  console.log('Timeline:');
  console.log(`  ${formatDate(job.created_at)} - Job created (phase: ready)`);

  for (const attempt of attempts) {
    const statusIcon = attempt.status === 'succeeded' ? '✓' :
                       attempt.status === 'failed' ? '✗' :
                       attempt.status === 'running' ? '▶' : '○';
    console.log(`  ${formatDate(attempt.started_at)} - Attempt #${attempt.attempt_number} started`);
    if (attempt.ended_at) {
      console.log(`  ${formatDate(attempt.ended_at)} - Attempt #${attempt.attempt_number} ${statusIcon} ${attempt.status}`);
    }
  }

  if (job.closed_at) {
    console.log(`  ${formatDate(job.closed_at)} - Job closed (${job.phase})`);
  }
  console.log('');

  // Latency waterfall from lifecycle logs
  const lifecycleLogs = logs.filter(l => l.type?.startsWith('lifecycle_'));
  if (lifecycleLogs.length > 0) {
    const BAR_WIDTH = 16;

    // Collect completed phases with duration
    const phases: Array<{ name: string; durationMs: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const log of lifecycleLogs) {
      const content = log.line as Record<string, unknown>;
      const phase = content?.phase as string || 'unknown';
      const action = content?.action as string || '';
      const durationMs = content?.duration_ms as number | undefined;
      const success = content?.success as boolean | undefined;
      const error = content?.error as string | undefined;

      if (action === 'end') {
        if (typeof durationMs === 'number') {
          phases.push({ name: phase, durationMs });
        }
        if (success === false && error) {
          errors.push({ name: phase, error: error.split('\n')[0] });
        }
      }
    }

    if (phases.length > 0) {
      const totalMs = phases.reduce((sum, p) => sum + p.durationMs, 0);
      const maxNameLen = Math.max(...phases.map(p => p.name.length));
      const maxDurStr = Math.max(...phases.map(p => p.durationMs.toLocaleString('en-US').length + 2)); // +2 for "ms"

      console.log('Latency Breakdown:');
      for (const phase of phases) {
        const pct = totalMs > 0 ? phase.durationMs / totalMs : 0;
        const filled = Math.round(pct * BAR_WIDTH);
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);
        const durStr = (phase.durationMs.toLocaleString('en-US') + 'ms').padStart(maxDurStr);
        const pctStr = (Math.round(pct * 100) + '%').padStart(4);
        console.log(`  ${phase.name.padEnd(maxNameLen)}  ${durStr}  ${bar} ${pctStr}`);
      }

      const separator = '\u2500'.repeat(maxNameLen + maxDurStr + BAR_WIDTH + 8);
      console.log(`  ${separator}`);
      const totalStr = (totalMs.toLocaleString('en-US') + 'ms').padStart(maxDurStr);
      console.log(`  ${'Total'.padEnd(maxNameLen)}  ${totalStr}`);
      console.log('');
    }

    // Show phase errors separately
    if (errors.length > 0) {
      for (const err of errors) {
        console.log(`  \u2717 ${err.name}: ${err.error}`);
      }
      console.log('');
    }
  }

  // Routing decision from logs
  const routingLogs = logs.filter(l => l.type === 'routing');
  if (routingLogs.length > 0) {
    const routingLog = routingLogs[routingLogs.length - 1]; // Use the latest routing entry
    const content = routingLog.line as Record<string, unknown>;
    const target = content?.target as string || 'unknown';
    const harness = content?.harness as string || 'unknown';
    const harnessSource = content?.harness_source as string || 'unknown';
    const harnessChecked = Array.isArray(content?.harness_checked)
      ? (content.harness_checked as string[]).join(', ')
      : 'unknown';
    const agentId = content?.agent_id as string || '(none)';
    const budget = content?.budget as Record<string, unknown> | undefined;

    console.log('Routing:');
    console.log(`  Target:    ${target}`);
    console.log(`  Harness:   ${harness} (source: ${harnessSource}, checked: [${harnessChecked}])`);
    console.log(`  Agent:     ${agentId}`);
    if (budget) {
      const maxTokens = budget.max_tokens != null ? `max_tokens=${budget.max_tokens}` : null;
      const maxCost = budget.max_cost != null ? `max_cost=$${budget.max_cost}` : null;
      const parts = [maxTokens, maxCost].filter(Boolean);
      if (parts.length > 0) {
        console.log(`  Budget:    ${parts.join(', ')}`);
      }
    }
    console.log('');
  }

  // Latest attempt details
  if (attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    console.log(`Latest Attempt (#${latest.attempt_number}):`);
    console.log(`  Status:    ${latest.status}`);
    console.log(`  Harness:   ${latest.harness || '(default)'}`);
    console.log(`  Agent:     ${latest.agent_id || '(none)'}`);
    if (latest.execution_started_at) {
      console.log(`  Accepted:  ${formatDate(latest.execution_started_at)}`);
    }

    // Show pod name from runtime_meta
    const podName = latest.runtime_meta?.pod_name as string | undefined;
    if (podName) {
      if (podStatus) {
        const hbAge = Math.round((Date.now() - new Date(podStatus.last_heartbeat_at).getTime()) / 1000);
        const healthLabel = podStatus.stale ? 'stale' : podStatus.status;
        console.log(`  Pod:       ${podName} (${healthLabel}, heartbeat ${hbAge}s ago)`);
      } else {
        console.log(`  Pod:       ${podName}`);
      }
    }

    const errorCode = getAttemptErrorCode(latest, latestResult);
    if (errorCode) {
      console.log(`  Error Code: ${errorCode}`);
    }

    const runtimeToolchains = readRuntimeToolchainMeta(latest.runtime_meta);
    if (runtimeToolchains) {
      console.log('  Toolchains:');
      console.log(`    Mode:     ${runtimeToolchains.execution_mode ?? 'unknown'}`);
      console.log(`    Requested:${formatUnknownStringList(runtimeToolchains.requested)}`);
      console.log(`    Resolved: ${formatUnknownStringList(runtimeToolchains.resolved)}`);
      console.log(`    Missing:  ${formatUnknownStringList(runtimeToolchains.missing)}`);
      if (runtimeToolchains.source) {
        console.log(`    Source:   ${runtimeToolchains.source}`);
      }
    }

    // Surface most recent heartbeat from lifecycle logs
    const heartbeatLogs = logs.filter(l => {
      const content = l.line as Record<string, unknown>;
      return l.type?.startsWith('lifecycle_') && content?.phase === 'runner' && content?.action === 'log' && (content?.meta as Record<string, unknown>)?.kind === 'heartbeat';
    });
    if (heartbeatLogs.length > 0) {
      const lastHb = heartbeatLogs[heartbeatLogs.length - 1];
      const hbTime = new Date(lastHb.timestamp).getTime();
      const hbAge = Math.round((Date.now() - hbTime) / 1000);
      const hbMeta = (lastHb.line as Record<string, unknown>)?.meta as Record<string, unknown> | undefined;
      const elapsed = typeof hbMeta?.elapsed_ms === 'number' ? Math.round(hbMeta.elapsed_ms / 1000) : null;
      console.log(`  Heartbeat: ${hbAge}s ago${elapsed !== null ? ` (${elapsed}s into execution)` : ''}`);
    }

    if (latestResult) {
      if (latestResult.exitCode !== null) {
        console.log(`  Exit Code: ${latestResult.exitCode}`);
      }
      if (latestResult.durationMs !== null) {
        console.log(`  Duration:  ${(latestResult.durationMs / 1000).toFixed(1)}s`);
      }
      if (latestResult.errorMessage) {
        console.log('');
        console.log('Error Message:');
        console.log(`  ${latestResult.errorMessage}`);
      }
    }
    console.log('');

    const hydration = latest.runtime_meta?.resource_hydration as Record<string, unknown> | undefined;
    if (hydration) {
      const resolved = hydration.resolved_count ?? 0;
      const missingOptional = hydration.missing_optional_count ?? 0;
      const failedRequired = hydration.failed_required_count ?? 0;
      const resources = Array.isArray(hydration.resources) ? hydration.resources : [];
      const resourceIndexPath = latest.runtime_meta?.resource_index_path as string | undefined;

      console.log('Resources:');
      console.log(`  Resolved: ${resolved} | Optional missing: ${missingOptional} | Required failed: ${failedRequired}`);
      if (resourceIndexPath) {
        console.log(`  Index: ${resourceIndexPath}`);
      }
      for (const entry of resources) {
        const resource = entry as Record<string, unknown>;
        const status = resource.status ?? 'unknown';
        const uri = resource.uri ?? '';
        const localPath = resource.local_path ?? '';
        const errorCode = resource.error_code ? ` (${resource.error_code})` : '';
        console.log(`  - ${status}: ${uri}${errorCode}`);
        if (localPath) {
          console.log(`    path: ${localPath}`);
        }
      }
      console.log('');
    }

    const llmRouting = latest.runtime_meta?.llm_routing as Record<string, unknown> | undefined;
    if (llmRouting) {
      const mode = llmRouting.mode === 'bridge' ? 'bridge' : 'direct';
      const bridgeId = typeof llmRouting.bridge_id === 'string' ? llmRouting.bridge_id : null;
      const harnessCompat =
        typeof llmRouting.harness_compatibility === 'string'
          ? llmRouting.harness_compatibility
          : 'unknown';
      const providerCompat =
        typeof llmRouting.provider_compatibility === 'string'
          ? llmRouting.provider_compatibility
          : 'unknown';
      const effectiveBaseUrl =
        typeof llmRouting.effective_base_url === 'string'
          ? redactUrlForDisplay(llmRouting.effective_base_url)
          : null;

      console.log('LLM Routing:');
      console.log(`  Mode:               ${mode}`);
      console.log(`  Harness Protocol:   ${harnessCompat}`);
      console.log(`  Provider Protocol:  ${providerCompat}`);
      if (bridgeId) {
        console.log(`  Bridge ID:          ${bridgeId}`);
      }
      if (effectiveBaseUrl) {
        console.log(`  Effective Base URL: ${effectiveBaseUrl}`);
      }
      console.log('');
    }
  }

  if (receipt) {
    console.log('Receipt Summary:');
    console.log(`  Base:   ${formatMoney(receipt.base_cost_usd?.total_usd)}`);
    console.log(`  Billed: ${formatMoney(receipt.billed_cost?.total)}`);
    console.log('');
  }

  // Recent logs
  if (logs.length > 0) {
    console.log('Recent Logs:');
    const recentLogs = logs.slice(-10);
    for (const log of recentLogs) {
      const time = formatDate(log.timestamp);
      let msg = '';
      try {
        msg = log.line != null
          ? JSON.stringify(log.line).substring(0, 100)
          : '(empty)';
      } catch {
        msg = '(error formatting log)';
      }
      console.log(`  ${time} ${msg}`);
    }
    console.log('');
  }

  // DeployFailure surfacing — scan attempt logs for a structured error_context
  // left by the deployer and render the kind + hint + cluster snapshot.
  renderDeployFailureBlock(logs);

  // Diagnosis / recommendations
  console.log('Diagnosis:');
  if (job.phase === 'done') {
    console.log('  ✓ Job completed successfully');
  } else if (job.phase === 'cancelled') {
    const latest = attempts[attempts.length - 1];
    const classifiedErrorCode = getAttemptErrorCode(latest, latestResult);
    if (renderClassifiedJobFailure(classifiedErrorCode)) {
      return;
    }

    const agentRuntimeError = findAgentRuntimeError(job, latestResult);
    if (agentRuntimeError) {
      console.log('  ✗ Agent runtime error');
      console.log(`    ${agentRuntimeError}`);
      console.log('    Hint: Check agent runtime status and logs:');
      console.log('      eve system status');
      console.log('      eve system logs agent-runtime --tail 200');
      console.log('      eve system pods');
      console.log('');
      return;
    }
    // Cancelled jobs may have a failure reason in close_reason or attempt error
    if (latestResult?.errorMessage?.includes('No protocol bridge')) {
      console.log('  ✗ Protocol bridge routing failed');
      console.log('    Hint: Configure a bridge for this harness/provider protocol pair');
      console.log('    Hint: Verify bridge registry and managed model harness/provider settings');
    } else if (latestResult?.errorMessage?.includes('Bridge') && latestResult.errorMessage.includes('missing')) {
      console.log('  ✗ Bridge runtime configuration missing');
      console.log('    Hint: Set EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_URL and EVE_BRIDGE_LITELLM_ANTHROPIC_OPENAI_KEY');
    } else if (latestResult?.errorMessage?.includes('git clone')) {
      console.log('  ✗ Git clone failed - check repo URL and credentials');
      console.log('    Hint: Ensure GITHUB_TOKEN is set in project/org secrets');
    } else if (latestResult?.errorMessage?.includes('Service')) {
      console.log('  ✗ Service provisioning failed');
      console.log('    Hint: Check .eve/services.yaml and container logs');
    } else if (latestResult?.errorMessage) {
      console.log(`  ⊘ Cancelled: ${latestResult.errorMessage}`);
    } else if (job.close_reason) {
      console.log(`  ⊘ Cancelled: ${job.close_reason}`);
    } else {
      console.log('  ⊘ Job was cancelled');
    }
  } else if (job.phase === 'active' && attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    if (latest.status === 'running') {
      const startedAt = new Date(latest.started_at).getTime();
      const elapsed = Math.round((Date.now() - startedAt) / 1000);

      // Find most recent heartbeat for stuck detection
      const activeHeartbeats = logs.filter(l => {
        const content = l.line as Record<string, unknown>;
        return l.type?.startsWith('lifecycle_') && content?.phase === 'runner' && content?.action === 'log' && (content?.meta as Record<string, unknown>)?.kind === 'heartbeat';
      });

      if (activeHeartbeats.length > 0) {
        const lastHb = activeHeartbeats[activeHeartbeats.length - 1];
        const hbAge = Math.round((Date.now() - new Date(lastHb.timestamp).getTime()) / 1000);
        if (hbAge > 120) {
          console.log(`  ⚠ No harness heartbeat for ${hbAge}s — process may have crashed`);
          console.log(`    Hint: Run \`eve job logs ${job.id}\` for recent output`);
        } else {
          console.log(`  ▶ Harness alive (last heartbeat ${hbAge}s ago, ${elapsed}s elapsed)`);
        }
      } else if (elapsed > 300) {
        console.log(`  ⚠ Attempt running for ${elapsed}s — no heartbeat data available`);
        console.log('    Hint: Check orchestrator/worker logs');
      } else {
        console.log(`  ▶ Attempt in progress (${elapsed}s elapsed)`);
      }
    }
  } else if (job.phase === 'ready') {
    console.log('  ○ Job is ready, waiting to be claimed');
    if (job.assignee) {
      console.log(`    Assigned to: ${job.assignee}`);
    }
  }
}

function findAgentRuntimeError(job: Job, latestResult: JobResultResponse | null): string | null {
  const candidates = [latestResult?.errorMessage, job.close_reason].filter(Boolean) as string[];
  for (const message of candidates) {
    if (message.includes('Agent runtime')) {
      return message;
    }
  }
  return null;
}

function getAttemptErrorCode(
  latest: JobAttempt | undefined,
  latestResult: JobResultResponse | null,
): string | null {
  return readResultErrorCode(latestResult?.resultJson)
    ?? readResultErrorCode(latest?.result_json)
    ?? null;
}

export function readResultErrorCode(value: unknown): string | null {
  let record: Record<string, unknown> | null = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    record = value as Record<string, unknown>;
  } else if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  const errorCode = record?.error_code;
  return typeof errorCode === 'string' && errorCode.length > 0 ? errorCode : null;
}

function readRuntimeToolchainMeta(
  runtimeMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const toolchains = runtimeMeta?.toolchains;
  if (!toolchains || typeof toolchains !== 'object' || Array.isArray(toolchains)) return null;
  return toolchains as Record<string, unknown>;
}

function formatUnknownStringList(value: unknown): string {
  if (!Array.isArray(value)) return ' (unknown)';
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length > 0 ? ` ${entries.join(', ')}` : ' (none)';
}

function renderClassifiedJobFailure(errorCode: string | null): boolean {
  switch (errorCode) {
    case 'toolchain_unavailable':
      console.log('  ✗ Toolchain provisioning failed');
      console.log('    Hint: Check runtime_meta.toolchains, job logs, and EVE_TOOLCHAIN_IMAGE_* registry settings');
      console.log('    Hint: Verify the requested toolchain image exists and crane can read the registry');
      return true;
    case 'attempt_init_timeout':
      console.log('  ✗ Attempt initialization timed out');
      console.log('    Hint: The runtime did not acknowledge execution before EVE_ORCH_ATTEMPT_INIT_TIMEOUT_SECONDS');
      console.log('    Hint: Check orchestrator, worker, agent-runtime, and toolchain provisioning logs');
      return true;
    case 'attempt_startup_timeout':
      console.log('  ✗ Attempt startup timed out');
      console.log('    Hint: The runtime acknowledged execution but no harness start log was recorded before EVE_ORCH_ATTEMPT_STARTUP_TIMEOUT_SECONDS');
      console.log('    Hint: Check secrets, workspace setup, toolchain provisioning, and harness binary resolution');
      return true;
    case 'attempt_timeout':
      console.log('  ✗ Attempt exceeded its configured timeout');
      console.log('    Hint: Increase timeout_seconds only if the job is expected to run this long');
      return true;
    case 'attempt_stale':
      console.log('  ✗ Attempt went stale');
      console.log('    Hint: No progress logs were recorded before the stale watchdog failed the attempt');
      return true;
    default:
      return false;
  }
}

interface DiagnoseLogEntry {
  sequence: number;
  timestamp: string;
  type?: string;
  line: Record<string, unknown>;
}

interface DiagnoseLogsResponse {
  logs: DiagnoseLogEntry[];
}

/**
 * Format job hierarchy as a tree
 */
function formatJobTree(node: JobTreeNode, indent: number): void {
  const prefix = indent === 0 ? '' : '  '.repeat(indent - 1) + (indent > 0 ? '|- ' : '');
  const phaseIcon = getPhaseIcon(node.phase);
  const line = `${prefix}${phaseIcon} ${node.id} [P${node.priority}] ${node.title}`;

  console.log(line);

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      formatJobTree(child, indent + 1);
    }
  }
}

/**
 * Get an ASCII icon for a phase
 */
function getPhaseIcon(phase: string): string {
  switch (phase) {
    case 'idea':
      return '[?]';
    case 'backlog':
      return '[ ]';
    case 'ready':
      return '[>]';
    case 'active':
      return '[*]';
    case 'review':
      return '[R]';
    case 'done':
      return '[x]';
    case 'cancelled':
      return '[-]';
    default:
      return '[ ]';
  }
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

function redactUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Format dependencies output
 */
function formatDependencies(response: DependenciesResponse): void {
  console.log('');

  // Dependencies (jobs this one depends on)
  if (response.dependencies.length > 0) {
    console.log('Dependencies (this job depends on):');
    for (const dep of response.dependencies) {
      const phaseIcon = getPhaseIcon(dep.phase);
      const isBlocking = response.blocking.some((b) => b.id === dep.id);
      const blockingWarning = isBlocking ? ' ⚠️  BLOCKING' : '';
      const relationType = dep.relation_type !== 'blocks' ? ` (${dep.relation_type})` : '';
      console.log(`  ${dep.id} ${phaseIcon} "${dep.title}"${relationType}${blockingWarning}`);
    }
  } else {
    console.log('Dependencies (this job depends on): None');
  }

  console.log('');

  // Dependents (jobs that depend on this one)
  if (response.dependents.length > 0) {
    console.log('Dependents (jobs depending on this):');
    for (const dependent of response.dependents) {
      const phaseIcon = getPhaseIcon(dependent.phase);
      const relationType = dependent.relation_type !== 'blocks' ? ` (${dependent.relation_type})` : '';
      console.log(`  ${dependent.id} ${phaseIcon} "${dependent.title}"${relationType}`);
    }
  } else {
    console.log('Dependents (jobs depending on this): None');
  }

  console.log('');
}

/**
 * eve jobs claim <id> [--agent=X] [--harness=X]
 * Claims a job, creating an attempt and transitioning to active phase
 */
async function handleClaim(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs claim <job-id> [--agent=X] [--harness=X]');
  }

  const agentId = getStringFlag(flags, ['agent']) ?? 'cli-user';
  const harness = getStringFlag(flags, ['harness']);

  const body: Record<string, unknown> = {
    agent_id: agentId,
  };

  if (harness) {
    body.harness = harness;
  }

  const response = await requestJson<{ attempt: JobAttempt }>(
    context,
    `/jobs/${jobId}/claim`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Claimed job: ${jobId}`);
    console.log('');
    console.log(`  Attempt:     #${response.attempt.attempt_number}`);
    console.log(`  Attempt ID:  ${response.attempt.id}`);
    console.log(`  Status:      ${response.attempt.status}`);
    console.log(`  Agent:       ${response.attempt.agent_id}`);
    if (response.attempt.harness) {
      console.log(`  Harness:     ${response.attempt.harness}`);
    }
    console.log(`  Started:     ${formatDate(response.attempt.started_at)}`);
  }
}

/**
 * eve jobs release <id> [--agent=X] [--reason="..."]
 * Releases a job, ending the current attempt and setting back to ready
 */
async function handleRelease(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs release <job-id> [--agent=X] [--reason="..."]');
  }

  const agentId = getStringFlag(flags, ['agent']) ?? 'cli-user';
  const reason = getStringFlag(flags, ['reason']);

  const body: Record<string, unknown> = {
    agent_id: agentId,
  };

  if (reason) {
    body.reason = reason;
  }

  const response = await requestJson<{ job: Job }>(
    context,
    `/jobs/${jobId}/release`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Released job: ${jobId}`);
    console.log('');
    console.log(`  Phase:       ${response.job.phase}`);
    console.log(`  Assignee:    ${response.job.assignee ?? '(none)'}`);
    if (reason) {
      console.log(`  Reason:      ${reason}`);
    }
  }
}

/**
 * eve jobs attempts <id>
 * Lists all attempts for a job
 */
async function handleAttempts(
  positionals: string[],
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs attempts <job-id>');
  }

  const response = await requestJson<JobAttemptListResponse>(
    context,
    `/jobs/${jobId}/attempts`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.attempts.length === 0) {
      console.log('No attempts found for this job.');
      return;
    }

    console.log(`Attempts for job: ${jobId}`);
    console.log('');

    for (const attempt of response.attempts) {
      const statusIcon = getStatusIcon(attempt.status);
      const duration = attempt.ended_at
        ? formatDuration(attempt.started_at, attempt.ended_at)
        : 'running';

      console.log(`${statusIcon} Attempt #${attempt.attempt_number} (${attempt.id})`);
      console.log(`  Status:      ${attempt.status}`);
      console.log(`  Trigger:     ${attempt.trigger_type}`);
      if (attempt.agent_id) {
        console.log(`  Agent:       ${attempt.agent_id}`);
      }
      if (attempt.harness) {
        console.log(`  Harness:     ${attempt.harness}`);
      }
      console.log(`  Started:     ${formatDate(attempt.started_at)}`);
      if (attempt.ended_at) {
        console.log(`  Ended:       ${formatDate(attempt.ended_at)}`);
      }
      console.log(`  Duration:    ${duration}`);
      if (attempt.result_summary) {
        console.log(`  Summary:     ${attempt.result_summary}`);
      }
      console.log('');
    }

    console.log(`Total: ${response.attempts.length} attempt(s)`);
  }
}

interface LogEntry {
  sequence: number;
  timestamp: string;
  type?: string;
  line: Record<string, unknown>;
}

interface LogsResponse {
  logs: LogEntry[];
}

/**
 * eve jobs logs <id> [--attempt=N] [--after=N] [--follow] [--summary]
 * View execution logs for a job attempt
 */
async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs logs <job-id> [--attempt=N] [--after=N] [--summary]');
  }

  const summaryMode = Boolean(flags.summary);

  // Get attempt number (default to latest)
  const attemptStr = getStringFlag(flags, ['attempt']);
  let attemptNum: number;

  if (attemptStr) {
    attemptNum = parseInt(attemptStr, 10);
  } else {
    // Find the latest attempt
    const attemptsResponse = await requestJson<{ attempts: JobAttempt[] }>(
      context,
      `/jobs/${jobId}/attempts`,
    );
    if (attemptsResponse.attempts.length === 0) {
      console.log('No attempts found for this job.');
      return;
    }
    attemptNum = Math.max(...attemptsResponse.attempts.map(a => a.attempt_number));
  }

  const afterStr = getStringFlag(flags, ['after']);
  const afterQuery = afterStr ? `?after=${afterStr}` : '';

  const response = await requestJson<LogsResponse>(
    context,
    `/jobs/${jobId}/attempts/${attemptNum}/logs${afterQuery}`,
  );

  if (json) {
    outputJson(response, json);
  } else if (summaryMode) {
    if (response.logs.length === 0) {
      console.log(`No logs found for attempt #${attemptNum}.`);
      return;
    }

    console.log(`Logs for job ${jobId}, attempt #${attemptNum} (summary):`);
    console.log('');

    // Reset summary counters for the static logs pass
    summaryLlmCallCount = 0;
    summaryLlmTotalMicroUsd = 0n;
    summaryLlmTotalInputTokens = 0;
    summaryLlmTotalOutputTokens = 0;
    summaryToolUseCount = 0;
    summaryLastLlmEmitCount = 0;
    summaryLastLlmEmitTime = Date.now();
    summaryStartTime = Date.now();

    for (const log of response.logs) {
      // Convert LogEntry to SSELogEvent shape for the shared formatter
      const sseEvent: SSELogEvent = {
        sequence: log.sequence,
        timestamp: log.timestamp,
        type: log.type || (log.line.type as string) || 'log',
        line: log.line,
      };
      const line = formatFollowSummaryLine(sseEvent);
      if (line) console.log(line);
    }

    // Force-flush any pending LLM aggregate
    const pending = flushSummaryLlmAggregate(true);
    if (pending) console.log(pending);

    console.log('');
    console.log('--- Summary ---');
    console.log(`Log entries:  ${response.logs.length}`);
    console.log(`LLM calls:   ${summaryLlmCallCount}`);
    console.log(`Tokens:      ${formatNumber(summaryLlmTotalInputTokens)} in / ${formatNumber(summaryLlmTotalOutputTokens)} out`);
    console.log(`Cost:        ~$${formatFixed6Usd(summaryLlmTotalMicroUsd)}`);
    console.log(`Tool uses:   ${summaryToolUseCount}`);
  } else {
    if (response.logs.length === 0) {
      console.log(`No logs found for attempt #${attemptNum}.`);
      return;
    }

    console.log(`Logs for job ${jobId}, attempt #${attemptNum}:`);
    console.log('');

    for (const log of response.logs) {
      formatLogEntry(log);
    }

    console.log('');
    console.log(`Total: ${response.logs.length} log entries`);
  }
}

/**
 * Format a single log entry for display
 */
function formatLogEntry(log: LogEntry): void {
  const line = log.line;
  const timestamp = new Date(log.timestamp).toLocaleTimeString();

  // Common log line formats from harnesses
  // Type can be at top level (from API) or inside line (from content)
  const type = log.type || (line.type as string) || 'log';

  // If type starts with 'lifecycle_', format as lifecycle event
  if (type.startsWith('lifecycle_')) {
    const content = line as Record<string, unknown>;
    const phase = content.phase as string || 'unknown';
    const action = content.action as string || 'unknown';
    const duration = content.duration_ms as number | undefined;
    const success = content.success as boolean | undefined;
    const error = content.error as string | undefined;
    const meta = content.meta as Record<string, unknown> || {};

    if (action === 'start') {
      const detail = formatLifecycleMeta(phase, meta);
      console.log(`[${timestamp}] ${getLifecycleIcon(phase)} Starting ${phase}${detail}...`);
    } else if (action === 'end') {
      const durationStr = duration ? ` (${duration}ms)` : '';
      if (success === false && error) {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} failed${durationStr}: ${error}`);
      } else {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} completed${durationStr}`);
      }
    } else if (action === 'log') {
      const msg = (meta.message as string) || JSON.stringify(meta);
      console.log(`[${timestamp}]   > ${msg}`);
    }
    return;
  }

  // Normalize NormalizedEvent wrappers (from eve-agent-cli) into a flat shape
  const normalized = normalizeLogLine(line);
  const nType = normalized.type;
  if (nType === 'skip') return;

  const message = normalized.message || (line.message as string) || (line.text as string) || '';
  const tool = normalized.tool || (line.tool as string) || undefined;
  const toolInput = normalized.toolInput || (line.tool_input as string) || undefined;
  const toolResult = line.tool_result as string | undefined;

  // Format based on log type
  switch (nType) {
    case 'assistant':
    case 'text':
      if (message) {
        console.log(`[${timestamp}] ${message}`);
      }
      break;
    case 'tool_use':
      if (tool) {
        const inputPreview = toolInput ? ` ${toolInput.substring(0, 80)}${toolInput.length > 80 ? '...' : ''}` : '';
        console.log(`[${timestamp}]   ${tool}${inputPreview}`);
      }
      break;
    case 'tool_result':
      const resultPreview = (toolResult || normalized.message || '').substring(0, 100);
      if (resultPreview) {
        console.log(`[${timestamp}]    -> ${resultPreview}${(toolResult?.length || 0) > 100 ? '...' : ''}`);
      }
      break;
    case 'error':
      console.log(`[${timestamp}] Error: ${message || JSON.stringify(line)}`);
      break;
    case 'status':
      if (message) {
        console.log(`[${timestamp}]   > ${message}`);
      }
      break;
    default:
      // Generic output for unknown types — show message if available, otherwise JSON
      if (message) {
        console.log(`[${timestamp}] ${message}`);
      } else if (Object.keys(line).length > 0) {
        console.log(`[${timestamp}] ${JSON.stringify(line)}`);
      }
  }
}

/**
 * Get icon for lifecycle phase
 */
function getLifecycleIcon(phase: string): string {
  switch (phase) {
    case 'workspace': return '📁';
    case 'hook': return '🪝';
    case 'secrets': return '🔐';
    case 'services': return '🐳';
    case 'harness': return '🤖';
    case 'runner': return '☸️';
    default: return '⚙️';
  }
}

/**
 * Capitalize first letter of string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format lifecycle metadata for display
 */
function formatLifecycleMeta(phase: string, meta: Record<string, unknown>): string {
  switch (phase) {
    case 'workspace':
      const repoUrl = meta.repo_url as string || '';
      const branch = meta.branch as string || '';
      return branch ? ` (${repoUrl}@${branch})` : repoUrl ? ` (${repoUrl})` : '';
    case 'hook':
      return meta.hook_name ? ` "${meta.hook_name}"` : '';
    case 'secrets':
      return '';
    case 'services':
      const svcName = meta.service_name as string || '';
      return svcName ? ` "${svcName}"` : '';
    case 'harness':
      return meta.harness ? ` ${meta.harness}` : '';
    case 'runner':
      return meta.pod_name ? ` (${meta.pod_name})` : '';
    default:
      return '';
  }
}

/**
 * eve jobs submit <id> --summary="..."
 * Submit a job for review
 */
async function handleSubmit(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs submit <job-id> --summary="..."');
  }

  const summary = getStringFlag(flags, ['summary']);

  if (!summary) {
    throw new Error('--summary is required');
  }

  // Use a default agent ID if not provided (could be from context in future)
  const agentId = getStringFlag(flags, ['agent-id']) ?? 'cli-user';

  const body = {
    agent_id: agentId,
    summary,
  };

  const response = await requestJson<Job>(context, `/jobs/${jobId}/submit`, {
    method: 'POST',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Submitted job for review: ${response.id}`);
    console.log(`  Phase:         ${response.phase}`);
    console.log(`  Review Status: ${response.review_status ?? 'N/A'}`);
    console.log(`  Summary:       ${summary}`);
  }
}

/**
 * eve jobs approve <id> [--comment="..."]
 * Approve a job in review
 */
async function handleApprove(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs approve <job-id> [--comment="..."]');
  }

  const comment = getStringFlag(flags, ['comment']);
  const reviewerId = getStringFlag(flags, ['reviewer-id']) ?? 'cli-user';

  const body: Record<string, unknown> = {
    reviewer_id: reviewerId,
  };

  if (comment) {
    body.comment = comment;
  }

  const response = await requestJson<Job>(context, `/jobs/${jobId}/approve`, {
    method: 'POST',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Approved job: ${response.id}`);
    console.log(`  Phase:         ${response.phase}`);
    console.log(`  Review Status: ${response.review_status ?? 'N/A'}`);
    console.log(`  Reviewer:      ${response.reviewer ?? 'N/A'}`);
    if (comment) {
      console.log(`  Comment:       ${comment}`);
    }
  }
}

/**
 * eve jobs reject <id> --reason="..."
 * Reject a job in review
 */
async function handleReject(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs reject <job-id> --reason="..."');
  }

  const reason = getStringFlag(flags, ['reason']);

  if (!reason) {
    throw new Error('--reason is required');
  }

  const reviewerId = getStringFlag(flags, ['reviewer-id']) ?? 'cli-user';

  const body = {
    reviewer_id: reviewerId,
    reason,
  };

  const response = await requestJson<Job>(context, `/jobs/${jobId}/reject`, {
    method: 'POST',
    body,
  });

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Rejected job: ${response.id}`);
    console.log(`  Phase:         ${response.phase}`);
    console.log(`  Review Status: ${response.review_status ?? 'N/A'}`);
    console.log(`  Reviewer:      ${response.reviewer ?? 'N/A'}`);
    console.log(`  Reason:        ${reason}`);
    console.log('');
    console.log('A new attempt has been created automatically for retry.');
  }
}

/**
 * eve jobs result <id> [--format=text|json|full] [--attempt=N]
 * Fetch and display the result from a completed job attempt
 */

type ReceiptMoney = { currency?: string; amount?: string };

type ExecutionReceiptV2Like = {
  version?: number;
  scope?: { attempt_id?: string; job_id?: string };
  timing?: { wall_ms?: number | null; billable_ms?: number | null };
  phases?: Record<string, number | null | undefined>;
  llm?: {
    total_calls?: number;
    totals?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      reasoning_tokens?: number;
    };
    by_model?: Array<{
      provider?: string;
      model?: string;
      source?: string;
      calls?: number;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      reasoning_tokens?: number;
    }>;
  };
  pricing?: {
    rate_card?: { name?: string; version?: number; effective_at?: string };
    markup_pct?: number;
    billing_currency?: string;
    fx?: { from_currency?: string; to_currency?: string; rate?: string; fetched_at?: string; source?: string } | null;
  };
  base_cost_usd?: {
    total_usd?: ReceiptMoney;
    llm_usd?: ReceiptMoney;
    compute_usd?: ReceiptMoney;
  };
  billed_cost?: {
    total?: ReceiptMoney;
    llm?: ReceiptMoney;
    compute?: ReceiptMoney;
  };
};

async function handleReceipt(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error('Usage: eve jobs receipt <job-id> [--attempt=N] [--json]');
  }

  const attemptStr = getStringFlag(flags, ['attempt']);
  const query = attemptStr ? `?attempt=${encodeURIComponent(attemptStr)}` : '';

  const receipt = await requestJson<ExecutionReceiptV2Like>(context, `/jobs/${jobId}/receipt${query}`);

  if (json) {
    outputJson(receipt as any, true);
    return;
  }

  formatReceiptText(receipt);
}

async function handleCompare(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  const aRaw = getStringFlag(flags, ['a', 'attempt-a', 'attempt_a']) ?? positionals[1];
  const bRaw = getStringFlag(flags, ['b', 'attempt-b', 'attempt_b']) ?? positionals[2];
  const includeReceipt = getBooleanFlag(flags, ['receipt', 'include-receipt']) ?? false;

  if (!jobId || !aRaw || !bRaw) {
    throw new Error('Usage: eve jobs compare <job-id> <attempt-a> <attempt-b> [--receipt] [--json]');
  }

  const a = parseInt(aRaw, 10);
  const b = parseInt(bRaw, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error('Attempt numbers must be integers');
  }

  const params = new URLSearchParams();
  params.set('a', String(a));
  params.set('b', String(b));
  if (includeReceipt) {
    params.set('include_receipt', 'true');
  }

  const query = params.toString() ? `?${params.toString()}` : '';
  const response = await requestJson<any>(context, `/jobs/${jobId}/compare${query}`);

  if (json) {
    outputJson(response, true);
    return;
  }

  console.log(`Compare job ${response.job_id ?? jobId}: attempts ${a} vs ${b}`);
  console.log('');

  const attempts = Array.isArray(response.attempts) ? response.attempts : [];
  for (const attempt of attempts) {
    console.log(`Attempt ${attempt.attempt_number}:`);
    console.log(`  Status:         ${attempt.status}`);
    console.log(`  Started:        ${attempt.started_at}`);
    console.log(`  Ended:          ${attempt.ended_at ?? '(running)'}`);
    console.log(`  Base total usd: ${attempt.base_total_usd}`);
    console.log(`  Billed total:   ${attempt.billed_total} ${attempt.billed_currency}`);

    if (includeReceipt && attempt.receipt) {
      const receipt = attempt.receipt as ExecutionReceiptV2Like;
      const totals = receipt.llm?.totals;
      if (totals) {
        console.log('  LLM totals:');
        console.log(`    input=${totals.input_tokens ?? 0} output=${totals.output_tokens ?? 0} cache_read=${totals.cache_read_tokens ?? 0} cache_write=${totals.cache_write_tokens ?? 0} reasoning=${totals.reasoning_tokens ?? 0}`);
      }
      const billableMs = receipt.timing?.billable_ms;
      if (typeof billableMs === 'number') {
        console.log(`  Billable:       ${formatMs(billableMs)}`);
      }
    }

    console.log('');
  }
}

function formatMoney(m: ReceiptMoney | null | undefined): string {
  const currency = (m?.currency ?? '').toLowerCase();
  const amount = m?.amount ?? '';
  if (!amount) return '(unknown)';
  if (currency === 'usd') return `$${amount}`;
  if (currency) return `${amount} ${currency}`;
  return amount;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '(unknown)';
  if (!Number.isFinite(ms)) return '(unknown)';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pct(part: number | null | undefined, total: number | null | undefined): string {
  if (!part || !total || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '';
  const p = (part / total) * 100;
  return `${p.toFixed(0)}%`;
}

function formatReceiptText(receipt: ExecutionReceiptV2Like): void {
  const wallMs = receipt.timing?.wall_ms ?? null;
  const billableMs = receipt.timing?.billable_ms ?? null;

  console.log('Receipt:');
  if (receipt.scope?.attempt_id) console.log(`  Attempt: ${receipt.scope.attempt_id}`);
  if (receipt.scope?.job_id) console.log(`  Job:     ${receipt.scope.job_id}`);

  console.log('');
  console.log('Totals:');
  console.log(`  Base:   ${formatMoney(receipt.base_cost_usd?.total_usd)} (LLM ${formatMoney(receipt.base_cost_usd?.llm_usd)} + Compute ${formatMoney(receipt.base_cost_usd?.compute_usd)})`);
  console.log(`  Billed: ${formatMoney(receipt.billed_cost?.total)} (LLM ${formatMoney(receipt.billed_cost?.llm)} + Compute ${formatMoney(receipt.billed_cost?.compute)})`);

  console.log('');
  console.log('Pricing:');
  const rc = receipt.pricing?.rate_card;
  if (rc?.name) console.log(`  Rate card: ${rc.name} v${rc.version ?? '?'}` + (rc.effective_at ? ` (effective ${rc.effective_at})` : ''));
  if (receipt.pricing?.markup_pct !== undefined) console.log(`  Markup:    ${receipt.pricing.markup_pct}%`);
  if (receipt.pricing?.billing_currency) console.log(`  Currency:  ${receipt.pricing.billing_currency}`);
  const fx = receipt.pricing?.fx;
  if (fx) {
    console.log(`  FX:        ${fx.from_currency ?? 'usd'} -> ${fx.to_currency ?? '?'} rate=${fx.rate ?? '?'} (${fx.source ?? 'unknown'} @ ${fx.fetched_at ?? '?'})`);
  }

  console.log('');
  console.log('Timing:');
  console.log(`  Wall:     ${formatMs(wallMs)}`);
  console.log(`  Billable: ${formatMs(billableMs)}`);

  console.log('');
  console.log('Phases:');
  const phases = receipt.phases ?? {};
  const phaseKeys: Array<[string, string]> = [
    ['queue_wait_ms', 'Queue wait'],
    ['orchestrator_ms', 'Orchestrator'],
    ['runner_ms', 'Runner'],
    ['workspace_ms', 'Workspace'],
    ['secrets_ms', 'Secrets'],
    ['hooks_ms', 'Hooks'],
    ['harness_ms', 'Harness'],
  ];
  for (const [key, label] of phaseKeys) {
    const value = phases[key] as number | null | undefined;
    const percent = pct(value, wallMs ?? null);
    console.log(`  ${label.padEnd(12)} ${formatMs(value)}${percent ? ` (${percent})` : ''}`);
  }

  console.log('');
  console.log('LLM:');
  const llm = receipt.llm;
  if (!llm) {
    console.log('  (no LLM usage)');
    return;
  }

  const totals = llm.totals ?? {};
  const input = totals.input_tokens ?? 0;
  const output = totals.output_tokens ?? 0;
  const calls = llm.total_calls ?? 0;
  console.log(`  Calls:  ${calls}`);
  console.log(`  Tokens: ${formatNumber(input)} in / ${formatNumber(output)} out`);

  const byModel = llm.by_model ?? [];
  if (byModel.length === 0) return;

  console.log('');
  console.log('  By model:');
  for (const row of byModel) {
    const provider = row.provider ?? 'unknown';
    const model = row.model ?? 'unknown';
    const source = row.source ?? 'byok';
    const rowCalls = row.calls ?? 0;
    const rowIn = row.input_tokens ?? 0;
    const rowOut = row.output_tokens ?? 0;
    console.log(`  - ${provider} ${model} (${source}): ${rowCalls} calls, ${formatNumber(rowIn)} in / ${formatNumber(rowOut)} out`);
  }
}

async function handleResult(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve jobs result <job-id> [--format=text|json|full] [--attempt=N]');
  }

  const format = getStringFlag(flags, ['format']) ?? 'text';
  const attemptStr = getStringFlag(flags, ['attempt']);

  // Validate format
  if (!['text', 'json', 'full'].includes(format)) {
    throw new Error('Invalid format. Use --format=text|json|full');
  }

  // Build query params
  const query = attemptStr ? `?attempt=${attemptStr}` : '';

  let response: JobResultResponse;
  try {
    response = await requestJson<JobResultResponse>(
      context,
      `/jobs/${jobId}/result${query}`,
    );
  } catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number };
    // Check for specific error cases
    if (err.statusCode === 404) {
      console.error(`Error: Job '${jobId}' not found.`);
      process.exit(1);
    }
    throw error;
  }

  // Handle job still running
  if (response.status === 'running' || response.status === 'pending') {
    console.error(`Error: Job is still ${response.status}. Use 'eve job wait ${jobId}' to wait for completion.`);
    process.exit(1);
  }

  // Handle failed job
  if (response.status === 'failed') {
    console.error(`Job failed (attempt #${response.attemptNumber}):`);
    if (response.errorMessage) {
      console.error(`  ${response.errorMessage}`);
    } else {
      console.error('  No error message available.');
    }
    process.exit(1);
  }

  // Best-effort receipt fetch for cost summary.
  let receipt: ExecutionReceiptV2Like | null = null;
  try {
    receipt = await requestJson<ExecutionReceiptV2Like>(
      context,
      `/jobs/${jobId}/receipt?attempt=${response.attemptNumber}`,
    );
  } catch {
    // Receipt missing
  }

  // Format output based on --format flag
  switch (format) {
    case 'text':
      formatResultText(response);
      if (receipt) {
        console.log('');
        console.log(`Cost: ${formatMoney(receipt.base_cost_usd?.total_usd)} base, ${formatMoney(receipt.billed_cost?.total)} billed`);
      }
      break;
    case 'json':
      formatResultJson(response, receipt);
      break;
    case 'full':
      formatResultFull(response);
      if (receipt) {
        console.log('');
        console.log(`Cost: ${formatMoney(receipt.base_cost_usd?.total_usd)} base, ${formatMoney(receipt.billed_cost?.total)} billed`);
      }
      break;
  }
}

/**
 * Format result as plain text (default)
 */
function formatResultText(response: JobResultResponse): void {
  // Display preview URL if present in result_json.pipeline_output
  if (response.resultJson) {
    const pipelineOutput = response.resultJson.pipeline_output as { deploy?: { preview_url?: string } } | undefined;
    if (pipelineOutput?.deploy?.preview_url) {
      console.log(`Preview: ${pipelineOutput.deploy.preview_url}`);
      console.log('');
    }
  }

  if (response.resultText) {
    console.log(response.resultText);
  } else {
    console.log('(no result text)');
  }
}

/**
 * Format result as JSON
 */
function formatResultJson(response: JobResultResponse, receipt?: ExecutionReceiptV2Like | null): void {
  // Extract preview URL if present in result_json.pipeline_output
  let previewUrl: string | undefined;
  if (response.resultJson) {
    const pipelineOutput = response.resultJson.pipeline_output as { deploy?: { preview_url?: string } } | undefined;
    previewUrl = pipelineOutput?.deploy?.preview_url;
  }

  const output = {
    success: response.status === 'succeeded',
    exitCode: response.exitCode,
    resultText: response.resultText,
    resultJson: response.resultJson,
    durationMs: response.durationMs,
    tokenUsage: readResultTokenUsage(response),
    ...(receipt ? {
      cost: {
        base: receipt.base_cost_usd?.total_usd ?? null,
        billed: receipt.billed_cost?.total ?? null,
      },
    } : {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Format result with full details
 */
function formatResultFull(response: JobResultResponse): void {
  console.log(`Job: ${response.jobId}`);
  console.log(`Attempt: ${response.attemptNumber}`);
  console.log(`Status: ${response.status}`);

  if (response.durationMs !== null) {
    const durationSec = Math.round(response.durationMs / 1000);
    console.log(`Duration: ${durationSec}s`);
  }

  const tokenUsage = readResultTokenUsage(response);
  if (tokenUsage) {
    const inputStr = tokenUsage.input !== null ? formatNumber(tokenUsage.input) : '0';
    const outputStr = tokenUsage.output !== null ? formatNumber(tokenUsage.output) : '0';
    console.log(`Tokens: ${inputStr} in / ${outputStr} out`);
  }

  // Display preview URL if present in result_json.pipeline_output
  if (response.resultJson) {
    const pipelineOutput = response.resultJson.pipeline_output as { deploy?: { preview_url?: string } } | undefined;
    if (pipelineOutput?.deploy?.preview_url) {
      console.log(`Preview: ${pipelineOutput.deploy.preview_url}`);
    }

    // Display git metadata if present in result_json
    const resolvedGit = response.resultJson.resolved_git as {
      resolved_ref?: string;
      resolved_sha?: string;
      resolved_branch?: string;
      ref_source?: string;
      pushed?: boolean;
      commits?: string[];
    } | undefined;
    if (resolvedGit) {
      console.log('');
      console.log('Git:');
      if (resolvedGit.resolved_sha) console.log(`  SHA:      ${resolvedGit.resolved_sha}`);
      if (resolvedGit.resolved_branch) console.log(`  Branch:   ${resolvedGit.resolved_branch}`);
      if (resolvedGit.ref_source) console.log(`  Source:   ${resolvedGit.ref_source}`);
      if (resolvedGit.pushed !== undefined) console.log(`  Pushed:   ${resolvedGit.pushed}`);
      if (resolvedGit.commits?.length) console.log(`  Commits:  ${resolvedGit.commits.join(', ')}`);
    }
  }

  console.log('');
  console.log('Result:');
  if (response.resultText) {
    console.log(response.resultText);
  } else {
    console.log('(no result text)');
  }
}

/**
 * Format a number with commas for readability
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

export function readResultTokenUsage(
  response: JobResultResponse,
): { input: number | null; output: number | null } | null {
  const nested = response.tokenUsage;
  if (nested && (typeof nested.input === 'number' || typeof nested.output === 'number')) {
    return {
      input: typeof nested.input === 'number' ? nested.input : null,
      output: typeof nested.output === 'number' ? nested.output : null,
    };
  }

  if (typeof response.tokenInput === 'number' || typeof response.tokenOutput === 'number') {
    return {
      input: typeof response.tokenInput === 'number' ? response.tokenInput : null,
      output: typeof response.tokenOutput === 'number' ? response.tokenOutput : null,
    };
  }

  return null;
}

// Exit codes for wait command
const EXIT_CODE_TIMEOUT = 124;
const EXIT_CODE_CANCELLED = 125;

/**
 * eve job wait <id> [--timeout=300] [--quiet] [--verbose] [--json]
 * Wait for a job to complete, polling the wait endpoint
 */
async function handleWait(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve job wait <job-id> [--timeout=300] [--quiet] [--verbose] [--json]');
  }

  const maxTimeout = parseInt(getStringFlag(flags, ['timeout']) ?? '300', 10);
  const quiet = Boolean(flags.quiet);
  const verbose = Boolean(flags.verbose);
  const json = Boolean(flags.json);

  const startTime = Date.now();
  let totalElapsed = 0;

  // Track state changes for verbose mode
  let lastPhase: string | undefined;
  let lastStatus: string | undefined;
  let lastPeriodicUpdate = 0;
  const periodicUpdateInterval = 5; // seconds

  // Progress output
  if (!quiet && !json) {
    if (verbose) {
      console.log(`[0s] Waiting for job ${jobId}...`);
    } else {
      console.log(`Waiting for ${jobId}...`);
    }
  }

  // Poll with increasing timeout values to reduce request count
  // Start with 5s, increase to 30s, cap at 60s per poll
  let pollTimeout = 5;

  while (totalElapsed < maxTimeout) {
    // Calculate remaining time and cap poll timeout (must be integer for API)
    const remainingTime = maxTimeout - totalElapsed;
    const currentPollTimeout = Math.floor(Math.min(pollTimeout, remainingTime, 60));

    const response = await requestRaw(
      context,
      `/jobs/${jobId}/wait?timeout=${currentPollTimeout}`,
    );

    if (response.status === 200) {
      // Job completed - response.data is JobResultResponse
      const result = response.data as JobResultResponse;
      const totalDuration = Math.round((Date.now() - startTime) / 1000);

      // Show error message immediately in verbose mode if job failed
      if (verbose && !quiet && !json && result.status === 'failed' && result.errorMessage) {
        console.log(`[${totalDuration}s] Job failed: ${result.errorMessage}`);
      }

      if (json) {
        outputJson({
          jobId: result.jobId,
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          resultText: result.resultText,
          resultJson: result.resultJson,
          waitDurationSeconds: totalDuration,
        }, true);
      } else if (!quiet) {
        if (verbose) {
          console.log(`[${totalDuration}s] Completed`);
        } else {
          console.log(`[+] Completed in ${totalDuration}s`);
        }
        console.log('');
        if (result.resultText) {
          console.log(result.resultText);
        } else if (result.resultJson) {
          console.log(JSON.stringify(result.resultJson, null, 2));
        }
      }

      // Exit with job's exit code or based on status
      if (result.status === 'succeeded') {
        process.exit(result.exitCode ?? 0);
      } else if (result.status === 'failed') {
        process.exit(result.exitCode ?? 1);
      } else if (result.status === 'cancelled') {
        process.exit(EXIT_CODE_CANCELLED);
      }
      // Default exit code
      process.exit(result.exitCode ?? 0);
    } else if (response.status === 202) {
      // Job still running - continue polling
      const timeoutResponse = response.data as WaitTimeoutResponse;
      totalElapsed = Math.round((Date.now() - startTime) / 1000);

      if (!quiet && !json) {
        if (verbose) {
          // Check for phase changes
          if (lastPhase !== undefined && lastPhase !== timeoutResponse.phase) {
            console.log(`[${totalElapsed}s] Phase: ${lastPhase} → ${timeoutResponse.phase}`);
          }
          lastPhase = timeoutResponse.phase;

          // Check for status changes
          if (lastStatus !== undefined && lastStatus !== timeoutResponse.status) {
            console.log(`[${totalElapsed}s] Status: ${lastStatus} → ${timeoutResponse.status}`);
          }
          lastStatus = timeoutResponse.status;

          // Show periodic elapsed time updates
          if (totalElapsed - lastPeriodicUpdate >= periodicUpdateInterval) {
            console.log(`[${totalElapsed}s] Still waiting... (phase: ${timeoutResponse.phase})`);
            lastPeriodicUpdate = totalElapsed;
          }
        } else {
          process.stdout.write(`\rWaiting for ${jobId}... (${totalElapsed}s, ${timeoutResponse.status})`);
        }
      }

      // Increase poll timeout for next iteration (with cap)
      pollTimeout = Math.min(pollTimeout * 1.5, 60);
    } else if (response.status === 404) {
      console.error(`Error: Job '${jobId}' not found.`);
      process.exit(1);
    } else {
      // Unexpected error
      const message = typeof response.data === 'string' ? response.data : response.text;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
  }

  // Overall timeout reached
  if (!quiet && !json) {
    console.log('');
  }

  if (json) {
    outputJson({
      jobId,
      status: 'timeout',
      message: `Timeout after ${maxTimeout}s`,
      waitDurationSeconds: maxTimeout,
    }, true);
  } else {
    console.error(`Timeout: Job did not complete within ${maxTimeout}s.`);
  }

  process.exit(EXIT_CODE_TIMEOUT);
}

/**
 * eve job watch <id> [--timeout=300]
 * Watch a job by combining status polling + log streaming
 * Shows phase/status changes like `wait --verbose` while streaming logs like `follow`
 */
async function handleWatch(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve job watch <job-id> [--timeout=300]');
  }

  const maxTimeout = parseInt(getStringFlag(flags, ['timeout']) ?? '300', 10);

  console.log(`Watching job ${jobId}...`);

  const startTime = Date.now();
  let lastPhase: string | undefined;
  let lastStatus: string | undefined;

  // Set up SSE log streaming
  const url = `${context.apiUrl}/jobs/${jobId}/stream`;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };

  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  let exitCode = 0;
  let streamEnded = false;
  let jobCompleted = false;

  // Start status polling in background
  const statusPollingPromise = (async () => {
    while (!jobCompleted && !streamEnded) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3 seconds

      if (jobCompleted || streamEnded) break;

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // Check timeout
      if (elapsed >= maxTimeout) {
        console.log('');
        console.error(`Timeout: Job did not complete within ${maxTimeout}s.`);
        process.exit(EXIT_CODE_TIMEOUT);
      }

      try {
        // Quick status check
        const job = await requestJson<Job>(context, `/jobs/${jobId}`);

        // Track phase changes
        if (lastPhase !== undefined && lastPhase !== job.phase) {
          console.log(`[${elapsed}s] Phase: ${lastPhase} → ${job.phase}`);
        }
        lastPhase = job.phase;

        // Check if job reached terminal state
        // Note: 'failed' is not a valid job phase - only 'done' and 'cancelled' are terminal
        if (job.phase === 'done' || job.phase === 'cancelled') {
          jobCompleted = true;
          break;
        }

        // Get latest attempt to track status changes
        const attemptsResponse = await requestJson<JobAttemptListResponse>(
          context,
          `/jobs/${jobId}/attempts`,
        );
        if (attemptsResponse.attempts.length > 0) {
          const latest = attemptsResponse.attempts[attemptsResponse.attempts.length - 1];
          if (lastStatus !== undefined && lastStatus !== latest.status) {
            console.log(`[${elapsed}s] Attempt status: ${lastStatus} → ${latest.status}`);
          }
          lastStatus = latest.status;
        }
      } catch (error) {
        // Ignore errors during polling, rely on SSE stream
      }
    }
  })();

  // Start SSE log streaming
  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('No response body received');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        } else if (line === '' && eventData) {
          // Empty line marks end of event
          exitCode = processWatchSSEEvent(eventType, eventData);
          if (exitCode !== -1) {
            // Event signals we should exit
            streamEnded = true;
            jobCompleted = true;
            await statusPollingPromise; // Wait for polling to finish
            process.exit(exitCode);
          }
          eventType = '';
          eventData = '';
        }
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      const remainingLines = buffer.split('\n');
      let eventType = '';
      let eventData = '';

      for (const line of remainingLines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        }
      }

      if (eventData) {
        exitCode = processWatchSSEEvent(eventType, eventData);
        if (exitCode !== -1) {
          streamEnded = true;
          jobCompleted = true;
          await statusPollingPromise;
          process.exit(exitCode);
        }
      }
    }

    // Stream ended
    streamEnded = true;
    jobCompleted = true;
    await statusPollingPromise;

    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    console.log('');
    console.log(`[${totalDuration}s] Stream ended.`);
    process.exit(exitCode);

  } catch (error) {
    streamEnded = true;
    jobCompleted = true;
    await statusPollingPromise;
    const err = error as Error;
    console.error(`Error watching job: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Process a single SSE event for watch command
 * Returns exit code if we should exit, or -1 to continue
 */
function processWatchSSEEvent(eventType: string, eventData: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventData);
  } catch {
    // If we can't parse, ignore it
    return -1;
  }

  // Handle different event types
  switch (eventType) {
    case 'log': {
      const logEvent = parsed as SSELogEvent;
      formatFollowLogLine(logEvent);
      return -1;
    }

    case 'complete': {
      const completeEvent = parsed as SSECompleteEvent;
      console.log('');
      console.log('[+] Completed');
      if (completeEvent.result) {
        console.log('');
        console.log(completeEvent.result);
      }
      return completeEvent.exit_code ?? 0;
    }

    case 'error': {
      const errorEvent = parsed as SSEErrorEvent;
      console.log('');
      console.log('[!] Error');
      if (errorEvent.error) {
        console.log(`  ${errorEvent.error}`);
      }
      return errorEvent.exit_code ?? 1;
    }

    default:
      return -1;
  }
}

// ============================================================================
// SSE Log Streaming (follow command)
// ============================================================================

// Follow-mode running totals for `llm.call` events.
let followLlmCallCount = 0;
let followLlmTotalMicroUsd = 0n; // USD with 6dp fixed precision

// Follow-mode silence detection: tracks last heartbeat from the harness runner.
let followLastHeartbeatTime: number | undefined;

// Summary-mode tracking state.
let summaryLlmCallCount = 0;
let summaryLlmTotalMicroUsd = 0n;
let summaryLlmTotalInputTokens = 0;
let summaryLlmTotalOutputTokens = 0;
let summaryToolUseCount = 0;
let summaryLastLlmEmitCount = 0;
let summaryLastLlmEmitTime = 0;
let summaryStartTime = 0;

function parseFixed6Usd(amount: string): bigint {
  const [wholeRaw, fracRaw = ''] = amount.split('.');
  const whole = wholeRaw.trim() ? BigInt(wholeRaw) : 0n;
  const frac = (fracRaw + '000000').slice(0, 6);
  return whole * 1000000n + BigInt(frac);
}

function formatFixed6Usd(micro: bigint): string {
  const whole = micro / 1000000n;
  const frac = micro % 1000000n;
  return `${whole.toString()}.${frac.toString().padStart(6, '0')}`;
}

/**
 * SSE event from the log stream
 */
interface SSELogEvent {
  sequence: number;
  timestamp: string;
  type: string;
  line: Record<string, unknown>;
}

interface SSECompleteEvent {
  status: 'succeeded';
  result?: string;
  exit_code?: number;
}

interface SSEErrorEvent {
  status: 'failed';
  error?: string;
  exit_code?: number;
}

/**
 * eve job follow <id> [--raw] [--no-result] [--summary]
 * Stream logs from a running job in real-time via SSE
 *
 * --summary: Emit a clean, parseable summary instead of raw JSONL.
 *   Only shows: phase transitions, permission rejections, periodic LLM
 *   aggregates, tool names (no I/O), eve-message blocks, errors, and
 *   the final result line.
 */
async function handleFollow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve job follow <job-id> [--raw] [--no-result] [--summary]');
  }

  const raw = Boolean(flags.raw);
  const summary = Boolean(flags.summary);
  const showResult = !flags['no-result'];

  console.log(`Following ${jobId}${summary ? ' (summary mode)' : ''}...`);

  // Reset running totals for this follow session.
  followLlmCallCount = 0;
  followLlmTotalMicroUsd = 0n;
  followLastHeartbeatTime = undefined;

  // Reset summary-mode state.
  summaryLlmCallCount = 0;
  summaryLlmTotalMicroUsd = 0n;
  summaryLlmTotalInputTokens = 0;
  summaryLlmTotalOutputTokens = 0;
  summaryToolUseCount = 0;
  summaryLastLlmEmitCount = 0;
  summaryLastLlmEmitTime = Date.now();
  summaryStartTime = Date.now();

  // ── Silence detection ──────────────────────────────────────────────
  // Warn when no SSE data arrives for an extended period, distinguishing
  // between "harness is alive but quiet" (heartbeats still arriving) and
  // "harness may have stalled" (no heartbeats either).
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = undefined;
    }
  }

  function onSilence(seconds: number) {
    if (followLastHeartbeatTime !== undefined) {
      const hbAge = Math.round((Date.now() - followLastHeartbeatTime) / 1000);
      if (hbAge < seconds) {
        console.log(`           \u23f3 No output for ${seconds}s \u2014 last heartbeat ${hbAge}s ago (harness alive)`);
      } else {
        console.log(`           \u26a0 No output for ${seconds}s \u2014 no heartbeat for ${hbAge}s (harness may have stalled)`);
      }
    } else {
      console.log(`           \u23f3 No output for ${seconds}s \u2014 run \`eve job diagnose ${jobId}\``);
    }
    // Schedule escalated warning at 120s
    if (seconds < 120) {
      silenceTimer = setTimeout(() => onSilence(120), 60_000);
    } else {
      silenceTimer = undefined;
    }
  }

  function resetSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => onSilence(60), 60_000);
  }

  const url = `${context.apiUrl}/jobs/${jobId}/stream`;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };

  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  let exitCode = 0;

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('No response body received');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Start the silence timer once the SSE connection is established.
    resetSilenceTimer();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      resetSilenceTimer();

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      let eventType = '';
      let eventData = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        } else if (line === '' && eventData) {
          // Empty line marks end of event
          exitCode = processSSEEvent(eventType, eventData, raw, showResult, summary);
          if (exitCode !== -1) {
            // Event signals we should exit
            clearSilenceTimer();
            if (summary) printSummaryFooter();
            process.exit(exitCode);
          }
          eventType = '';
          eventData = '';
        }
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      const remainingLines = buffer.split('\n');
      let eventType = '';
      let eventData = '';

      for (const line of remainingLines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          eventData = line.slice(5).trim();
        }
      }

      if (eventData) {
        exitCode = processSSEEvent(eventType, eventData, raw, showResult, summary);
        if (exitCode !== -1) {
          clearSilenceTimer();
          if (summary) printSummaryFooter();
          process.exit(exitCode);
        }
      }
    }

    // Stream ended without explicit complete/error event
    clearSilenceTimer();
    if (summary) printSummaryFooter();
    console.log('');
    console.log('Stream ended.');
    process.exit(0);

  } catch (error) {
    clearSilenceTimer();
    if (summary) printSummaryFooter();
    const err = error as Error;
    console.error(`Error following job: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Process a single SSE event
 * Returns exit code if we should exit, or -1 to continue
 */
function processSSEEvent(eventType: string, eventData: string, raw: boolean, showResult: boolean, summary = false): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventData);
  } catch {
    // If we can't parse, treat as raw text
    if (raw) {
      console.log(eventData);
    }
    return -1;
  }

  // Handle different event types
  switch (eventType) {
    case 'log': {
      const logEvent = parsed as SSELogEvent;

      // Track heartbeat lifecycle events for silence detection.
      if (logEvent.type?.startsWith('lifecycle_')) {
        const content = logEvent.line as Record<string, unknown>;
        if (content.phase === 'runner' && content.action === 'log') {
          const meta = content.meta as Record<string, unknown> | undefined;
          if (meta?.kind === 'heartbeat') {
            followLastHeartbeatTime = Date.now();
          }
        }
      }

      if (raw) {
        console.log(JSON.stringify(logEvent));
      } else if (summary) {
        const line = formatFollowSummaryLine(logEvent);
        if (line) console.log(line);
      } else {
        formatFollowLogLine(logEvent);
      }
      return -1;
    }

    case 'complete': {
      const completeEvent = parsed as SSECompleteEvent;
      if (raw) {
        console.log(JSON.stringify(completeEvent));
      } else if (summary) {
        // Flush any pending LLM aggregate before the final line
        const pendingLlm = flushSummaryLlmAggregate(true);
        if (pendingLlm) console.log(pendingLlm);
        const ts = new Date().toLocaleTimeString();
        const exitCode = completeEvent.exit_code ?? 0;
        const icon = exitCode === 0 ? '+' : '!';
        console.log(`[${ts}] [${icon}] Completed (exit ${exitCode})`);
        if (showResult && completeEvent.result) {
          console.log('');
          console.log(completeEvent.result);
        }
      } else {
        console.log('[+] Completed');
        if (showResult && completeEvent.result) {
          console.log('');
          console.log(completeEvent.result);
        }
      }
      return completeEvent.exit_code ?? 0;
    }

    case 'error': {
      const errorEvent = parsed as SSEErrorEvent;
      if (raw) {
        console.log(JSON.stringify(errorEvent));
      } else if (summary) {
        const pendingLlm = flushSummaryLlmAggregate(true);
        if (pendingLlm) console.log(pendingLlm);
        const ts = new Date().toLocaleTimeString();
        const errMsg = errorEvent.error ? `: ${errorEvent.error}` : '';
        console.log(`[${ts}] [!] Error${errMsg}`);
      } else {
        console.log('[!] Error');
        if (errorEvent.error) {
          console.log(`  ${errorEvent.error}`);
        }
      }
      return errorEvent.exit_code ?? 1;
    }

    default: {
      // Unknown event type, still output if raw mode
      if (raw) {
        console.log(JSON.stringify(parsed));
      }
      return -1;
    }
  }
}

/**
 * Format a log line for human-readable output
 */
function formatFollowLogLine(event: SSELogEvent): void {
  const timestamp = new Date(event.timestamp).toLocaleTimeString();
  const line = event.line;
  const type = event.type || (line.type as string) || 'log';

  // If type starts with 'lifecycle_', format as lifecycle event
  if (type.startsWith('lifecycle_')) {
    const content = line as Record<string, unknown>;
    const phase = content.phase as string || 'unknown';
    const action = content.action as string || 'unknown';
    const duration = content.duration_ms as number | undefined;
    const success = content.success as boolean | undefined;
    const error = content.error as string | undefined;
    const meta = content.meta as Record<string, unknown> || {};

    if (action === 'start') {
      const detail = formatLifecycleMeta(phase, meta);
      console.log(`[${timestamp}] ${getLifecycleIcon(phase)} Starting ${phase}${detail}...`);
    } else if (action === 'end') {
      const durationStr = duration ? ` (${duration}ms)` : '';
      if (success === false && error) {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} failed${durationStr}: ${error}`);
      } else {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} completed${durationStr}`);
      }
    } else if (action === 'log') {
      // Track heartbeat events for silence detection; suppress from output.
      if (phase === 'runner' && meta.kind === 'heartbeat') {
        followLastHeartbeatTime = Date.now();
        return;
      }
      const msg = (meta.message as string) || JSON.stringify(meta);
      console.log(`[${timestamp}]   > ${msg}`);
    }
    return;
  }

  if (type === 'llm.call') {
    const call = line as Record<string, unknown>;
    const provider = (call.provider as string) || 'unknown';
    const model = (call.model as string) || 'unknown';
    const source = (call.source as string) === 'managed' ? 'managed' : 'byok';
    const status = (call.status as string) === 'error' ? 'error' : 'ok';
    const usage = (call.usage as Record<string, unknown> | undefined) ?? {};
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;

    const costs = calculateBilledCost({
      rate_card: DEFAULT_RATE_CARD_V1,
      llm_usage: [{
        provider,
        model,
        source: source as any,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: Number(usage.cache_read_tokens) || 0,
          cache_write_tokens: Number(usage.cache_write_tokens) || 0,
          reasoning_tokens: Number(usage.reasoning_tokens) || 0,
        },
      }],
      compute_usage: null,
      markup_pct: 0,
      billing_currency: 'usd',
      fx_usd_to_billing: null,
    });

    const callUsd = costs.base_cost_usd.llm_usd.amount;
    followLlmCallCount += 1;
    followLlmTotalMicroUsd += parseFixed6Usd(callUsd);

    const byokLabel = source === 'byok' ? ' (BYOK)' : '';
    const statusLabel = status === 'error' ? ' error' : '';
    console.log(
      `[${timestamp}]   LLM call #${followLlmCallCount}${byokLabel}${statusLabel}: ${formatNumber(inputTokens)} in / ${formatNumber(outputTokens)} out (~$${callUsd})  [$${formatFixed6Usd(followLlmTotalMicroUsd)} total]`,
    );
    return;
  }

  // Normalize NormalizedEvent wrappers (from eve-agent-cli) into a flat shape
  const normalized = normalizeLogLine(line);
  const nType = normalized.type;
  if (nType === 'skip') return;

  const message = normalized.message || (line.message as string) || (line.text as string) || '';
  const tool = normalized.tool || (line.tool as string) || undefined;
  const toolInput = normalized.toolInput || (line.tool_input as string) || undefined;

  // Format based on event/log type
  switch (nType) {
    case 'assistant':
    case 'text':
      if (message) {
        console.log(`[${timestamp}] ${message}`);
      }
      break;

    case 'tool_use':
      if (tool) {
        const inputPreview = toolInput ? ` ${toolInput.substring(0, 80)}${toolInput.length > 80 ? '...' : ''}` : '';
        console.log(`[${timestamp}]   ${tool}${inputPreview}`);
      }
      break;

    case 'tool_result':
      // Don't show tool results in follow mode (too verbose)
      break;

    case 'status':
      if (message) {
        console.log(`[${timestamp}]   > ${message}`);
      }
      break;

    case 'error':
      console.log(`[${timestamp}] Error: ${message || JSON.stringify(line)}`);
      break;

    default:
      // For unknown types, show message if available, otherwise JSON
      if (message) {
        console.log(`[${timestamp}] ${message}`);
      } else if (Object.keys(line).length > 0) {
        console.log(`[${timestamp}] ${JSON.stringify(line)}`);
      }
  }
}

/**
 * Format a single log event for --summary mode.
 * Returns a formatted string to print, or null to skip the event.
 *
 * Emits: lifecycle phase transitions, permission rejections, eve-message
 * blocks, tool names (no I/O), errors, and periodic LLM call aggregates.
 */
function formatFollowSummaryLine(event: SSELogEvent): string | null {
  const line = event.line;
  const type = event.type || (line.type as string) || 'log';
  const ts = new Date(event.timestamp).toLocaleTimeString();

  // ── Lifecycle phase transitions ──────────────────────────────────────
  if (type.startsWith('lifecycle_')) {
    const content = line as Record<string, unknown>;
    const phase = (content.phase as string) || 'unknown';
    const action = (content.action as string) || 'unknown';
    const duration = content.duration_ms as number | undefined;
    const success = content.success as boolean | undefined;
    const error = content.error as string | undefined;
    const meta = (content.meta as Record<string, unknown>) || {};

    if (action === 'start') {
      const detail = formatLifecycleMeta(phase, meta);
      return `[${ts}] >> ${phase}${detail}`;
    }
    if (action === 'end') {
      const dur = duration ? ` (${duration}ms)` : '';
      if (success === false && error) {
        return `[${ts}] !! ${phase} failed${dur}: ${error}`;
      }
      return `[${ts}] ok ${phase}${dur}`;
    }
    // Skip lifecycle log sub-events in summary mode
    return null;
  }

  // ── LLM calls — aggregate, emit periodically ────────────────────────
  if (type === 'llm.call') {
    const call = line as Record<string, unknown>;
    const source = (call.source as string) === 'managed' ? 'managed' : 'byok';
    const provider = (call.provider as string) || 'unknown';
    const model = (call.model as string) || 'unknown';
    const status = (call.status as string) || 'ok';
    const usage = (call.usage as Record<string, unknown> | undefined) ?? {};
    const inputTokens = Number(usage.input_tokens) || 0;
    const outputTokens = Number(usage.output_tokens) || 0;

    const costs = calculateBilledCost({
      rate_card: DEFAULT_RATE_CARD_V1,
      llm_usage: [{
        provider,
        model,
        source: source as any,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: Number(usage.cache_read_tokens) || 0,
          cache_write_tokens: Number(usage.cache_write_tokens) || 0,
          reasoning_tokens: Number(usage.reasoning_tokens) || 0,
        },
      }],
      compute_usage: null,
      markup_pct: 0,
      billing_currency: 'usd',
      fx_usd_to_billing: null,
    });

    summaryLlmCallCount += 1;
    summaryLlmTotalInputTokens += inputTokens;
    summaryLlmTotalOutputTokens += outputTokens;
    summaryLlmTotalMicroUsd += parseFixed6Usd(costs.base_cost_usd.llm_usd.amount);

    // Error LLM calls are always shown immediately
    if (status === 'error') {
      return `[${ts}] !! LLM error (${provider}/${model})`;
    }

    // Emit an aggregate line every 10 calls or every 30 seconds
    return flushSummaryLlmAggregate(false);
  }

  // ── Permission rejections ────────────────────────────────────────────
  // Look for tool_result with is_error containing "requires approval"
  const normalized = normalizeLogLine(line);
  const nType = normalized.type;

  if (nType === 'tool_result') {
    const resultText = normalized.message || (line.tool_result as string) || '';
    if (resultText.includes('requires approval') || resultText.includes('permission denied')) {
      return `[${ts}] !! Permission rejected: ${resultText.substring(0, 120)}`;
    }
  }

  // Also check raw event wrappers for permission rejections
  if (type === 'event') {
    const rawLine = line.raw as Record<string, unknown> | undefined;
    const msg = rawLine?.message as Record<string, unknown> | undefined;
    const contentArr = msg?.content as unknown[] | undefined;
    if (Array.isArray(contentArr)) {
      for (const block of contentArr) {
        const b = block as Record<string, unknown>;
        if (b.is_error && typeof b.content === 'string' && b.content.includes('requires approval')) {
          return `[${ts}] !! Permission rejected: ${(b.content as string).substring(0, 120)}`;
        }
      }
    }
  }

  // ── Eve-message blocks ───────────────────────────────────────────────
  if (nType === 'assistant' || nType === 'text') {
    const text = normalized.message || (line.message as string) || (line.text as string) || '';
    const match = text.match(/```eve-message\n([\s\S]*?)```/);
    if (match) {
      return `[${ts}] -- ${match[1].trim()}`;
    }
  }

  // ── Tool use — name only, no I/O ────────────────────────────────────
  if (nType === 'tool_use') {
    const tool = normalized.tool || (line.tool as string);
    if (tool) {
      summaryToolUseCount += 1;
      return `[${ts}]    ${tool}`;
    }
  }

  // ── Errors ───────────────────────────────────────────────────────────
  if (nType === 'error') {
    const errMsg = normalized.message || (line.message as string) || JSON.stringify(line);
    return `[${ts}] !! Error: ${errMsg}`;
  }

  // Everything else is suppressed in summary mode
  return null;
}

/**
 * Flush the LLM aggregate line if enough calls or time have elapsed.
 * @param force - emit regardless of thresholds (used at stream end)
 * @returns formatted line or null
 */
function flushSummaryLlmAggregate(force: boolean): string | null {
  const callsSinceLastEmit = summaryLlmCallCount - summaryLastLlmEmitCount;
  const msSinceLastEmit = Date.now() - summaryLastLlmEmitTime;

  if (callsSinceLastEmit === 0) return null;
  if (!force && callsSinceLastEmit < 10 && msSinceLastEmit < 30_000) return null;

  summaryLastLlmEmitCount = summaryLlmCallCount;
  summaryLastLlmEmitTime = Date.now();

  const ts = new Date().toLocaleTimeString();
  return `[${ts}]    LLM: ${summaryLlmCallCount} calls, ${formatNumber(summaryLlmTotalInputTokens)} in / ${formatNumber(summaryLlmTotalOutputTokens)} out (~$${formatFixed6Usd(summaryLlmTotalMicroUsd)})`;
}

/**
 * Print the summary footer with session totals.
 */
function printSummaryFooter(): void {
  // Flush any remaining LLM aggregate
  const pending = flushSummaryLlmAggregate(true);
  if (pending) console.log(pending);

  const elapsed = Math.round((Date.now() - summaryStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  console.log('');
  console.log('--- Summary ---');
  console.log(`Duration:    ${durStr}`);
  console.log(`LLM calls:   ${summaryLlmCallCount}`);
  console.log(`Tokens:      ${formatNumber(summaryLlmTotalInputTokens)} in / ${formatNumber(summaryLlmTotalOutputTokens)} out`);
  console.log(`Cost:        ~$${formatFixed6Usd(summaryLlmTotalMicroUsd)}`);
  console.log(`Tool uses:   ${summaryToolUseCount}`);
}

/**
 * Get status icon for attempt status
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending':
      return '[⏸]';
    case 'running':
      return '[▶]';
    case 'succeeded':
      return '[✓]';
    case 'failed':
      return '[✗]';
    case 'cancelled':
      return '[○]';
    default:
      return '[ ]';
  }
}

/**
 * Format duration between two dates
 */
function formatDuration(startStr: string, endStr: string): string {
  try {
    const start = new Date(startStr).getTime();
    const end = new Date(endStr).getTime();
    const durationMs = end - start;

    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }

    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }

    return `${seconds}s`;
  } catch {
    return 'unknown';
  }
}

/**
 * Pad a string to the right with spaces
 */
function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * eve job runner-logs <id> [--attempt N]
 * Stream K8s runner pod logs for a job
 */
async function handleRunnerLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve job runner-logs <job-id> [--attempt N]');
  }

  const attemptStr = getStringFlag(flags, ['attempt']);

  // Fetch job with attempts to get runtime_meta
  const attemptsResponse = await requestJson<JobAttemptListResponse>(
    context,
    `/jobs/${jobId}/attempts`,
  );

  if (!attemptsResponse.attempts || attemptsResponse.attempts.length === 0) {
    console.error(`No attempts found for job ${jobId}`);
    process.exit(1);
  }

  // Select target attempt
  let targetAttempt: JobAttempt | undefined;
  if (attemptStr) {
    const attemptNum = parseInt(attemptStr, 10);
    targetAttempt = attemptsResponse.attempts.find(a => a.attempt_number === attemptNum);
    if (!targetAttempt) {
      console.error(`Attempt #${attemptNum} not found for job ${jobId}`);
      process.exit(1);
    }
  } else {
    // Use latest attempt
    targetAttempt = attemptsResponse.attempts[attemptsResponse.attempts.length - 1];
  }

  if (!targetAttempt) {
    console.error(`No attempt found for job ${jobId}`);
    process.exit(1);
  }

  console.log(`Streaming logs for job ${jobId}, attempt #${targetAttempt.attempt_number}...`);

  // Try to get pod_name from runtime_meta
  const podName = targetAttempt.runtime_meta?.pod_name as string | undefined;

  let kubectlArgs: string[];
  if (podName) {
    // Use pod name directly
    console.log(`Using pod: ${podName}`);
    kubectlArgs = ['-n', 'eve', 'logs', '-f', podName];
  } else {
    // Fall back to label-based lookup
    console.log(`No pod_name in runtime_meta, using label selector: job-id=${jobId}`);
    kubectlArgs = ['-n', 'eve', 'logs', '-f', '-l', `job-id=${jobId}`];
  }

  // Spawn kubectl process
  const kubectl = spawn('kubectl', kubectlArgs, {
    stdio: 'inherit',
  });

  // Handle process exit
  return new Promise<void>((resolve, reject) => {
    kubectl.on('error', (error: Error) => {
      reject(new Error(`Failed to execute kubectl: ${error.message}`));
    });

    kubectl.on('exit', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        // Non-zero exit is common (e.g., pod terminated, not found)
        // Don't treat as error
        resolve();
      }
    });
  });
}

// ============================================================================
// Attachment Subcommands
// ============================================================================

interface JobAttachmentResponse {
  id: string;
  job_id: string;
  name: string;
  mime_type: string;
  content_hash: string;
  created_by?: string | null;
  created_at: string;
}

interface JobAttachmentDetailResponse extends JobAttachmentResponse {
  content: string;
}

interface JobAttachmentListResponse {
  attachments: JobAttachmentResponse[];
}

/**
 * eve jobs attach <job_id> --file <path> --name <name> [--mime <type>]
 * eve jobs attach <job_id> --stdin --name <name> [--mime <type>]
 *
 * Creates a new attachment on a job. Content is read from a file or stdin.
 */
async function handleAttach(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error('Usage: eve jobs attach <job_id> --file <path> --name <name> [--mime <type>]');
  }

  const filePath = getStringFlag(flags, ['file', 'f']);
  const useStdin = getBooleanFlag(flags, ['stdin']);
  const name = getStringFlag(flags, ['name', 'n']);
  const mimeType = getStringFlag(flags, ['mime', 'mime-type']);

  if (!filePath && !useStdin) {
    throw new Error('Either --file or --stdin is required');
  }

  let content: string;
  let attachmentName: string;

  if (filePath) {
    content = readFileSync(filePath, 'utf8');
    attachmentName = name ?? basename(filePath);
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    content = Buffer.concat(chunks).toString('utf8');
    if (!name) {
      throw new Error('--name is required when reading from --stdin');
    }
    attachmentName = name;
  }

  const body = {
    name: attachmentName,
    ...(mimeType ? { mime_type: mimeType } : {}),
    content,
  };

  const response = await requestJson<JobAttachmentDetailResponse>(
    context,
    `/jobs/${jobId}/attachments`,
    { method: 'POST', body },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Attachment created: ${response.name} (${response.id})`);
    console.log(`  MIME type:     ${response.mime_type}`);
    console.log(`  Content hash:  ${response.content_hash}`);
    console.log(`  Created at:    ${response.created_at}`);
  }
}

/**
 * eve jobs attachments <job_id>
 *
 * Lists all attachments for a job (metadata only, no content).
 */
async function handleAttachments(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error('Usage: eve jobs attachments <job_id>');
  }

  const response = await requestJson<JobAttachmentListResponse>(
    context,
    `/jobs/${jobId}/attachments`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.attachments.length === 0) {
      console.log('No attachments found.');
      return;
    }
    console.log(`Attachments for job ${jobId}:\n`);
    for (const att of response.attachments) {
      console.log(`  ${att.name}`);
      console.log(`    ID:           ${att.id}`);
      console.log(`    MIME type:    ${att.mime_type}`);
      console.log(`    Content hash: ${att.content_hash}`);
      console.log(`    Created at:   ${att.created_at}`);
      if (att.created_by) {
        console.log(`    Created by:   ${att.created_by}`);
      }
      console.log('');
    }
  }
}

/**
 * eve jobs attachment <job_id> --name <name>
 * eve jobs attachment <job_id> --id <att_id>
 *
 * Gets a single attachment with its content.
 */
async function handleAttachment(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error('Usage: eve jobs attachment <job_id> --name <name> | --id <att_id>');
  }

  const attId = getStringFlag(flags, ['id']);
  const attName = getStringFlag(flags, ['name', 'n']);

  if (!attId && !attName) {
    throw new Error('Either --id or --name is required');
  }

  let response: JobAttachmentDetailResponse;

  if (attId) {
    response = await requestJson<JobAttachmentDetailResponse>(
      context,
      `/jobs/${jobId}/attachments/${attId}`,
    );
  } else {
    // List all and find by name, then fetch the full detail
    const list = await requestJson<JobAttachmentListResponse>(
      context,
      `/jobs/${jobId}/attachments`,
    );
    const match = list.attachments.find(a => a.name === attName);
    if (!match) {
      throw new Error(`Attachment not found with name: ${attName}`);
    }
    response = await requestJson<JobAttachmentDetailResponse>(
      context,
      `/jobs/${jobId}/attachments/${match.id}`,
    );
  }

  if (json) {
    outputJson(response, json);
  } else {
    // Output the raw content to stdout (useful for piping)
    process.stdout.write(response.content);
  }
}

// ============================================================================
// Batch Subcommands
// ============================================================================

interface BatchJobEntry {
  name: string;
  id: string;
  phase: string;
  blocked_by?: string[];
}

interface BatchCreateResponse {
  batch_id: string;
  jobs: BatchJobEntry[];
}

interface BatchValidateResponse {
  valid: boolean;
  errors?: string[];
}

/**
 * eve job batch --project <id> --file <path> [--json]
 *
 * Create a batch job graph from a JSON definition file.
 */
async function handleBatch(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const filePath = getStringFlag(flags, ['file']);

  if (!projectId) {
    throw new Error('Usage: eve job batch --project <id> --file <path>');
  }
  if (!filePath) {
    throw new Error('--file is required: path to JSON batch definition');
  }

  let body: unknown;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    body = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read batch file: ${message}`);
  }

  const response = await requestJson<BatchCreateResponse>(
    context,
    `/projects/${projectId}/jobs/batch`,
    { method: 'POST', body },
  );

  if (json) {
    outputJson(response, true);
    return;
  }

  console.log(`Batch created: ${response.batch_id}`);
  console.log('Jobs:');
  for (const job of response.jobs) {
    const blocked = job.blocked_by && job.blocked_by.length > 0
      ? `, blocked by: ${job.blocked_by.join(', ')}`
      : '';
    console.log(`  ${job.name.padEnd(16)} \u2192 ${job.id}  (${job.phase}${blocked})`);
  }
}

/**
 * eve job batch-validate --project <id> --file <path> [--json]
 *
 * Validate a batch job graph definition without creating jobs.
 */
async function handleBatchValidate(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const filePath = getStringFlag(flags, ['file']);

  if (!projectId) {
    throw new Error('Usage: eve job batch-validate --project <id> --file <path>');
  }
  if (!filePath) {
    throw new Error('--file is required: path to JSON batch definition');
  }

  let body: unknown;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    body = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read batch file: ${message}`);
  }

  const response = await requestJson<BatchValidateResponse>(
    context,
    `/projects/${projectId}/jobs/batch/validate`,
    { method: 'POST', body },
  );

  if (json) {
    outputJson(response, true);
    return;
  }

  if (response.valid) {
    console.log('Batch definition is valid.');
  } else {
    console.log('Batch definition has errors:');
    if (response.errors) {
      for (const err of response.errors) {
        console.log(`  - ${err}`);
      }
    }
  }
}

const DEPLOY_FAILURE_HINTS: Record<string, string> = {
  k8s_api_error: 'Platform issue — share the attempt_id with Eve support. Full body is in the attempt log.',
  manifest_invalid: 'Manifest rejected by K8s — run `eve manifest validate` or inspect the inline body.',
  image_pull_error: 'Check imagePullSecret or the image digest. Run `eve env diagnose <project> <env>`.',
  app_crash_loop: 'App is crashing on start. Run `eve env logs <project> <env> <service> --previous`.',
  readiness_timeout: "App came up but isn't ready. Check `eve env diagnose <project> <env>` and liveness/readiness probes.",
  dependency_timeout: '`depends_on` service did not become healthy. Check `eve env logs <project> <env> <dep-service>`.',
  ingress_conflict: 'Another ingress owns this host + path. Run `eve domain list` and `eve domain transfer` to move ownership.',
};

/**
 * Scan attempt logs for a structured `error_context` entry with a
 * DeployFailure kind (written by action-executor's extractErrorContext) and
 * render the kind, message, service/pod, hint, and cluster snapshot if present.
 */
function renderDeployFailureBlock(logs: Array<{ timestamp?: string; line?: unknown }>): void {
  for (const entry of logs) {
    const line = entry.line as Record<string, unknown> | undefined;
    if (!line || typeof line !== 'object') continue;
    const errorContext = line.error_context as Record<string, unknown> | undefined;
    if (!errorContext || typeof errorContext.kind !== 'string') continue;
    const kind = errorContext.kind;
    const hint = DEPLOY_FAILURE_HINTS[kind];

    console.log('Failure:');
    console.log(`  Kind:    ${kind}`);
    if (typeof errorContext.service === 'string') {
      console.log(`  Service: ${errorContext.service}${typeof errorContext.pod === 'string' ? ` (pod ${errorContext.pod})` : ''}`);
    }
    if (typeof errorContext.message === 'string') {
      console.log(`  Message: ${errorContext.message}`);
    }
    if (hint) {
      console.log(`  Next step: ${hint}`);
    }

    const snapshot = line.cluster_snapshot as
      | { namespace?: string; pods?: Array<{ name?: string; phase?: string; restartCount?: number; ready?: boolean; containers?: Array<{ name?: string; waitingReason?: string; lastTerminatedExitCode?: number | null; lastTerminatedReason?: string | null }> }> }
      | undefined;
    if (snapshot?.pods?.length) {
      console.log(`  Pod snapshot (${snapshot.namespace ?? 'unknown'}):`);
      for (const pod of snapshot.pods.slice(0, 6)) {
        const firstBad = pod.containers?.find((c) => c.waitingReason || (c.lastTerminatedExitCode ?? 0) !== 0)
          ?? pod.containers?.[0];
        const reason = firstBad?.waitingReason ?? firstBad?.lastTerminatedReason ?? (pod.ready ? 'Running' : 'NotReady');
        const exit = firstBad?.lastTerminatedExitCode != null ? ` last exit=${firstBad.lastTerminatedExitCode}` : '';
        console.log(`    ${(pod.name ?? 'unknown').padEnd(40)} ${(pod.phase ?? '?').padEnd(15)} ${reason}${exit} restarts=${pod.restartCount ?? 0}`);
      }
    }
    console.log('');
    return; // only render first failure
  }
}

/**
 * Surface obvious mismatches between a job's declared token_scope and its
 * declared token_permissions (e.g. orgfs paths declared but no orgfs:read).
 * Returns one warning string per mismatch; empty array when aligned.
 */
function detectTokenMisalignment(
  permissions: string[] | null,
  scope: Record<string, unknown> | null,
): string[] {
  if (!scope || typeof scope !== 'object') return [];
  const has = (perm: string) => Array.isArray(permissions) && permissions.includes(perm);
  const warnings: string[] = [];
  const orgfs = scope.orgfs as { allow_prefixes?: unknown; read_only_prefixes?: unknown } | undefined;
  if (orgfs) {
    if (Array.isArray(orgfs.allow_prefixes) && orgfs.allow_prefixes.length > 0 && !has('orgfs:write')) {
      warnings.push('scope.orgfs.allow_prefixes set but permissions[] missing orgfs:write');
    }
    if (Array.isArray(orgfs.read_only_prefixes) && orgfs.read_only_prefixes.length > 0 && !has('orgfs:read')) {
      warnings.push('scope.orgfs.read_only_prefixes set but permissions[] missing orgfs:read');
    }
  }
  const orgdocs = scope.orgdocs as { allow_prefixes?: unknown; read_only_prefixes?: unknown } | undefined;
  if (orgdocs) {
    if (Array.isArray(orgdocs.allow_prefixes) && orgdocs.allow_prefixes.length > 0 && !has('orgdocs:write')) {
      warnings.push('scope.orgdocs.allow_prefixes set but permissions[] missing orgdocs:write');
    }
    if (Array.isArray(orgdocs.read_only_prefixes) && orgdocs.read_only_prefixes.length > 0 && !has('orgdocs:read')) {
      warnings.push('scope.orgdocs.read_only_prefixes set but permissions[] missing orgdocs:read');
    }
  }
  const cloudFs = scope.cloud_fs as { allow_mount_ids?: unknown } | undefined;
  if (cloudFs && Array.isArray(cloudFs.allow_mount_ids) && cloudFs.allow_mount_ids.length > 0 && !has('cloud_fs:read')) {
    warnings.push('scope.cloud_fs.allow_mount_ids set but permissions[] missing cloud_fs:read');
  }
  const envdb = scope.envdb as { schemas?: unknown; tables?: unknown } | undefined;
  if (envdb) {
    const hasSchemas = Array.isArray(envdb.schemas) && envdb.schemas.length > 0;
    const hasTables = Array.isArray(envdb.tables) && envdb.tables.length > 0;
    if ((hasSchemas || hasTables) && !has('envdb:read')) {
      warnings.push('scope.envdb set but permissions[] missing envdb:read');
    }
  }
  return warnings;
}

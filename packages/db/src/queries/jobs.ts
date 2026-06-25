import crypto from 'crypto';
import type { AccessBindingScope, InlineProfileBundle, HarnessProfileSource } from '@eve/shared';
import type { Db } from '../client.js';

// ============================================================================
// Phase Lifecycle
// ============================================================================

// Valid phase transitions per Part D of jobs-unified-design.md
const VALID_TRANSITIONS: Record<string, string[]> = {
  idea: ['backlog', 'cancelled'],
  backlog: ['ready', 'cancelled'],
  ready: ['active', 'backlog', 'cancelled'],
  active: ['review', 'done', 'ready', 'cancelled'],
  review: ['done', 'active', 'cancelled'],
  done: [],  // terminal
  cancelled: [],  // terminal
};

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

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

// ============================================================================
// Factory Function
// ============================================================================

export function jobQueries(db: Db) {
  return {
    /**
     * Generate a new job ID
     *
     * Root format: {slug}-{hash8} (8 hex chars from SHA256)
     * Child format: {parentId}.{n} where n is next sequence
     *
     * Max depth: 3 levels (count dots)
     * Handles collisions by retry with new random bytes
     *
     * @param projectSlug - Project slug (human-readable, e.g., 'myproj')
     * @param parentId - Optional parent job ID for creating child jobs
     * @returns Object containing generated job ID and project TypeID
     */
    async generateJobId(projectInput: string, parentId?: string): Promise<JobIdGeneration> {
      // Resolve project to get TypeID and slug
      const { id: projectId, slug } = await this.resolveProjectForJobId(projectInput);

      if (parentId) {
        // Child job: append next sequence number
        const depth = parentId.split('.').length;
        if (depth >= 3) {
          throw new Error('Max hierarchy depth (3) exceeded');
        }
        const nextSeq = await this.getNextChildSequence(parentId);
        return { id: `${parentId}.${nextSeq}`, projectId };
      }

      // Root job: generate hash-based ID using slug (human-readable)
      const input = `${slug}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
      const hash = crypto.createHash('sha256').update(input).digest('hex');
      const shortHash = hash.substring(0, 8);

      const id = `${slug}-${shortHash}`;

      // Handle collision (rare)
      if (await this.jobExists(id)) {
        // Retry with new random bytes
        return this.generateJobId(projectInput, parentId);
      }

      return { id, projectId };
    },

    /**
     * Get the next child sequence number for a parent job
     *
     * Finds the maximum child number and returns max + 1
     *
     * @param parentId - Parent job ID
     * @returns Next sequence number (1 if no children exist)
     */
    async getNextChildSequence(parentId: string): Promise<number> {
      const result = await db<{ next_seq: number }[]>`
        SELECT COALESCE(MAX(
          CAST(SPLIT_PART(id, '.', ARRAY_LENGTH(STRING_TO_ARRAY(id, '.'), 1)) AS INT)
        ), 0) + 1 as next_seq
        FROM jobs
        WHERE parent_id = ${parentId}
      `;
      return result[0]?.next_seq ?? 1;
    },

    /**
     * Check if a job ID exists in the database
     *
     * @param id - Job ID to check
     * @returns True if job exists, false otherwise
     */
    async jobExists(id: string): Promise<boolean> {
      const result = await db<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM jobs WHERE id = ${id}) as exists
      `;
      return result[0]?.exists ?? false;
    },

    /**
     * Resolve project slug from slug or TypeID
     *
     * If input starts with 'proj_', lookup by id and return project TypeID
     * Otherwise return the project TypeID for the given slug
     *
     * @param projectInput - Project slug (e.g., 'myproj') or TypeID (e.g., 'proj_xxx')
     * @returns Project TypeID (proj_xxx)
     * @throws Error if project not found
     */
    async resolveProjectSlug(projectInput: string): Promise<string> {
      // If input starts with 'proj_', it's a TypeID - lookup by id
      if (projectInput.startsWith('proj_')) {
        const result = await db<{ id: string }[]>`
          SELECT id FROM projects WHERE id = ${projectInput}
        `;
        if (!result[0]) {
          throw new Error(`Project not found: ${projectInput}`);
        }
        return result[0].id;
      }

      // Otherwise treat as slug - lookup by slug and return the TypeID
      const result = await db<{ id: string }[]>`
        SELECT id FROM projects WHERE slug = ${projectInput}
      `;
      if (!result[0]) {
        throw new Error(`Project not found: ${projectInput}`);
      }
      return result[0].id;
    },

    /**
     * Resolve project input to both TypeID and slug (for job ID generation)
     *
     * @param projectInput - Project slug or TypeID
     * @returns Both project TypeID and slug
     * @throws Error if project not found
     */
    async resolveProjectForJobId(projectInput: string): Promise<{ id: string; slug: string }> {
      if (projectInput.startsWith('proj_')) {
        const result = await db<{ id: string; slug: string }[]>`
          SELECT id, slug FROM projects WHERE id = ${projectInput}
        `;
        if (!result[0]) {
          throw new Error(`Project not found: ${projectInput}`);
        }
        return result[0];
      }

      const result = await db<{ id: string; slug: string }[]>`
        SELECT id, slug FROM projects WHERE slug = ${projectInput}
      `;
      if (!result[0]) {
        throw new Error(`Project not found: ${projectInput}`);
      }
      return result[0];
    },

    /**
     * Find a job by ID
     *
     * @param id - Job ID
     * @returns Job if found, null otherwise
     */
    async findById(id: string): Promise<Job | null> {
      const [row] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${id}
      `;
      return row ?? null;
    },

    /**
     * Check if a job is blocked by open dependencies
     *
     * Returns true if job has at least one open blocking dependency
     * (relation type: blocks, conditional_blocks, or waits_for)
     *
     * @param jobId - Job ID to check
     * @returns True if job is blocked, false otherwise
     */
    async isBlocked(jobId: string): Promise<boolean> {
      const [result] = await db<[{ blocked: boolean }]>`
        SELECT EXISTS (
          SELECT 1 FROM job_relations r
          JOIN jobs blocker ON blocker.id = r.related_job_id
          WHERE r.job_id = ${jobId}
            AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
            AND blocker.phase NOT IN ('done', 'cancelled')
        ) as blocked
      `;
      return result?.blocked ?? false;
    },

    /**
     * Create a new job
     *
     * @param job - Job data (without timestamps)
     * @returns Created job
     */
    async create(job: Omit<Job, 'created_at' | 'updated_at' | 'ready_at'>): Promise<Job> {
      const [row] = await db<Job[]>`
        INSERT INTO jobs (
          id,
          project_id,
          parent_id,
          depth,
          title,
          description,
          issue_type,
          labels,
          phase,
          ready_at,
          priority,
          assignee,
          review_required,
          review_status,
          reviewer,
          defer_until,
          due_at,
          harness,
          harness_profile,
          harness_options,
          harness_profile_override,
          env_overrides,
          token_scope,
          token_permissions,
          harness_profile_source,
          harness_profile_hash,
          hints,
          git_json,
          workspace_json,
          env_name,
          execution_mode,
          execution_type,
          run_id,
          step_name,
          action_type,
          action_input,
          script_command,
          script_timeout_seconds,
          content_hash,
          actor_user_id,
          closed_at,
          close_reason,
          target,
          resource_refs
        )
        VALUES (
          ${job.id},
          ${job.project_id},
          ${job.parent_id},
          ${job.depth},
          ${job.title},
          ${job.description},
          ${job.issue_type},
          ${job.labels},
          ${job.phase},
          ${job.phase === 'ready' ? db`NOW()` : null},
          ${job.priority},
          ${job.assignee},
          ${job.review_required},
          ${job.review_status},
          ${job.reviewer},
          ${job.defer_until},
          ${job.due_at},
          ${job.harness},
          ${job.harness_profile},
          ${job.harness_options ? db.json(job.harness_options as never) : null},
          ${job.harness_profile_override ? db.json(job.harness_profile_override as never) : null},
          ${job.env_overrides ? db.json(job.env_overrides as never) : null},
          ${job.token_scope ? db.json(job.token_scope as never) : null},
          ${job.token_permissions},
          ${job.harness_profile_source},
          ${job.harness_profile_hash},
          ${db.json((job.hints ?? {}) as never)},
          ${job.git_json ? db.json(job.git_json as never) : null},
          ${job.workspace_json ? db.json(job.workspace_json as never) : null},
          ${job.env_name},
          ${job.execution_mode},
          ${job.execution_type ?? 'agent'},
          ${job.run_id},
          ${job.step_name},
          ${job.action_type},
          ${job.action_input ? db.json(job.action_input as never) : null},
          ${job.script_command},
          ${job.script_timeout_seconds},
          ${job.content_hash},
          ${job.actor_user_id},
          ${job.closed_at},
          ${job.close_reason},
          ${job.target ? db.json(job.target as never) : null},
          ${db.json((job.resource_refs ?? []) as never)}
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Update job phase with validation
     *
     * Checks transition validity and review requirements per Part D:
     * - Validates the phase transition is allowed
     * - If review_required != 'none' and transitioning to 'done',
     *   requires current phase to be 'review' first
     * - Updates closed_at timestamp for terminal phases (done, cancelled)
     *
     * @param jobId - Job ID
     * @param newPhase - New phase to transition to
     * @param actor - Optional actor identifier for audit
     * @returns Result with success flag and updated job or error message
     */
    async updatePhase(
      jobId: string,
      newPhase: Job['phase'],
      actor?: string,
    ): Promise<UpdatePhaseResult> {
      // Get current job
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      const currentPhase = currentJob.phase;

      // Check if transition is valid
      if (!canTransition(currentPhase, newPhase)) {
        return {
          success: false,
          error: `Invalid phase transition: ${currentPhase} -> ${newPhase}`,
        };
      }

      // Check review requirement when transitioning to done
      if (newPhase === 'done' && currentJob.review_required !== 'none') {
        if (currentPhase !== 'review') {
          return {
            success: false,
            error: `Job requires review before completion. Current phase: ${currentPhase}, must be in 'review' phase first.`,
          };
        }
      }

      // Perform the update
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = ${newPhase},
          ready_at = ${newPhase === 'ready' ? db`NOW()` : db`ready_at`},
          updated_at = NOW(),
          closed_at = ${newPhase === 'done' || newPhase === 'cancelled' ? db`NOW()` : null}
        WHERE id = ${jobId}
        RETURNING *
      `;

      return {
        success: true,
        job: updatedJob,
      };
    },

    /**
     * Promote resolved git metadata from a successful attempt to the job record.
     * This makes the resolved SHA, branch, and other metadata directly available
     * on the job without needing to query attempts.
     */
    async updateResolvedGit(
      jobId: string,
      resolvedGit: JobAttemptGitMeta,
    ): Promise<void> {
      await db`
        UPDATE jobs
        SET resolved_git_json = ${db.json(resolvedGit as never)}::jsonb,
            updated_at = NOW()
        WHERE id = ${jobId}
      `;
    },

    /**
     * Get ready jobs for a project (scheduler query)
     *
     * Returns jobs that are schedulable (ready or active phase, not blocked, not deferred)
     * Per Part D of jobs-unified-design.md
     *
     * @param projectId - Project TypeID (proj_xxx)
     * @param options - Optional filters (assignee, limit)
     * @returns Array of ready jobs with project_slug
     */
    async getReadyJobs(
      projectId: string,
      options?: GetReadyJobsOptions,
    ): Promise<Job[]> {
      const assignee = options?.assignee ?? null;
      const limit = options?.limit ?? 10;

      // If assignee is explicitly null, only return unassigned jobs
      if (assignee === null) {
        return db<Job[]>`
          SELECT j.*, p.slug as project_slug
          FROM jobs j
          JOIN projects p ON p.id = j.project_id
          WHERE (${projectId} = '' OR j.project_id = ${projectId})
            AND j.phase IN ('ready', 'active')
            AND j.assignee IS NULL
            AND (j.defer_until IS NULL OR j.defer_until <= NOW())
            AND NOT EXISTS (
              SELECT 1 FROM job_relations r
              JOIN jobs blocker ON blocker.id = r.related_job_id
              WHERE r.job_id = j.id
                AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
                AND blocker.phase NOT IN ('done', 'cancelled')
            )
          ORDER BY j.priority ASC, j.created_at ASC
          LIMIT ${limit}
        `;
      }

      // Filter by specific assignee
      return db<Job[]>`
        SELECT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE (${projectId} = '' OR j.project_id = ${projectId})
          AND j.phase IN ('ready', 'active')
          AND j.assignee = ${assignee}
          AND (j.defer_until IS NULL OR j.defer_until <= NOW())
          AND NOT EXISTS (
            SELECT 1 FROM job_relations r
            JOIN jobs blocker ON blocker.id = r.related_job_id
            WHERE r.job_id = j.id
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
              AND blocker.phase NOT IN ('done', 'cancelled')
          )
        ORDER BY j.priority ASC, j.created_at ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Get ready jobs that are already assigned (agent-assigned workload).
     *
     * Returns jobs that are schedulable, assigned, and agent execution type.
     * Used by schedulers that should claim agent-assigned chat/agent jobs.
     */
    async getReadyAssignedJobs(
      projectId: string,
      options?: { limit?: number },
    ): Promise<Job[]> {
      const limit = options?.limit ?? 10;

      return db<Job[]>`
        SELECT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE (${projectId} = '' OR j.project_id = ${projectId})
          AND j.phase IN ('ready', 'active')
          AND j.assignee IS NOT NULL
          AND j.execution_type = 'agent'
          AND (j.defer_until IS NULL OR j.defer_until <= NOW())
          AND NOT EXISTS (
            SELECT 1 FROM job_relations r
            JOIN jobs blocker ON blocker.id = r.related_job_id
            WHERE r.job_id = j.id
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
              AND blocker.phase NOT IN ('done', 'cancelled')
          )
        ORDER BY j.priority ASC, j.created_at ASC
        LIMIT ${limit}
      `;
    },

    /**
     * Get all blocked jobs for a project
     *
     * Returns jobs that are in ready/active phase but have open blocking dependencies
     * Per Part D of jobs-unified-design.md
     *
     * @param projectId - Project TypeID (proj_xxx)
     * @returns Array of blocked jobs with project_slug
     */
    async getBlockedJobs(projectId: string): Promise<Job[]> {
      return db<Job[]>`
        SELECT DISTINCT j.*, p.slug as project_slug
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        JOIN job_relations r ON r.job_id = j.id
        JOIN jobs blocker ON blocker.id = r.related_job_id
        WHERE j.project_id = ${projectId}
          AND j.phase IN ('ready', 'active')
          AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          AND blocker.phase NOT IN ('done', 'cancelled')
        ORDER BY j.priority ASC, j.created_at ASC
      `;
    },

    /**
     * List jobs with filters
     *
     * @param projectId - Project TypeID
     * @param options - Filter options
     * @returns Array of jobs
     */
    async list(
      projectId: string,
      options?: {
        phase?: Job['phase'];
        assignee?: string;
        createdAfter?: Date;
        stuck?: boolean;
        stuckMinutes?: number;
        execution_type?: Job['execution_type'];
        label?: string;
        parentId?: string | null;
        failureDisposition?: string;
        limit?: number;
        offset?: number;
      }
    ): Promise<Job[]> {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      const phase = options?.phase;
      const assignee = options?.assignee;
      const createdAfter = options?.createdAfter;
      const stuck = options?.stuck;
      const stuckMinutes = options?.stuckMinutes ?? 5;
      const executionType = options?.execution_type;
      const label = options?.label;
      const parentId = options?.parentId;
      const failureDisposition = options?.failureDisposition;

      // Build dynamic WHERE conditions
      const conditions = [db`project_id = ${projectId}`];

      if (phase) {
        conditions.push(db`phase = ${phase}`);
      }

      if (assignee) {
        conditions.push(db`assignee = ${assignee}`);
      }

      if (createdAfter) {
        conditions.push(db`created_at >= ${createdAfter}`);
      }

      if (executionType) {
        conditions.push(db`execution_type = ${executionType}`);
      }

      if (label) {
        conditions.push(db`${label} = ANY(labels)`);
      }

      if (parentId !== undefined) {
        if (parentId === null) {
          conditions.push(db`parent_id IS NULL`);
        } else {
          conditions.push(db`parent_id = ${parentId}`);
        }
      }

      if (failureDisposition) {
        conditions.push(db`failure_disposition = ${failureDisposition}`);
      }

      if (stuck) {
        // Stuck = active phase with current attempt running > stuckMinutes
        conditions.push(db`phase = 'active'`);
        conditions.push(db`EXISTS (
          SELECT 1 FROM job_attempts a
          WHERE a.job_id = jobs.id
            AND a.status = 'running'
            AND a.started_at < NOW() - INTERVAL '${db.unsafe(String(stuckMinutes))} minutes'
        )`);
      }

      // Combine conditions with AND
      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<Job[]>`
        SELECT * FROM jobs
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * List jobs by pipeline run ID
     *
     * Returns all jobs that belong to a specific pipeline run, ordered by creation time.
     *
     * @param runId - Pipeline run ID
     * @returns Array of jobs in the run
     */
    async listByRunId(runId: string): Promise<Job[]> {
      return db<Job[]>`
        SELECT * FROM jobs
        WHERE run_id = ${runId}
        ORDER BY created_at ASC
      `;
    },

    /**
     * Find the next runnable job for a pipeline run
     *
     * Returns the next job in a pipeline run where:
     * - The job's status is 'ready'
     * - All jobs that block this job (via job_relations) are in 'done' or 'cancelled' phase
     *
     * @param runId - Pipeline run ID
     * @returns Next runnable job or null if none available
     */
    async findNextRunnableJobForRun(runId: string): Promise<Job | null> {
      const [job] = await db<Job[]>`
        SELECT j.*
        FROM jobs j
        WHERE j.run_id = ${runId}
          AND j.phase = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM job_relations r
            JOIN jobs blocker ON blocker.id = r.related_job_id
            WHERE r.job_id = j.id
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
              AND blocker.phase NOT IN ('done', 'cancelled')
          )
        ORDER BY j.created_at ASC
        LIMIT 1
      `;
      return job ?? null;
    },

    /**
     * List all jobs across projects (admin query)
     *
     * Unlike `list()`, this doesn't require a project ID.
     * Supports optional filtering by org, project, and phase.
     *
     * @param options - Filter options
     * @returns Array of jobs with project_slug and org_id
     */
    async listAll(options?: {
      orgId?: string;
      projectId?: string;
      phase?: Job['phase'];
      execution_type?: Job['execution_type'];
      label?: string;
      parentId?: string | null;
      failureDisposition?: string;
      limit?: number;
      offset?: number;
    }): Promise<Array<Job & { project_slug: string; org_id: string }>> {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      const orgId = options?.orgId;
      const projectId = options?.projectId;
      const phase = options?.phase;
      const executionType = options?.execution_type;
      const label = options?.label;
      const parentId = options?.parentId;
      const failureDisposition = options?.failureDisposition;

      // Build dynamic WHERE conditions
      const conditions: ReturnType<typeof db>[] = [];

      if (orgId) {
        conditions.push(db`p.org_id = ${orgId}`);
      }

      if (projectId) {
        conditions.push(db`j.project_id = ${projectId}`);
      }

      if (phase) {
        conditions.push(db`j.phase = ${phase}`);
      }

      if (executionType) {
        conditions.push(db`j.execution_type = ${executionType}`);
      }

      if (label) {
        conditions.push(db`${label} = ANY(j.labels)`);
      }

      if (parentId !== undefined) {
        if (parentId === null) {
          conditions.push(db`j.parent_id IS NULL`);
        } else {
          conditions.push(db`j.parent_id = ${parentId}`);
        }
      }

      if (failureDisposition) {
        conditions.push(db`j.failure_disposition = ${failureDisposition}`);
      }

      // Build WHERE clause (or TRUE if no conditions)
      const whereClause = conditions.length > 0
        ? conditions.reduce((acc, cond, i) =>
            i === 0 ? cond : db`${acc} AND ${cond}`
          )
        : db`TRUE`;

      return db<Array<Job & { project_slug: string; org_id: string }>>`
        SELECT j.*, p.slug as project_slug, p.org_id
        FROM jobs j
        JOIN projects p ON p.id = j.project_id
        WHERE ${whereClause}
        ORDER BY j.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * Get job hierarchy (parent + children)
     *
     * @param rootId - Root job ID
     * @returns Array of jobs in the hierarchy
     */
    async getHierarchy(rootId: string): Promise<Job[]> {
      return db<Job[]>`
        WITH RECURSIVE job_tree AS (
          -- Start with the root job
          SELECT * FROM jobs WHERE id = ${rootId}

          UNION ALL

          -- Recursively find children
          SELECT j.* FROM jobs j
          INNER JOIN job_tree jt ON j.parent_id = jt.id
        )
        SELECT * FROM job_tree
        ORDER BY depth ASC, created_at ASC
      `;
    },

    /**
     * Get direct children for a job
     *
     * @param jobId - Parent job ID
     * @returns Array of direct child jobs
     */
    async getChildren(jobId: string): Promise<Job[]> {
      return db<Job[]>`
        SELECT * FROM jobs
        WHERE parent_id = ${jobId}
        ORDER BY created_at ASC
      `;
    },

    /**
     * Add a job dependency (relation)
     *
     * Creates a relation where fromId depends on toId (toId blocks fromId)
     * Semantics: "fromId depends on toId" = "toId blocks fromId"
     *
     * @param fromId - Job that has the dependency (the blocked job)
     * @param toId - Job that must complete first (the blocking job)
     * @param relationType - Type of relation (blocks, conditional_blocks, waits_for, related, discovered_from)
     * @returns Created relation ID
     */
    async addDependency(
      fromId: string,
      toId: string,
      relationType: string = 'blocks',
    ): Promise<string> {
      // Validate both jobs exist
      const [fromJob, toJob] = await Promise.all([
        this.findById(fromId),
        this.findById(toId),
      ]);

      if (!fromJob) {
        throw new Error(`Job not found: ${fromId}`);
      }

      if (!toJob) {
        throw new Error(`Job not found: ${toId}`);
      }

      // Insert relation (job_id depends on related_job_id)
      const [result] = await db<[{ id: string }]>`
        INSERT INTO job_relations (job_id, related_job_id, relation_type)
        VALUES (${fromId}, ${toId}, ${relationType})
        ON CONFLICT (job_id, related_job_id, relation_type) DO NOTHING
        RETURNING id
      `;

      return result?.id ?? '';
    },

    /**
     * Remove a job dependency
     *
     * @param fromId - Job that has the dependency
     * @param toId - Job that blocks it
     * @returns True if relation was deleted, false if not found
     */
    async removeDependency(fromId: string, toId: string): Promise<boolean> {
      const result = await db<[{ count: number }]>`
        DELETE FROM job_relations
        WHERE job_id = ${fromId} AND related_job_id = ${toId}
        RETURNING id
      `;

      return result.length > 0;
    },

    /**
     * Get dependencies for a job (jobs this one depends on)
     *
     * Returns jobs that this job depends on (i.e., jobs that block this one)
     *
     * @param jobId - Job ID
     * @returns Array of jobs with relation metadata
     */
    async getDependencies(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.related_job_id
        WHERE r.job_id = ${jobId}
        ORDER BY j.phase DESC, j.priority ASC
      `;
    },

    /**
     * Get dependents for a job (jobs that depend on this one)
     *
     * Returns jobs that depend on this job (i.e., jobs this one blocks)
     *
     * @param jobId - Job ID
     * @returns Array of jobs with relation metadata
     */
    async getDependents(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.job_id
        WHERE r.related_job_id = ${jobId}
        ORDER BY j.phase DESC, j.priority ASC
      `;
    },

    /**
     * Get OPEN jobs currently blocking this job
     *
     * Returns only jobs that are NOT done and have a blocking relation type
     *
     * @param jobId - Job ID to check
     * @returns Array of blocking jobs that are still open
     */
    async getBlockingJobs(jobId: string): Promise<Array<Job & { relation_type: string }>> {
      return db<Array<Job & { relation_type: string }>>`
        SELECT j.*, r.relation_type
        FROM job_relations r
        JOIN jobs j ON j.id = r.related_job_id
        WHERE r.job_id = ${jobId}
          AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          AND j.phase NOT IN ('done', 'cancelled')
        ORDER BY j.priority ASC, j.created_at ASC
      `;
    },

    /**
     * Claim a job by creating an attempt and transitioning to active phase
     *
     * Process:
     * 1. Check job exists and is in 'ready' phase
     * 2. Get next attempt number
     * 3. Insert attempt with status='running'
     * 4. Update job phase to 'active' and set assignee
     * 5. Audit log both operations
     * 6. Return the attempt
     *
     * @param jobId - Job ID to claim
     * @param agentId - Agent identifier claiming the job
     * @param harness - Optional harness name (e.g., 'mclaude')
     * @returns Result with attempt or error
     */
    async claim(
      jobId: string,
      agentId: string,
      harness?: string,
    ): Promise<ClaimResult> {
      // 1. Check job exists
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      // Claim normally requires a job to be in 'ready', but review rejection creates a
      // pending auto_retry attempt while leaving the job in 'active'. In that case we
      // "claim" by starting the pending attempt rather than inserting a new one.
      if (currentJob.phase !== 'ready' && currentJob.phase !== 'active') {
        return {
          success: false,
          error: `Job must be in 'ready' or 'active' phase to claim (current: ${currentJob.phase})`,
        };
      }

      const [pendingAttempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'pending'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (pendingAttempt) {
        // Start the pending attempt (idempotent-ish: guarded by status='pending').
        const [attempt] = await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'running',
            harness = COALESCE(${harness ?? null}, harness),
            agent_id = ${agentId},
            started_at = NOW(),
            harness_profile_source = COALESCE(harness_profile_source, ${currentJob.harness_profile_source}),
            harness_profile_hash = COALESCE(harness_profile_hash, ${currentJob.harness_profile_hash}),
            runtime_meta = COALESCE(runtime_meta, '{}'::jsonb)
          WHERE id = ${pendingAttempt.id}::uuid
            AND status = 'pending'
          RETURNING *
        `;

        if (!attempt) {
          return {
            success: false,
            error: `Pending attempt was already claimed for job: ${jobId}`,
          };
        }

        // Ensure the job is marked active and assigned.
        await db`
          UPDATE jobs
          SET
            phase = 'active',
            assignee = ${agentId},
            updated_at = NOW()
          WHERE id = ${jobId}
        `;

        await db`
          INSERT INTO audit_log (
            entity_type,
            entity_id,
            action,
            actor,
            actor_type,
            changes,
            context
          )
          VALUES (
            'job',
            ${jobId},
            'updated',
            ${agentId},
            'agent',
            ${db.json({
              phase: { old: currentJob.phase, new: 'active' },
              assignee: { old: currentJob.assignee, new: agentId },
            })},
            ${db.json({ claim_attempt: attempt.id, claim_mode: 'pending_attempt' })}
          )
        `;

        await db`
          INSERT INTO audit_log (
            entity_type,
            entity_id,
            action,
            actor,
            actor_type,
            changes,
            context
          )
          VALUES (
            'job_attempt',
            ${attempt.id},
            'updated',
            ${agentId},
            'agent',
            ${db.json({
              status: { old: 'pending', new: 'running' },
              agent_id: { old: pendingAttempt.agent_id, new: agentId },
              harness: { old: pendingAttempt.harness, new: harness ?? pendingAttempt.harness },
            })},
            ${db.json({ job_id: jobId })}
          )
        `;

        return {
          success: true,
          attempt,
        };
      }

      if (currentJob.phase !== 'ready') {
        return {
          success: false,
          error: `Job must be in 'ready' phase to claim (current: ${currentJob.phase})`,
        };
      }

      // 2. Get next attempt number
      const [countResult] = await db<[{ count: number }]>`
        SELECT COUNT(*)::int as count
        FROM job_attempts
        WHERE job_id = ${jobId}
      `;
      const nextAttemptNumber = (countResult?.count ?? 0) + 1;

      // 3. Insert attempt with status='running'
      const [attempt] = await db<JobAttempt[]>`
        INSERT INTO job_attempts (
          job_id,
          attempt_number,
          status,
          trigger_type,
          harness,
          agent_id,
          started_at,
          harness_profile_source,
          harness_profile_hash,
          runtime_meta
        )
        VALUES (
          ${jobId},
          ${nextAttemptNumber},
          'running',
          'manual',
          ${harness ?? null},
          ${agentId},
          NOW(),
          ${currentJob.harness_profile_source},
          ${currentJob.harness_profile_hash},
          ${db.json({})}
        )
        RETURNING *
      `;

      // 4. Update job phase to 'active' and set assignee
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'active',
          assignee = ${agentId},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 5. Audit log both operations
      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${agentId},
          'agent',
          ${db.json({
            phase: { old: currentJob.phase, new: 'active' },
            assignee: { old: currentJob.assignee, new: agentId },
          })},
          ${db.json({ claim_attempt: attempt.id })}
        )
      `;

      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job_attempt',
          ${attempt.id},
          'created',
          ${agentId},
          'agent',
          ${db.json({
            attempt_number: { old: null, new: nextAttemptNumber },
            status: { old: null, new: 'running' },
          })},
          ${db.json({ job_id: jobId })}
        )
      `;

      return {
        success: true,
        attempt,
      };
    },

    /**
     * Release a job by ending the current attempt and setting back to ready
     *
     * Process:
     * 1. Check job exists and is in 'active' phase
     * 2. Get current running attempt
     * 3. End the attempt (set ended_at, status='cancelled')
     * 4. Update job phase to 'ready' and clear assignee
     * 5. Audit log both operations
     * 6. Return the updated job
     *
     * @param jobId - Job ID to release
     * @param agentId - Agent identifier releasing the job
     * @param reason - Optional reason for release
     * @returns Result with job or error
     */
    async release(
      jobId: string,
      agentId: string,
      reason?: string,
    ): Promise<ReleaseResult> {
      // 1. Check job exists and is in 'active' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      if (currentJob.phase !== 'active') {
        return {
          success: false,
          error: `Job must be in 'active' phase to release (current: ${currentJob.phase})`,
        };
      }

      // 2. Get current running attempt
      const [currentAttempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'running'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (!currentAttempt) {
        // Idempotent fallback: if the active attempt was already finalized by
        // another path, still requeue the job to ready.
        const [requeuedJob] = await db<Job[]>`
          UPDATE jobs
          SET
            phase = 'ready',
            ready_at = NOW(),
            assignee = NULL,
            updated_at = NOW()
          WHERE id = ${jobId}
            AND phase = 'active'
          RETURNING *
        `;

        if (requeuedJob) {
          await db`
            INSERT INTO audit_log (
              entity_type,
              entity_id,
              action,
              actor,
              actor_type,
              changes,
              context
            )
            VALUES (
              'job',
              ${jobId},
              'updated',
              ${agentId},
              'agent',
              ${db.json({
                phase: { old: 'active', new: 'ready' },
                assignee: { old: currentJob.assignee, new: null },
              })},
              ${db.json({ reason: reason ?? 'Job released by agent', release_mode: 'no_running_attempt' })}
            )
          `;

          return {
            success: true,
            job: requeuedJob,
          };
        }

        return {
          success: false,
          error: `No running attempt found for job: ${jobId}`,
        };
      }

      // 3. End the attempt
      const [endedAttempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET
          status = 'cancelled',
          ended_at = NOW(),
          result_summary = ${reason ?? 'Job released by agent'}
        WHERE id = ${currentAttempt.id}
        RETURNING *
      `;

      // 4. Update job phase to 'ready' and clear assignee
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'ready',
          ready_at = NOW(),
          assignee = NULL,
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 5. Audit log both operations
      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job_attempt',
          ${endedAttempt.id},
          'updated',
          ${agentId},
          'agent',
          ${db.json({
            status: { old: 'running', new: 'cancelled' },
            ended_at: { old: null, new: endedAttempt.ended_at },
          })},
          ${db.json({ job_id: jobId, reason })}
        )
      `;

      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${agentId},
          'agent',
          ${db.json({
            phase: { old: 'active', new: 'ready' },
            assignee: { old: currentJob.assignee, new: null },
          })},
          ${db.json({ release_attempt: endedAttempt.id })}
        )
      `;

      return {
        success: true,
        job: updatedJob,
      };
    },

    /**
     * Requeue a job back to ready without cancelling the current attempt.
     *
     * Used when a completed attempt needs to wait on dependencies or
     * re-enter the scheduler without changing attempt history.
     *
     * @param jobId - Job ID to requeue
     * @param actor - Actor identifier performing the requeue
     * @param options - Optional defer/backoff and reason
     * @returns Updated job or null if not found
     */
    async requeueReady(
      jobId: string,
      actor: string,
      options?: RequeueReadyOptions,
    ): Promise<Job | null> {
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        return null;
      }

      const hasDeferUntil = Object.prototype.hasOwnProperty.call(options ?? {}, 'deferUntil');
      const deferUntil = options?.deferUntil ?? null;

      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'ready',
          ready_at = NOW(),
          assignee = NULL,
          updated_at = NOW()
          ${hasDeferUntil ? db`, defer_until = ${deferUntil}` : db``}
        WHERE id = ${jobId}
        RETURNING *
      `;

      const changes: Record<string, { old: unknown; new: unknown }> = {
        phase: { old: currentJob.phase, new: 'ready' },
        assignee: { old: currentJob.assignee, new: null },
      };

      if (hasDeferUntil) {
        changes.defer_until = { old: currentJob.defer_until, new: deferUntil };
      }

      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${actor},
          'agent',
          ${db.json(changes as never)},
          ${db.json({ reason: options?.reason ?? null })}
        )
      `;

      return updatedJob ?? null;
    },

    /**
     * Get the current running attempt for a job
     *
     * @param jobId - Job ID
     * @returns Current attempt if found, null otherwise
     */
    async getCurrentAttempt(jobId: string): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
          AND status = 'running'
        ORDER BY attempt_number DESC
        LIMIT 1
      `;
      return attempt ?? null;
    },

    /**
     * List all attempts for a job
     *
     * @param jobId - Job ID
     * @returns Array of attempts ordered by attempt number descending
     */
    async listAttempts(jobId: string): Promise<JobAttempt[]> {
      return db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
        ORDER BY attempt_number DESC
      `;
    },

    /**
     * Get the latest attempt for a job
     *
     * @param jobId - Job ID
     * @returns Latest attempt or null
     */
    async getLatestAttempt(jobId: string): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        SELECT * FROM job_attempts
        WHERE job_id = ${jobId}
        ORDER BY attempt_number DESC
        LIMIT 1
      `;
      return attempt ?? null;
    },

    /**
     * Get the most recent rejection reason for a job
     *
     * @param jobId - Job ID
     * @returns Rejection reason or null if none
     */
    async getLatestRejectionReason(jobId: string): Promise<string | null> {
      const [row] = await db<{ reason: string | null }[]>`
        SELECT context->>'reason' as reason
        FROM audit_log
        WHERE entity_type = 'job'
          AND entity_id = ${jobId}
          AND context->>'action' = 'reject_review'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row?.reason ?? null;
    },

    /**
     * Complete an attempt with result data
     *
     * Updates the attempt with the final status and result fields.
     * Sets ended_at timestamp automatically.
     *
     * @param attemptId - Attempt UUID
     * @param status - Final status ('succeeded' or 'failed')
     * @param result - Optional result fields (exitCode, resultText, etc.)
     * @returns Updated attempt or null if not found
     */
    async completeAttempt(
      attemptId: string,
      status: 'succeeded' | 'failed',
      result?: CompleteAttemptResult,
    ): Promise<JobAttempt | null> {
      const resultJsonValue = result?.resultJson
        ? db.json(result.resultJson as never)
        : null;

      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET
          status = ${status},
          ended_at = NOW(),
          exit_code = COALESCE(${result?.exitCode ?? null}, exit_code),
          result_text = COALESCE(${result?.resultText ?? null}, result_text),
          result_json = COALESCE(${resultJsonValue}::jsonb, result_json),
          result_summary = COALESCE(${result?.resultSummary ?? null}, result_summary),
          duration_ms = COALESCE(${result?.durationMs ?? null}, duration_ms),
          token_input = COALESCE(${result?.tokenInput ?? null}, token_input),
          token_output = COALESCE(${result?.tokenOutput ?? null}, token_output),
          error_message = COALESCE(${result?.errorMessage ?? null}, error_message)
        WHERE id = ${attemptId}::uuid
          AND status = 'running'
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Update runtime metadata for an attempt
     *
     * Used to store runtime-specific information like pod name, namespace, etc.
     * This is useful for tools that need to tail logs or inspect runtime resources.
     *
     * @param attemptId - Attempt UUID
     * @param runtimeMeta - Runtime metadata to merge with existing data
     * @returns Updated attempt or null if not found
     */
    async updateRuntimeMeta(
      attemptId: string,
      runtimeMeta: Record<string, unknown>,
    ): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET runtime_meta = runtime_meta || ${db.json(runtimeMeta as never)}::jsonb
        WHERE id = ${attemptId}::uuid
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Mark an attempt as having started execution (idempotent).
     *
     * This is distinct from `started_at` (claim time). It should be set at the
     * first point where the worker begins mutating the workspace / executing hooks.
     */
    async markExecutionStarted(attemptId: string): Promise<void> {
      await db`
        UPDATE job_attempts
        SET execution_started_at = NOW()
        WHERE id = ${attemptId}::uuid AND execution_started_at IS NULL
      `;
    },

    /**
     * Persist an attempt-scoped execution receipt (v2) and materialize totals for aggregation.
     *
     * Receipt JSON is stored as-is (self-contained), while totals are duplicated into
     * dedicated columns for fast spend queries.
     */
    async updateAttemptReceipt(
      attemptId: string,
      receiptJson: Record<string, unknown>,
      materialized: { baseTotalUsd: string; billedTotal: string; billedCurrency: string },
    ): Promise<void> {
      await db`
        UPDATE job_attempts
        SET
          receipt_json = ${db.json(receiptJson as never)}::jsonb,
          receipt_base_total_usd = ${materialized.baseTotalUsd}::numeric,
          receipt_billed_total = ${materialized.billedTotal}::numeric,
          receipt_billed_currency = ${materialized.billedCurrency}
        WHERE id = ${attemptId}::uuid
      `;
    },

    /**
     * Update result_json for an attempt
     *
     * Merges the provided JSON data into the attempt's existing result_json.
     * Useful for adding pipeline outputs or other metadata after attempt completion.
     *
     * @param attemptId - Attempt UUID
     * @param resultJson - JSON data to merge into result_json
     * @returns Updated attempt or null if not found
     */
    async updateAttemptResultJson(
      attemptId: string,
      resultJson: Record<string, unknown>,
    ): Promise<JobAttempt | null> {
      const [attempt] = await db<JobAttempt[]>`
        UPDATE job_attempts
        SET result_json = COALESCE(result_json, '{}'::jsonb) || ${db.json(resultJson as never)}::jsonb
        WHERE id = ${attemptId}::uuid
        RETURNING *
      `;
      return attempt ?? null;
    },

    /**
     * Get just the result fields for an attempt
     *
     * Fetches only the result-related columns for efficiency when
     * you only need to check the outcome of an attempt.
     *
     * @param attemptId - Attempt UUID
     * @returns Result data or null if attempt not found
     */
    async getAttemptResult(attemptId: string): Promise<AttemptResultData | null> {
      const [row] = await db<{
        exit_code: number | null;
        result_text: string | null;
        result_json: Record<string, unknown> | null;
        duration_ms: number | null;
        token_input: number | null;
        token_output: number | null;
        error_message: string | null;
        status: string;
      }[]>`
        SELECT
          exit_code,
          result_text,
          result_json,
          duration_ms,
          token_input,
          token_output,
          error_message,
          status
        FROM job_attempts
        WHERE id = ${attemptId}::uuid
      `;

      if (!row) {
        return null;
      }

      return {
        exitCode: row.exit_code,
        resultText: row.result_text,
        resultJson: row.result_json,
        durationMs: row.duration_ms,
        tokenInput: row.token_input,
        tokenOutput: row.token_output,
        errorMessage: row.error_message,
        status: row.status,
      };
    },

    /**
     * Submit a job for review
     *
     * Validates job is in 'active' phase, ends current attempt as completed,
     * and transitions job to 'review' phase.
     *
     * @param jobId - Job ID
     * @param agentId - Agent identifier submitting the review
     * @param summary - Summary of work completed
     * @returns Updated job
     */
    async submitForReview(
      jobId: string,
      agentId: string,
      summary: string,
    ): Promise<Job> {
      // 1. Validate job is in 'active' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'active') {
        throw new Error(
          `Cannot submit for review. Job must be in 'active' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Find current active attempt (may already be 'succeeded' if completion event fired first)
      const [activeAttempt] = await db<{ id: string; attempt_number: number; status: string }[]>`
        SELECT id, attempt_number, status FROM job_attempts
        WHERE job_id = ${jobId} AND status IN ('running', 'succeeded')
        ORDER BY attempt_number DESC
        LIMIT 1
      `;

      if (!activeAttempt) {
        throw new Error(`No active attempt found for job: ${jobId}`);
      }

      // End the attempt
      await db`
        UPDATE job_attempts
        SET
          status = 'succeeded',
          ended_at = NOW(),
          result_summary = ${summary}
        WHERE id = ${activeAttempt.id}
      `;

      // 3. Update job phase to 'review'
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'review',
          review_status = 'pending',
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 4. Audit log the submission
      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${agentId},
          'agent',
          ${db.json({
            phase: { old: 'active', new: 'review' },
            review_status: { old: currentJob.review_status, new: 'pending' },
          })},
          ${db.json({
            action: 'submit_for_review',
            attempt_id: activeAttempt.id,
            summary,
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Approve a job in review
     *
     * Validates job is in 'review' phase and transitions to 'done' phase.
     *
     * @param jobId - Job ID
     * @param reviewerId - Reviewer identifier
     * @param comment - Optional approval comment
     * @returns Updated job
     */
    async approveReview(
      jobId: string,
      reviewerId: string,
      comment?: string,
    ): Promise<Job> {
      // 1. Validate job is in 'review' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'review') {
        throw new Error(
          `Cannot approve. Job must be in 'review' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Update job to done with review metadata
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'done',
          review_status = 'approved',
          reviewer = ${reviewerId},
          closed_at = NOW(),
          close_reason = ${comment ?? 'Review approved'},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 3. Audit log the approval
      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${reviewerId},
          'user',
          ${db.json({
            phase: { old: 'review', new: 'done' },
            review_status: { old: 'pending', new: 'approved' },
            reviewer: { old: currentJob.reviewer, new: reviewerId },
          })},
          ${db.json({
            action: 'approve_review',
            comment: comment ?? '',
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Reject a job in review
     *
     * Validates job is in 'review' phase, transitions back to 'active' phase,
     * and creates a new attempt automatically.
     *
     * @param jobId - Job ID
     * @param reviewerId - Reviewer identifier
     * @param reason - Rejection reason
     * @returns Updated job
     */
    async rejectReview(
      jobId: string,
      reviewerId: string,
      reason: string,
    ): Promise<Job> {
      // 1. Validate job is in 'review' phase
      const [currentJob] = await db<Job[]>`
        SELECT * FROM jobs WHERE id = ${jobId}
      `;

      if (!currentJob) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (currentJob.phase !== 'review') {
        throw new Error(
          `Cannot reject. Job must be in 'review' phase, currently: ${currentJob.phase}`,
        );
      }

      // 2. Update job back to active with rejection metadata
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'active',
          review_status = 'rejected',
          reviewer = ${reviewerId},
          updated_at = NOW()
        WHERE id = ${jobId}
        RETURNING *
      `;

      // 3. Create new attempt for retry
      const [nextAttemptNum] = await db<{ next_num: number }[]>`
        SELECT COALESCE(MAX(attempt_number), 0) + 1 as next_num
        FROM job_attempts
        WHERE job_id = ${jobId}
      `;

      await db`
        INSERT INTO job_attempts (
          job_id,
          attempt_number,
          status,
          trigger_type,
          harness_profile_source,
          harness_profile_hash,
          result_summary
        )
        VALUES (
          ${jobId},
          ${nextAttemptNum.next_num},
          'pending',
          'auto_retry',
          ${currentJob.harness_profile_source},
          ${currentJob.harness_profile_hash},
          ${`Retry after rejection: ${reason}`}
        )
      `;

      // 4. Audit log the rejection
      await db`
        INSERT INTO audit_log (
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          context
        )
        VALUES (
          'job',
          ${jobId},
          'updated',
          ${reviewerId},
          'user',
          ${db.json({
            phase: { old: 'review', new: 'active' },
            review_status: { old: 'pending', new: 'rejected' },
            reviewer: { old: currentJob.reviewer, new: reviewerId },
          })},
          ${db.json({
            action: 'reject_review',
            reason,
            new_attempt_number: nextAttemptNum.next_num,
          })}
        )
      `;

      return updatedJob;
    },

    /**
     * Claim the next available ready job for execution (scheduler pattern)
     *
     * Atomically selects and claims a ready job in a single transaction.
     * This is a convenience method for orchestrators that want to claim any available job.
     *
     * @param projectId - Optional project ID to filter jobs
     * @param agentId - Agent identifier claiming the job (defaults to 'orchestrator')
     * @param harness - Optional harness name
     * @returns Claimed job and attempt, or null if no jobs available
     */
    async claimNextJob(
      projectId?: string,
      agentId: string = 'orchestrator',
      harness?: string,
    ): Promise<{ job: Job; attempt: JobAttempt } | null> {
      // Find next ready job
      const readyJobs = await this.getReadyJobs(
        projectId ?? '',
        { limit: 1 },
      );

      if (readyJobs.length === 0) {
        return null;
      }

      const job = readyJobs[0];

      // Claim it - use job's harness if no harness specified
      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = harness ?? job.harness ?? hintHarness ?? undefined;
      const result = await this.claim(job.id, agentId, effectiveHarness);

      if (!result.success || !result.attempt) {
        // Job may have been claimed by another worker
        return null;
      }

      // Refetch job to get updated state
      const updatedJob = await this.findById(job.id);
      if (!updatedJob) {
        return null;
      }

      return { job: updatedJob, attempt: result.attempt };
    },

    /**
     * Claim the next available ready job that is already assigned.
     *
     * Uses the existing assignee as the claiming agent so the assignment remains stable.
     */
    async claimNextAssignedJob(
      projectId?: string,
    ): Promise<{ job: Job; attempt: JobAttempt } | null> {
      const readyJobs = await this.getReadyAssignedJobs(
        projectId ?? '',
        { limit: 1 },
      );

      if (readyJobs.length === 0) {
        return null;
      }

      const job = readyJobs[0];
      const agentId = job.assignee ?? 'orchestrator';

      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = job.harness ?? hintHarness ?? undefined;
      const result = await this.claim(job.id, agentId, effectiveHarness);

      if (!result.success || !result.attempt) {
        return null;
      }

      const updatedJob = await this.findById(job.id);
      if (!updatedJob) {
        return null;
      }

      return { job: updatedJob, attempt: result.attempt };
    },

    /**
     * Mark a job as done (convenience method for orchestrator)
     *
     * For jobs without review_required, this transitions directly to 'done'.
     * For jobs with review_required, use submitForReview instead.
     *
     * @param jobId - Job ID
     * @param summary - Optional summary of work completed
     * @returns Updated job or null if transition not allowed
     */
    async markJobDone(jobId: string, summary?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'done' || job.phase === 'cancelled') return job;

      // If job requires review, use the review flow
      if (job.review_required !== 'none') {
        if (job.phase === 'active') {
          await this.submitForReview(jobId, job.assignee ?? 'orchestrator', summary ?? 'Completed');
        }
        return this.findById(jobId);
      }

      // Direct transition to done
      const result = await this.updatePhase(jobId, 'done', job.assignee ?? 'orchestrator');
      return result.job ?? null;
    },

    /**
     * Cancel a job and end any running attempt.
     *
     * @param jobId - Job ID
     * @param reason - Optional cancellation reason
     * @returns Updated job or null if not found
     */
    async cancelJob(jobId: string, reason?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'cancelled' || job.phase === 'done') return job;

      const currentAttempt = await this.getCurrentAttempt(jobId);
      if (currentAttempt) {
        await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'cancelled',
            ended_at = NOW(),
            result_summary = ${reason ?? 'Job cancelled'}
          WHERE id = ${currentAttempt.id}
          RETURNING *
        `;
      }

      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'cancelled',
          closed_at = NOW(),
          close_reason = ${reason ?? 'Job cancelled'},
          failure_disposition = 'cancelled',
          updated_at = NOW()
        WHERE id = ${jobId}
          AND phase NOT IN ('done', 'cancelled')
        RETURNING *
      `;

      // Ensure cancellations never leave stale gate locks behind.
      await db`DELETE FROM job_gates WHERE job_id = ${jobId}`;
      await db`
        UPDATE jobs
        SET blocked_on_gates = '{}', updated_at = NOW()
        WHERE id = ${jobId}
      `;

      // Cancel backlog children (staged dispatch members that were never promoted)
      if (updatedJob) {
        const backlogCancelled = await db<{ id: string }[]>`
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${'Parent job ' + jobId + ' cancelled'},
            failure_disposition = 'cancelled',
            updated_at = NOW()
          WHERE parent_id = ${jobId}
            AND phase = 'backlog'
          RETURNING id
        `;
        if (backlogCancelled.length > 0) {
          console.log(
            `Cancelled ${backlogCancelled.length} backlog child(ren) for ${jobId}: ${backlogCancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      return updatedJob ?? null;
    },

    /**
     * Mark a job as failed (convenience method for orchestrator)
     *
     * Transitions job to 'cancelled' phase with an error reason.
     * Also ends any running attempt.
     *
     * @param jobId - Job ID
     * @param reason - Failure reason
     * @returns Updated job or null if not found
     */
    async markJobFailed(jobId: string, reason?: string): Promise<Job | null> {
      const job = await this.findById(jobId);
      if (!job) return null;
      if (job.phase === 'done' || job.phase === 'cancelled') return job;

      // End any running attempt
      const currentAttempt = await this.getCurrentAttempt(jobId);
      if (currentAttempt) {
        await db<JobAttempt[]>`
          UPDATE job_attempts
          SET
            status = 'failed',
            ended_at = NOW(),
            result_summary = ${reason ?? 'Job failed'}
          WHERE id = ${currentAttempt.id}
          RETURNING *
        `;
      }

      // Transition to cancelled
      const [updatedJob] = await db<Job[]>`
        UPDATE jobs
        SET
          phase = 'cancelled',
          closed_at = NOW(),
          close_reason = ${reason ?? 'Job failed'},
          failure_disposition = 'failed',
          updated_at = NOW()
        WHERE id = ${jobId}
          AND phase NOT IN ('done', 'cancelled')
        RETURNING *
      `;

      await db`DELETE FROM job_gates WHERE job_id = ${jobId}`;
      await db`
        UPDATE jobs
        SET blocked_on_gates = '{}', updated_at = NOW()
        WHERE id = ${jobId}
      `;

      // Cascade-cancel downstream jobs that transitively depend on this one.
      // Uses a recursive CTE to walk the dependency graph in a single query,
      // preventing orphaned jobs from accumulating in 'ready' phase.
      if (updatedJob) {
        const cascadeReason = `Upstream job ${jobId} failed`;
        const cancelled = await db<{ id: string }[]>`
          WITH RECURSIVE downstream AS (
            SELECT r.job_id AS id
            FROM job_relations r
            WHERE r.related_job_id = ${jobId}
              AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
            UNION
            SELECT r.job_id AS id
            FROM job_relations r
            JOIN downstream d ON r.related_job_id = d.id
            WHERE r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
          )
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${cascadeReason},
            failure_disposition = 'upstream_failed',
            updated_at = NOW()
          WHERE id IN (SELECT id FROM downstream)
            AND phase NOT IN ('done', 'cancelled')
          RETURNING id
        `;

        if (cancelled.length > 0) {
          const cancelledIds = cancelled.map((row) => row.id);
          await db`DELETE FROM job_gates WHERE job_id = ANY(${cancelledIds})`;
          await db`
            UPDATE jobs
            SET blocked_on_gates = '{}', updated_at = NOW()
            WHERE id = ANY(${cancelledIds})
          `;
        }

        if (cancelled.length > 0) {
          console.log(
            `Cascade-cancelled ${cancelled.length} downstream job(s) for ${jobId}: ${cancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      // Cancel backlog children (staged dispatch members that were never promoted)
      if (updatedJob) {
        const backlogCancelled = await db<{ id: string }[]>`
          UPDATE jobs
          SET
            phase = 'cancelled',
            closed_at = NOW(),
            close_reason = ${'Parent job ' + jobId + ' failed'},
            failure_disposition = 'upstream_failed',
            updated_at = NOW()
          WHERE parent_id = ${jobId}
            AND phase = 'backlog'
          RETURNING id
        `;
        if (backlogCancelled.length > 0) {
          console.log(
            `Cancelled ${backlogCancelled.length} backlog child(ren) for ${jobId}: ${backlogCancelled.map(j => j.id).join(', ')}`,
          );
        }
      }

      return updatedJob ?? null;
    },

    /**
     * Get review history for a job
     *
     * Returns all review submissions and decisions for the job.
     *
     * @param jobId - Job ID
     * @returns Array of review-related audit entries
     */
    async getReviewHistory(jobId: string): Promise<
      Array<{
        action: string;
        actor: string | null;
        actor_type: string;
        changes: Record<string, { old: unknown; new: unknown }>;
        context: Record<string, unknown>;
        created_at: Date;
      }>
    > {
      return db<
        Array<{
          action: string;
          actor: string | null;
          actor_type: string;
          changes: Record<string, { old: unknown; new: unknown }>;
          context: Record<string, unknown>;
          created_at: Date;
        }>
      >`
        SELECT
          action,
          actor,
          actor_type,
          changes,
          context,
          created_at
        FROM audit_log
        WHERE entity_type = 'job'
          AND entity_id = ${jobId}
          AND (
            changes ? 'phase'
            AND (
              changes->'phase'->>'new' IN ('review', 'done', 'active')
              OR changes->'phase'->>'old' IN ('review')
            )
          )
        ORDER BY created_at ASC
      `;
    },

    /**
     * Find a sibling workflow step job by step_name under the same parent.
     * Used for evaluating conditional step execution in workflows.
     *
     * @param parentId - Parent (workflow root) job ID
     * @param stepName - The step_name to search for
     * @returns The sibling job or null if not found
     */
    async findSiblingByStepName(parentId: string, stepName: string): Promise<Job | null> {
      const [row] = await db<Job[]>`
        SELECT * FROM jobs
        WHERE parent_id = ${parentId}
          AND step_name = ${stepName}
          AND NOT (COALESCE(hints, '{}'::jsonb) ? 'workflow_retry_superseded_by')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return row ?? null;
    },
  };
}

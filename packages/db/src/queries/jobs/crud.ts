import type { Db } from '../../client.js';
import type { Job, JobAttemptGitMeta, UpdatePhaseResult } from './types.js';

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
// Job CRUD + Listing
// ============================================================================

export function jobCrudQueries(db: Db) {
  return {
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

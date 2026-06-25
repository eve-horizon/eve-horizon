import type { Db } from '../client.js';

// ============================================================================
// Types
// ============================================================================

export interface TriggerEvaluationEntry {
  type: string;
  name: string;
  matched: boolean;
  reason?: string;
  subscription_id?: string;
  delivery_id?: string;
}

export interface Event {
  id: string;
  project_id: string;
  type: string;
  source: string;
  env_name: string | null;
  ref_sha: string | null;
  ref_branch: string | null;
  actor_type: string | null;
  actor_id: string | null;
  payload_json: Record<string, unknown> | null;
  dedupe_key: string | null;
  job_id: string | null;
  trigger_match_count: number | null;
  triggers_evaluated: TriggerEvaluationEntry[] | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListEventsOptions {
  status?: Event['status'];
  type?: string;
  source?: string;
  attemptId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Factory Function
// ============================================================================

export function eventQueries(db: Db) {
  return {
    /**
     * Create a new event (with deduplication check)
     *
     * If dedupe_key is provided, checks for an existing event with the same
     * project_id and dedupe_key. Returns the existing event if found, otherwise
     * creates and returns a new event.
     *
     * @param event - Event data (without timestamps and status)
     * @returns Created or existing event
     */
    async create(
      event: Omit<Event, 'created_at' | 'updated_at' | 'processed_at' | 'status' | 'job_id' | 'trigger_match_count' | 'triggers_evaluated'>,
    ): Promise<Event> {
      // If dedupe_key provided, check for existing
      if (event.dedupe_key) {
        const existing = await this.findByDedupeKey(
          event.project_id,
          event.dedupe_key,
        );
        if (existing) return existing;
      }

      // Insert new event
      const [row] = await db<Event[]>`
        INSERT INTO events (
          id,
          project_id,
          type,
          source,
          env_name,
          ref_sha,
          ref_branch,
          actor_type,
          actor_id,
          payload_json,
          dedupe_key,
          status
        )
        VALUES (
          ${event.id},
          ${event.project_id},
          ${event.type},
          ${event.source},
          ${event.env_name},
          ${event.ref_sha},
          ${event.ref_branch},
          ${event.actor_type},
          ${event.actor_id},
          ${event.payload_json ? db.json(event.payload_json as never) : null},
          ${event.dedupe_key},
          'pending'
        )
        RETURNING *
      `;
      return row;
    },

    /**
     * Find event by ID
     *
     * @param id - Event ID
     * @returns Event if found, null otherwise
     */
    async findById(id: string): Promise<Event | null> {
      const [row] = await db<Event[]>`
        SELECT * FROM events WHERE id = ${id}
      `;
      return row ?? null;
    },

    /**
     * Find by dedupe key (for deduplication)
     *
     * Used to check if an event with the same dedupe_key already exists
     * for a given project.
     *
     * @param projectId - Project ID
     * @param dedupeKey - Deduplication key
     * @returns Event if found, null otherwise
     */
    async findByDedupeKey(
      projectId: string,
      dedupeKey: string,
    ): Promise<Event | null> {
      const [row] = await db<Event[]>`
        SELECT * FROM events
        WHERE project_id = ${projectId} AND dedupe_key = ${dedupeKey}
      `;
      return row ?? null;
    },

    /**
     * List events for a project (with filters)
     *
     * Returns events matching the specified filters, ordered by creation time
     * descending (newest first).
     *
     * @param projectId - Project ID
     * @param options - Optional filters (status, type, source, limit, offset)
     * @returns Array of events
     */
    async list(
      projectId: string,
      options?: ListEventsOptions,
    ): Promise<Event[]> {
      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;
      const status = options?.status;
      const type = options?.type;
      const source = options?.source;
      const attemptId = options?.attemptId;
      const since = options?.since;

      // Build dynamic WHERE conditions
      const conditions = [db`project_id = ${projectId}`];

      if (status) {
        conditions.push(db`status = ${status}`);
      }

      if (type) {
        // Support comma-separated type values: "runner.completed,runner.failed"
        const types = type.split(',').map(t => t.trim()).filter(Boolean);
        if (types.length === 1) {
          conditions.push(db`type = ${types[0]}`);
        } else {
          conditions.push(db`type = ANY(${types})`);
        }
      }

      if (source) {
        conditions.push(db`source = ${source}`);
      }

      if (attemptId) {
        conditions.push(db`payload_json->>'attemptId' = ${attemptId}`);
      }

      if (since) {
        conditions.push(db`created_at >= ${since}`);
      }

      // Combine conditions with AND
      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<Event[]>`
        SELECT * FROM events
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    },

    /**
     * List events for webhook replay in chronological order.
     *
     * Filters by org (via projects), optional project, time range, and event patterns.
     */
    async listForReplay(options: {
      orgId: string;
      projectId?: string | null;
      fromTime: Date;
      toTime: Date;
      eventPatterns: string[];
      limit: number;
    }): Promise<Event[]> {
      const conditions = [
        db`p.org_id = ${options.orgId}`,
        db`e.created_at >= ${options.fromTime}`,
        db`e.created_at <= ${options.toTime}`,
      ];

      if (options.projectId) {
        conditions.push(db`e.project_id = ${options.projectId}`);
      }

      if (options.eventPatterns.length > 0) {
        conditions.push(db`
          EXISTS (
            SELECT 1 FROM unnest(${options.eventPatterns}::text[]) AS evt
            WHERE e.type LIKE replace(evt, '*', '%')
          )
        `);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<Event[]>`
        SELECT e.*
        FROM events e
        JOIN projects p ON p.id = e.project_id
        WHERE ${whereClause}
        ORDER BY e.created_at ASC
        LIMIT ${options.limit}
      `;
    },

    /**
     * Update trigger evaluation metadata on an event.
     *
     * Called by the event router after evaluating all triggers for an event,
     * recording how many matched and the detailed evaluation results.
     *
     * @param id - Event ID
     * @param metadata - Trigger match count and evaluation details
     */
    async updateTriggerMetadata(
      id: string,
      metadata: {
        trigger_match_count: number;
        triggers_evaluated: TriggerEvaluationEntry[];
      },
    ): Promise<void> {
      await db`
        UPDATE events
        SET
          trigger_match_count = ${metadata.trigger_match_count},
          triggers_evaluated = ${db.json(metadata.triggers_evaluated as never)},
          updated_at = NOW()
        WHERE id = ${id}
      `;
    },

    /**
     * Update event status
     *
     * Updates the status of an event and optionally sets the processed_at timestamp.
     * Always updates updated_at timestamp.
     *
     * @param id - Event ID
     * @param status - New status
     * @param processedAt - Optional processed timestamp (defaults to NOW if status is completed or failed)
     * @returns Updated event or null if not found
     */
    async updateStatus(
      id: string,
      status: Event['status'],
      processedAt?: Date,
    ): Promise<Event | null> {
      // If no processedAt provided but status is terminal, use NOW()
      const shouldSetProcessedAt =
        status === 'completed' || status === 'failed';
      const processedAtValue =
        processedAt ?? (shouldSetProcessedAt ? db`NOW()` : null);

      const [row] = await db<Event[]>`
        UPDATE events
        SET
          status = ${status},
          processed_at = ${processedAtValue},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Link a job to an event.
     *
     * Called by the orchestrator after an event triggers a workflow/pipeline
     * and a job is created. Writes the job_id back to the event so callers
     * can poll the event to discover the resulting job.
     *
     * @param eventId - Event ID
     * @param jobId - Job ID to link
     * @returns Updated event or null if not found
     */
    async linkJobToEvent(
      eventId: string,
      jobId: string,
    ): Promise<Event | null> {
      const [row] = await db<Event[]>`
        UPDATE events
        SET
          job_id = ${jobId},
          updated_at = NOW()
        WHERE id = ${eventId}
        RETURNING *
      `;
      return row ?? null;
    },

    /**
     * Claim pending events for processing (FOR UPDATE SKIP LOCKED pattern)
     *
     * Atomically claims pending events for processing using row-level locking.
     * This ensures multiple workers can claim different events concurrently
     * without conflicts.
     *
     * The SKIP LOCKED clause causes the query to skip over rows that are
     * already locked by other transactions, preventing workers from blocking
     * each other.
     *
     * @param limit - Maximum number of events to claim
     * @returns Array of claimed events (now in 'processing' status)
     */
    async claimPendingEvents(limit: number): Promise<Event[]> {
      // Use FOR UPDATE SKIP LOCKED for concurrent claiming
      const rows = await db<Event[]>`
        UPDATE events
        SET
          status = 'processing',
          updated_at = NOW()
        WHERE id IN (
          SELECT id
          FROM events
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `;
      return rows;
    },

    /**
     * Recover stale events stuck in 'processing' state.
     *
     * Events can get stuck in 'processing' if the orchestrator crashes
     * mid-processing. This resets them to 'pending' so they can be re-claimed.
     *
     * @param staleAfterSeconds - Consider events stale after this many seconds (default: 60)
     * @returns Number of events recovered
     */
    async recoverStaleEvents(staleAfterSeconds = 60): Promise<number> {
      const result = await db`
        UPDATE events
        SET
          status = 'pending',
          updated_at = NOW()
        WHERE status = 'processing'
          AND updated_at < NOW() - INTERVAL '${db.unsafe(String(staleAfterSeconds))} seconds'
      `;
      return result.count;
    },

    /**
     * Delete old completed/failed events (cleanup utility)
     *
     * Removes events that have been processed and are older than the specified
     * retention period. Useful for periodic cleanup to prevent unbounded growth.
     *
     * @param retentionDays - Number of days to retain completed/failed events
     * @returns Number of events deleted
     */
    async deleteOldEvents(retentionDays: number): Promise<number> {
      const result = await db`
        DELETE FROM events
        WHERE status IN ('completed', 'failed')
          AND processed_at < NOW() - INTERVAL '${db.unsafe(String(retentionDays))} days'
      `;
      return result.count;
    },

    /**
     * Get event count by status for a project
     *
     * Returns counts of events grouped by status for monitoring and observability.
     *
     * @param projectId - Project ID
     * @returns Array of status counts
     */
    async countByStatus(
      projectId: string,
    ): Promise<Array<{ status: string; count: number }>> {
      return db<Array<{ status: string; count: number }>>`
        SELECT status, COUNT(*)::int as count
        FROM events
        WHERE project_id = ${projectId}
        GROUP BY status
        ORDER BY status
      `;
    },
  };
}

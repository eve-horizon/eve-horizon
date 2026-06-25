import type { Db } from '../client.js';
import { jobQueries, type Job } from '../queries/jobs.js';
import { externalSyncQueries, type ExternalMapping } from '../queries/external-sync.js';
import type { SyncProvider, ExternalItem, JobCreateParams, JobUpdateParams } from './provider.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncResult {
  /** Number of items processed */
  processed: number;

  /** Number of items created */
  created: number;

  /** Number of items updated */
  updated: number;

  /** Number of items skipped (no changes) */
  skipped: number;

  /** Errors encountered */
  errors: SyncError[];

  /** Individual sync operations */
  operations: SyncOperation[];
}

export interface SyncError {
  /** External or job ID related to the error */
  id: string;

  /** Error message */
  message: string;

  /** Operation that failed */
  operation: 'pull' | 'push' | 'mapping';
}

export interface SyncOperation {
  /** Operation type */
  type: 'create' | 'update' | 'skip';

  /** Direction of sync */
  direction: 'inbound' | 'outbound';

  /** Job ID (if available) */
  jobId?: string;

  /** External ID */
  externalId: string;

  /** Reason for skip (if type is 'skip') */
  skipReason?: string;
}

export interface SyncOptions {
  /** Only sync items updated since this date */
  since?: Date;

  /** Maximum items to process */
  limit?: number;

  /** Dry run - don't make any changes */
  dryRun?: boolean;

  /** Force sync even if content hash matches */
  force?: boolean;
}

// ============================================================================
// Sync Engine
// ============================================================================

/**
 * SyncEngine - Orchestrates bidirectional sync between Jobs and external systems
 *
 * Responsibilities:
 * - Pull: Fetch from external, create/update jobs
 * - Push: Find unmapped jobs, create external items
 * - Handle mapping lifecycle (create, update, error tracking)
 * - Audit log all operations
 */
export class SyncEngine {
  private readonly jobs: ReturnType<typeof jobQueries>;
  private readonly mappings: ReturnType<typeof externalSyncQueries>;

  constructor(
    private readonly db: Db,
    private readonly provider: SyncProvider,
  ) {
    this.jobs = jobQueries(db);
    this.mappings = externalSyncQueries(db);
  }

  // --------------------------------------------------------------------------
  // Pull: External -> Jobs
  // --------------------------------------------------------------------------

  /**
   * Pull items from external system and sync to jobs
   *
   * Process:
   * 1. Fetch items from external provider
   * 2. For each item:
   *    - Check if mapping exists (by external ID)
   *    - If exists: check for drift, update job if needed
   *    - If not exists: create job + mapping
   * 3. Audit log all operations
   *
   * @param projectId - Project TypeID (proj_xxx)
   * @param options - Sync options
   * @returns Sync result summary
   */
  async pullFromExternal(projectId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const result: SyncResult = {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      operations: [],
    };

    // Fetch external items
    const items = await this.provider.fetchItems({
      updatedSince: options.since,
      limit: options.limit,
    });

    // Get project slug for job ID generation
    const projectSlug = await this.getProjectSlug(projectId);

    for (const item of items) {
      result.processed++;

      try {
        // Check for existing mapping
        const existingJobId = await this.mappings.findJobByExternalId(this.provider.name, item.id);

        if (existingJobId) {
          // Update existing job
          const updateResult = await this.handlePullUpdate(existingJobId, item, options);
          result.operations.push(updateResult);

          if (updateResult.type === 'update') {
            result.updated++;
          } else {
            result.skipped++;
          }
        } else {
          // Create new job
          if (options.dryRun) {
            result.operations.push({
              type: 'create',
              direction: 'inbound',
              externalId: item.id,
            });
            result.created++;
          } else {
            const createResult = await this.handlePullCreate(projectId, projectSlug, item);
            result.operations.push(createResult);
            result.created++;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({
          id: item.id,
          message,
          operation: 'pull',
        });
      }
    }

    return result;
  }

  /**
   * Handle creating a new job from external item
   */
  private async handlePullCreate(
    projectId: string,
    projectSlug: string,
    item: ExternalItem,
  ): Promise<SyncOperation> {
    const jobParams = this.provider.toJobParams(item);

    // Generate job ID
    const { id: jobId } = await this.jobs.generateJobId(projectId, jobParams.parent_id);

    // Create job
    const job = await this.jobs.create({
      id: jobId,
      project_id: projectId,
      parent_id: jobParams.parent_id ?? null,
      depth: jobParams.parent_id ? this.countDepth(jobParams.parent_id) : 0,
      title: jobParams.title,
      description: jobParams.description ?? null,
      issue_type: jobParams.issue_type ?? 'task',
      labels: jobParams.labels ?? [],
      phase: jobParams.phase,
      priority: jobParams.priority,
      assignee: jobParams.assignee ?? null,
      review_required: 'none',
      review_status: null,
      reviewer: null,
      defer_until: null,
      due_at: null,
      hints: {},
      harness: null,
      harness_profile: null,
      harness_options: null,
      harness_profile_override: null,
      env_overrides: null,
      token_scope: null,
      token_permissions: null,
      harness_profile_source: null,
      harness_profile_hash: null,
      git_json: null,
      resolved_git_json: null,
      workspace_json: null,
      blocked_on_gates: [],
      env_name: null,
      execution_mode: 'persistent',
      execution_type: 'agent',
      run_id: null,
      step_name: null,
      action_type: null,
      action_input: null,
      script_command: null,
      script_timeout_seconds: null,
      target: null,
      resource_refs: [],
      content_hash: jobParams.content_hash ?? null,
      actor_user_id: 'sync',
      failure_disposition: null,
      closed_at: null,
      close_reason: null,
    });

    // Create mapping
    await this.mappings.upsertMapping({
      job_id: job.id,
      provider: this.provider.name,
      external_id: item.id,
      external_key: item.key,
      external_url: item.url,
      sync_direction: 'inbound',
      content_hash: jobParams.content_hash,
    });

    // Audit log
    await this.auditLog('job', job.id, 'created', 'sync', {
      source: 'external_sync',
      provider: this.provider.name,
      external_id: item.id,
    });

    return {
      type: 'create',
      direction: 'inbound',
      jobId: job.id,
      externalId: item.id,
    };
  }

  /**
   * Handle updating an existing job from external item
   */
  private async handlePullUpdate(
    jobId: string,
    item: ExternalItem,
    options: SyncOptions,
  ): Promise<SyncOperation> {
    // Get current mapping to check content hash
    const mapping = await this.mappings.getMapping(jobId, this.provider.name);
    const updateParams = this.provider.toJobUpdateParams(item);

    // Skip if content hash matches (no drift) unless force sync
    if (
      !options.force &&
      mapping?.content_hash &&
      updateParams.content_hash &&
      mapping.content_hash === updateParams.content_hash
    ) {
      return {
        type: 'skip',
        direction: 'inbound',
        jobId,
        externalId: item.id,
        skipReason: 'no_drift',
      };
    }

    if (options.dryRun) {
      return {
        type: 'update',
        direction: 'inbound',
        jobId,
        externalId: item.id,
      };
    }

    // Update job
    await this.updateJob(jobId, updateParams);

    // Update mapping
    await this.mappings.markSynced(jobId, this.provider.name, updateParams.content_hash);

    // Audit log
    await this.auditLog('job', jobId, 'updated', 'sync', {
      source: 'external_sync',
      provider: this.provider.name,
      external_id: item.id,
      changes: updateParams,
    });

    return {
      type: 'update',
      direction: 'inbound',
      jobId,
      externalId: item.id,
    };
  }

  // --------------------------------------------------------------------------
  // Push: Jobs -> External
  // --------------------------------------------------------------------------

  /**
   * Push jobs to external system
   *
   * Process:
   * 1. Find jobs without external mapping for this provider
   * 2. For each job:
   *    - Convert to external format
   *    - Create on external system
   *    - Create mapping
   * 3. Audit log all operations
   *
   * @param projectId - Project TypeID (proj_xxx)
   * @param options - Sync options
   * @returns Sync result summary
   */
  async pushToExternal(projectId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const result: SyncResult = {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      operations: [],
    };

    // Find unmapped jobs
    const unmappedJobIds = await this.mappings.listUnmappedJobs(projectId, this.provider.name, {
      limit: options.limit,
    });

    for (const jobId of unmappedJobIds) {
      result.processed++;

      try {
        const job = await this.jobs.findById(jobId);
        if (!job) {
          result.skipped++;
          result.operations.push({
            type: 'skip',
            direction: 'outbound',
            externalId: '',
            jobId,
            skipReason: 'job_not_found',
          });
          continue;
        }

        if (options.dryRun) {
          result.operations.push({
            type: 'create',
            direction: 'outbound',
            jobId,
            externalId: '(dry-run)',
          });
          result.created++;
          continue;
        }

        // Create on external system
        const itemParams = this.provider.fromJobParams(job);
        const externalId = await this.provider.createItem(itemParams);

        // Create mapping
        const contentHash = this.provider.computeHash?.({
          id: externalId,
          title: job.title,
          description: job.description ?? undefined,
          status: itemParams.status,
          priority: job.priority,
          labels: job.labels,
        });

        await this.mappings.upsertMapping({
          job_id: jobId,
          provider: this.provider.name,
          external_id: externalId,
          sync_direction: 'outbound',
          content_hash: contentHash,
        });

        // Audit log
        await this.auditLog('job', jobId, 'updated', 'sync', {
          source: 'external_sync',
          provider: this.provider.name,
          external_id: externalId,
          direction: 'outbound',
        });

        result.created++;
        result.operations.push({
          type: 'create',
          direction: 'outbound',
          jobId,
          externalId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({
          id: jobId,
          message,
          operation: 'push',
        });
      }
    }

    return result;
  }

  /**
   * Sync jobs that have mappings but may be out of date
   *
   * @param projectId - Project TypeID
   * @param options - Sync options
   * @returns Sync result
   */
  async syncMappedJobs(projectId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const result: SyncResult = {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      operations: [],
    };

    // Get all mappings for this provider
    const mappings = await this.mappings.listMappingsForProvider(this.provider.name, {
      limit: options.limit,
    });

    for (const mapping of mappings) {
      result.processed++;

      try {
        const job = await this.jobs.findById(mapping.job_id);
        if (!job || job.project_id !== projectId) {
          result.skipped++;
          continue;
        }

        // Fetch current external state
        const externalItem = await this.provider.fetchItem(mapping.external_id);
        if (!externalItem) {
          // External item deleted - mark error
          await this.mappings.recordSyncError(
            mapping.job_id,
            this.provider.name,
            'External item not found',
          );
          result.errors.push({
            id: mapping.external_id,
            message: 'External item not found',
            operation: 'pull',
          });
          continue;
        }

        // Determine sync direction based on mapping
        if (mapping.sync_direction === 'inbound' || mapping.sync_direction === 'bidirectional') {
          const op = await this.handlePullUpdate(mapping.job_id, externalItem, options);
          result.operations.push(op);
          if (op.type === 'update') result.updated++;
          else result.skipped++;
        }

        if (mapping.sync_direction === 'outbound' || mapping.sync_direction === 'bidirectional') {
          // Push job changes to external
          const itemParams = this.provider.fromJobParams(job);
          if (!options.dryRun) {
            await this.provider.updateItem(mapping.external_id, itemParams);
            await this.mappings.markSynced(mapping.job_id, this.provider.name);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({
          id: mapping.job_id,
          message,
          operation: 'mapping',
        });
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Full Sync
  // --------------------------------------------------------------------------

  /**
   * Full bidirectional sync
   *
   * 1. Pull from external (create/update jobs)
   * 2. Push to external (create external items for unmapped jobs)
   * 3. Sync mapped jobs (update both directions based on sync_direction)
   *
   * @param projectId - Project TypeID
   * @param options - Sync options
   * @returns Combined sync result
   */
  async sync(projectId: string, options: SyncOptions = {}): Promise<SyncResult> {
    // Pull first
    const pullResult = await this.pullFromExternal(projectId, options);

    // Then push
    const pushResult = await this.pushToExternal(projectId, options);

    // Combine results
    return {
      processed: pullResult.processed + pushResult.processed,
      created: pullResult.created + pushResult.created,
      updated: pullResult.updated + pushResult.updated,
      skipped: pullResult.skipped + pushResult.skipped,
      errors: [...pullResult.errors, ...pushResult.errors],
      operations: [...pullResult.operations, ...pushResult.operations],
    };
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Get project slug from project ID
   */
  private async getProjectSlug(projectId: string): Promise<string> {
    const [row] = await this.db<{ slug: string }[]>`
      SELECT slug FROM projects WHERE id = ${projectId}
    `;

    if (!row) {
      throw new Error(`Project not found: ${projectId}`);
    }

    return row.slug;
  }

  /**
   * Count hierarchy depth from job ID
   */
  private countDepth(jobId: string): number {
    return jobId.split('.').length;
  }

  /**
   * Update job fields
   */
  private async updateJob(jobId: string, params: JobUpdateParams): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (params.title !== undefined) {
      updates.push('title');
      values.push(params.title);
    }
    if (params.description !== undefined) {
      updates.push('description');
      values.push(params.description);
    }
    if (params.phase !== undefined) {
      updates.push('phase');
      values.push(params.phase);
    }
    if (params.priority !== undefined) {
      updates.push('priority');
      values.push(params.priority);
    }
    if (params.issue_type !== undefined) {
      updates.push('issue_type');
      values.push(params.issue_type);
    }
    if (params.labels !== undefined) {
      updates.push('labels');
      values.push(params.labels);
    }
    if (params.assignee !== undefined) {
      updates.push('assignee');
      values.push(params.assignee);
    }
    if (params.content_hash !== undefined) {
      updates.push('content_hash');
      values.push(params.content_hash);
    }

    if (updates.length === 0) return;

    // Build dynamic update - postgres.js handles this with tagged templates
    await this.db`
      UPDATE jobs
      SET
        title = COALESCE(${params.title ?? null}, title),
        description = COALESCE(${params.description ?? null}, description),
        phase = COALESCE(${params.phase ?? null}, phase),
        priority = COALESCE(${params.priority ?? null}, priority),
        issue_type = COALESCE(${params.issue_type ?? null}, issue_type),
        labels = COALESCE(${params.labels ?? null}, labels),
        assignee = ${params.assignee ?? null},
        content_hash = COALESCE(${params.content_hash ?? null}, content_hash),
        updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }

  /**
   * Write audit log entry
   */
  private async auditLog(
    entityType: string,
    entityId: string,
    action: string,
    actor: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.db`
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
        ${entityType},
        ${entityId},
        ${action},
        ${actor},
        'sync',
        ${this.db.json({} as Record<string, never>)},
        ${this.db.json(context as Record<string, never>)}
      )
    `;
  }
}

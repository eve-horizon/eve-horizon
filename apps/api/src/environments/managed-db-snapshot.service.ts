import { Inject, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  managedDbQueries,
  managedDbSnapshotQueries,
  projectQueries,
  environmentQueries,
  orgQueries,
} from '@eve/db';
import type { ManagedDbSnapshot } from '@eve/db';
import {
  generateManagedDbSnapshotId,
  createSnapshotStorageClient,
  buildSnapshotS3Key,
  executeSnapshot,
  executeRestore,
  terminateConnections,
  resolveManagedDbSnapshotRetention,
  normalizeManagedDbSnapshotRetention,
  snapshotRetentionToExpiresAt,
} from '@eve/shared';
import { EventsService } from '../events/events.service.js';

@Injectable()
export class ManagedDbSnapshotService {
  private readonly logger = new Logger(ManagedDbSnapshotService.name);

  private snapshots: ReturnType<typeof managedDbSnapshotQueries>;
  private managedDb: ReturnType<typeof managedDbQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly eventsService: EventsService,
  ) {
    this.snapshots = managedDbSnapshotQueries(db);
    this.managedDb = managedDbQueries(db);
    this.projects = projectQueries(db);
    this.environments = environmentQueries(db);
    this.orgs = orgQueries(db);
  }

  // -----------------------------------------------------------------------
  // Snapshot operations
  // -----------------------------------------------------------------------

  async createSnapshot(
    projectId: string,
    envName: string,
    opts?: { retention?: string; createdBy?: string },
  ) {
    const { tenant, org, project, env } = await this.requireTenant(projectId, envName);
    if (tenant.status !== 'ready') {
      throw new BadRequestException(`Cannot snapshot: managed DB is in "${tenant.status}" state`);
    }

    const retention = this.resolveSnapshotRetention(tenant, {
      requestedRetention: opts?.retention,
      strictInput: true,
    });
    const snapshotId = generateManagedDbSnapshotId();

    const snapshot = await this.createAndRunSnapshot({
      tenant,
      org,
      project,
      env,
      dbConfig: this.parseConnectionUrl(tenant.credential_secret_ref!),
      trigger: 'manual',
      createdBy: opts?.createdBy ?? null,
      snapshotId,
      retention,
      keyContext: {
        orgSlug: org.slug,
        projectSlug: project.slug,
        envName,
      },
      projectId,
      envName,
      awaitCompletion: false,
    });

    return this.formatSnapshot(snapshot);
  }

  async listSnapshots(
    projectId: string,
    envName: string,
    opts?: { status?: string; limit?: number },
  ) {
    const env = await this.requireEnv(projectId, envName);
    const rows = await this.snapshots.listSnapshotsByEnv(env.id, opts);
    return rows.map((s) => this.formatSnapshot(s));
  }

  async getSnapshot(projectId: string, envName: string, snapshotId: string) {
    const env = await this.requireEnv(projectId, envName);
    const snapshot = await this.snapshots.findSnapshotById(snapshotId);
    if (!snapshot || snapshot.env_id !== env.id) {
      throw new NotFoundException(`Snapshot ${snapshotId} not found`);
    }
    return this.formatSnapshot(snapshot);
  }

  async deleteSnapshot(projectId: string, envName: string, snapshotId: string) {
    const env = await this.requireEnv(projectId, envName);
    const snapshot = await this.snapshots.findSnapshotById(snapshotId);
    if (!snapshot || snapshot.env_id !== env.id) {
      throw new NotFoundException(`Snapshot ${snapshotId} not found`);
    }

    // Delete storage object if present
    if (snapshot.s3_bucket && snapshot.s3_key) {
      try {
        const storage = createSnapshotStorageClient();
        if (storage) {
          await storage.client.deleteObject(snapshot.s3_bucket, snapshot.s3_key);
        }
      } catch (err) {
        this.logger.warn(`Failed to delete storage object for snapshot ${snapshotId}: ${err}`);
      }
    }

    await this.snapshots.deleteSnapshot(snapshotId);
    return { message: 'Snapshot deleted', snapshot_id: snapshotId };
  }

  async getDownloadUrl(projectId: string, envName: string, snapshotId: string) {
    const env = await this.requireEnv(projectId, envName);
    const snapshot = await this.snapshots.findSnapshotById(snapshotId);
    if (!snapshot || snapshot.env_id !== env.id) {
      throw new NotFoundException(`Snapshot ${snapshotId} not found`);
    }
    if (snapshot.status !== 'completed') {
      throw new BadRequestException(`Snapshot is in "${snapshot.status}" state, not downloadable`);
    }
    if (!snapshot.s3_bucket || !snapshot.s3_key) {
      throw new BadRequestException('Snapshot has no S3 storage reference');
    }

    const storage = createSnapshotStorageClient();
    if (!storage) throw new BadRequestException('Storage is not configured');
    const url = await storage.client.getPresignedDownloadUrl(
      snapshot.s3_bucket,
      snapshot.s3_key,
      3600,
    );

    return { url, snapshot_id: snapshotId, size_bytes: snapshot.size_bytes };
  }

  async restoreFromSnapshot(
    projectId: string,
    envName: string,
    body: {
      snapshot_id: string;
      source_env?: string;
      source_project?: string;
      skip_safety_snapshot?: boolean;
    },
  ) {
    const target = await this.requireTenant(projectId, envName);
    const tenant = target.tenant;
    if (tenant.status !== 'ready') {
      throw new BadRequestException(`Cannot restore: managed DB is in "${tenant.status}" state`);
    }

    const source = await this.resolveSourceRestoreTarget(
      projectId,
      envName,
      target,
      body,
    );

    await this.assertSnapshotCompatibility(tenant, source.tenant);

    // Find the source snapshot
    const snapshot = await this.snapshots.findSnapshotById(body.snapshot_id);
    if (!snapshot || snapshot.env_id !== source.env.id || snapshot.tenant_id !== source.tenant.id) {
      throw new NotFoundException(`Snapshot ${body.snapshot_id} not found`);
    }
    if (snapshot.status !== 'completed') {
      throw new BadRequestException(`Cannot restore from snapshot in "${snapshot.status}" state`);
    }
    if (!snapshot.s3_bucket || !snapshot.s3_key) {
      throw new BadRequestException('Snapshot has no S3 storage reference');
    }

    const dbConfig = this.parseConnectionUrl(tenant.credential_secret_ref!);
    const storage = createSnapshotStorageClient();
    if (!storage) throw new BadRequestException('Storage is not configured');
    const restoreStart = Date.now();

    await this.emitEvent(projectId, 'system.db.restore.started', envName, {
      tenant_id: tenant.id, snapshot_id: body.snapshot_id,
    });

    try {
      // Optionally create a safety snapshot first
      if (!body.skip_safety_snapshot) {
        this.logger.log(`Creating safety snapshot before restore on ${tenant.id}`);
        const safetyRetention = this.resolveSnapshotRetention(tenant, {
          requestedRetention: undefined,
          strictInput: false,
        });
        await this.createAndRunSnapshot({
          tenant,
          org: target.org,
          project: target.project,
          env: target.env,
          dbConfig: this.parseConnectionUrl(tenant.credential_secret_ref!),
          trigger: 'pre_reset',
          createdBy: 'system:pre-restore',
          snapshotId: generateManagedDbSnapshotId(),
          retention: safetyRetention,
          keyContext: {
            orgSlug: target.org.slug,
            projectSlug: target.project.slug,
            envName,
          },
          projectId,
          envName,
          awaitCompletion: true,
        });
      }

      // Terminate active connections before restore
      await terminateConnections(dbConfig, dbConfig.database);

      // Execute pg_restore
      await executeRestore(dbConfig, {
        client: storage.client,
        bucket: snapshot.s3_bucket,
        key: snapshot.s3_key,
      });

      this.logger.log(`Restore of snapshot ${body.snapshot_id} to ${tenant.id} completed`);
      await this.emitEvent(projectId, 'system.db.restore.completed', envName, {
        tenant_id: tenant.id, snapshot_id: body.snapshot_id,
        duration_ms: Date.now() - restoreStart,
      });
      return { message: 'Restore completed', snapshot_id: body.snapshot_id, tenant_id: tenant.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emitEvent(projectId, 'system.db.restore.failed', envName, {
        tenant_id: tenant.id, snapshot_id: body.snapshot_id, error: message,
      });
      throw err;
    }
  }

  async getBackupStatus(projectId: string, envName: string) {
    const { tenant } = await this.requireTenant(projectId, envName);
    const allSnapshots = await this.snapshots.listSnapshotsByTenant(tenant.id, { limit: 1000 });
    const completed = allSnapshots.filter((s) => s.status === 'completed');
    const failed = allSnapshots.filter((s) => s.status === 'failed');
    const inProgress = allSnapshots.filter((s) => s.status === 'in_progress');
    const lastSnapshot = completed[0] ?? null;
    const totalSizeBytes = completed.reduce((sum, s) => sum + (s.size_bytes ?? 0), 0);

    // Note: next_snapshot_at is not computed here to avoid pulling cron-parser
    // into the API. The scheduler in the orchestrator evaluates cron expressions.

    return {
      tenant_id: tenant.id,
      class: tenant.class,
      schedule: tenant.backup_schedule ?? null,
      retention: this.resolveSnapshotRetention(tenant, {
        strictInput: false,
      }),
      snapshot_on_delete: this.resolveTenantSnapshotSetting(tenant.snapshot_on_delete, tenant.class),
      snapshot_on_reset: this.resolveTenantSnapshotSetting(tenant.snapshot_on_reset, tenant.class),
      last_snapshot_at: tenant.last_snapshot_at?.toISOString() ?? null,
      next_snapshot_at: null,
      last_snapshot: lastSnapshot ? this.formatSnapshot(lastSnapshot) : null,
      total_size_bytes: totalSizeBytes,
      snapshot_count: allSnapshots.length,
      counts: {
        completed: completed.length,
        failed: failed.length,
        in_progress: inProgress.length,
        total: allSnapshots.length,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async requireTenant(projectId: string, envName: string) {
    const env = await this.requireEnv(projectId, envName);
    const project = await this.projects.findById(projectId);
    if (!project?.org_id) {
      throw new NotFoundException(`Project "${projectId}" not found`);
    }
    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new NotFoundException(`Org not found for project "${projectId}"`);
    }

    // Find managed DB tenant for this env
    const tenants = await this.managedDb.listTenantsByOrg(org.id);
    const tenant = tenants.find((t) => t.env_id === env.id);
    if (!tenant) {
      throw new NotFoundException(`No managed DB found for environment "${envName}"`);
    }
    if (!tenant.credential_secret_ref) {
      throw new BadRequestException('Managed DB has no credentials configured');
    }

    return { tenant, org, project, env };
  }

  private async requireEnv(projectId: string, envName: string) {
    const env = await this.environments.findByProjectAndName(projectId, envName);
    if (!env) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }
    return env;
  }

  private async resolveSourceRestoreTarget(
    targetProjectId: string,
    targetEnvName: string,
    target: {
      tenant: { id: string; class: string; credential_secret_ref: string | null; instance_id: string };
      org: { id: string };
      project: { id: string };
      env: { id: string };
    },
    body: {
      snapshot_id: string;
      source_env?: string;
      source_project?: string;
      skip_safety_snapshot?: boolean;
    },
  ) {
    if (!body.source_env && !body.source_project) {
      return target;
    }

    const sourceProjectId = body.source_project ?? targetProjectId;
    const sourceEnvName = body.source_env ?? targetEnvName;
    const source = await this.requireTenant(sourceProjectId, sourceEnvName);

    if (source.org.id !== target.org.id) {
      throw new BadRequestException('Cross-organization restore from source snapshot is not supported');
    }

    return source;
  }

  private async assertSnapshotCompatibility(
    targetTenant: { class: string; instance_id: string },
    sourceTenant: { class: string; instance_id: string },
  ): Promise<void> {
    if (targetTenant.class !== sourceTenant.class) {
      throw new BadRequestException(
        `Cannot restore ${targetTenant.class} tenant from ${sourceTenant.class} snapshot source class`,
      );
    }

    const [targetInstance, sourceInstance] = await Promise.all([
      this.managedDb.findInstanceById(targetTenant.instance_id),
      this.managedDb.findInstanceById(sourceTenant.instance_id),
    ]);

    if (!targetInstance || !sourceInstance) {
      throw new BadRequestException('Cannot validate restore compatibility: source or target instance not found');
    }

    const targetMajor = this.parsePgMajorVersion(targetInstance.engine_version);
    const sourceMajor = this.parsePgMajorVersion(sourceInstance.engine_version);

    if (targetMajor && sourceMajor && targetMajor !== sourceMajor) {
      throw new BadRequestException(
        `Cannot restore PostgreSQL ${sourceMajor} snapshot into PostgreSQL ${targetMajor}`,
      );
    }
  }

  private parsePgMajorVersion(engineVersion: string): string | null {
    const match = String(engineVersion ?? '').trim().match(/^(\d+)/);
    return match ? match[1] : null;
  }

  private resolveSnapshotRetention(
    tenant: { class: string; backup_retention: string | null },
    opts: { requestedRetention?: string; strictInput: boolean },
  ): string {
    const requested = opts.requestedRetention?.trim();

    if (opts.strictInput && requested) {
      const normalizedRequested = normalizeManagedDbSnapshotRetention(requested);
      if (!normalizedRequested) {
        throw new BadRequestException('Invalid retention format. Use a value like "30d"');
      }

      return resolveManagedDbSnapshotRetention(normalizedRequested, {
        dbClass: tenant.class,
        tenantRetention: tenant.backup_retention,
      });
    }

    return resolveManagedDbSnapshotRetention(requested, {
      dbClass: tenant.class,
      tenantRetention: tenant.backup_retention,
    });
  }

  private resolveTenantSnapshotSetting(
    configured: boolean | null,
    dbClass: string,
  ): boolean {
    if (configured !== null) {
      return configured;
    }
    return dbClass === 'db.p2' || dbClass === 'db.p3';
  }

  private async createAndRunSnapshot(options: {
    tenant: { id: string; class: string; instance_id: string };
    org: { id: string; slug: string };
    project: { id: string; slug: string };
    env: { id: string };
    dbConfig: { host: string; port: number; username: string; password: string; database: string };
    trigger: 'manual' | 'scheduled' | 'pre_delete' | 'pre_reset';
    createdBy?: string | null;
    snapshotId: string;
    retention: string;
    keyContext: { orgSlug: string; projectSlug: string; envName: string };
    projectId: string;
    envName: string;
    awaitCompletion: boolean;
  }): Promise<ManagedDbSnapshot> {
    const instance = await this.managedDb.findInstanceById(options.tenant.instance_id);
    if (!instance) {
      throw new NotFoundException(`Backing instance ${options.tenant.instance_id} not found`);
    }

    const concurrent = await this.snapshots.countInProgressByTenant(options.tenant.id);
    if (concurrent > 0) {
      throw new BadRequestException('Another snapshot is already in progress for this database');
    }

    const snapshotStorage = createSnapshotStorageClient();
    if (!snapshotStorage) throw new BadRequestException('Storage is not configured');
    const s3Key = buildSnapshotS3Key(
      options.keyContext.orgSlug,
      options.keyContext.projectSlug,
      options.keyContext.envName,
      options.snapshotId,
    );

    const snapshot = await this.snapshots.createSnapshot({
      id: options.snapshotId,
      tenant_id: options.tenant.id,
      org_id: options.org.id,
      project_id: options.project.id,
      env_id: options.env.id,
      instance_id: instance.id,
      created_by: options.createdBy ?? null,
      trigger: options.trigger,
      s3_bucket: snapshotStorage.bucket,
      s3_key: s3Key,
      retention: options.retention,
      expires_at: snapshotRetentionToExpiresAt(options.retention),
    });

    const startTime = Date.now();
    await this.emitEvent(options.projectId, 'system.db.snapshot.started', options.envName, {
      tenant_id: options.tenant.id, snapshot_id: snapshot.id, trigger: options.trigger,
    });

    const job = (async () => {
      const result = await executeSnapshot(options.dbConfig, { client: snapshotStorage.client, bucket: snapshotStorage.bucket, key: s3Key });
      await this.snapshots.completeSnapshot(snapshot.id, {
        size_bytes: result.sizeBytes,
        db_size_bytes: result.dbSizeBytes,
        pg_version: result.pgVersion,
      });
      this.logger.log(`Snapshot ${snapshot.id} completed (${result.sizeBytes} bytes)`);
      await this.emitEvent(options.projectId, 'system.db.snapshot.completed', options.envName, {
        tenant_id: options.tenant.id,
        snapshot_id: snapshot.id,
        trigger: options.trigger,
        size_bytes: result.sizeBytes,
        duration_ms: Date.now() - startTime,
      });
    })().catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      await this.snapshots.failSnapshot(snapshot.id, message);
      this.logger.error(`Snapshot ${snapshot.id} failed: ${message}`);
      await this.emitEvent(options.projectId, 'system.db.snapshot.failed', options.envName, {
        tenant_id: options.tenant.id,
        snapshot_id: snapshot.id,
        error: message,
      });
      throw err;
    });

    if (options.awaitCompletion) {
      await job;
    } else {
      job.catch(() => {
        // background job - failures are persisted and emitted
      });
    }

    return snapshot;
  }

  private formatSnapshot(snapshot: ManagedDbSnapshot) {
    return {
      id: snapshot.id,
      tenant_id: snapshot.tenant_id,
      org_id: snapshot.org_id,
      project_id: snapshot.project_id,
      env_id: snapshot.env_id,
      instance_id: snapshot.instance_id,
      created_by: snapshot.created_by,
      trigger: snapshot.trigger,
      status: snapshot.status,
      s3_bucket: snapshot.s3_bucket,
      s3_key: snapshot.s3_key,
      size_bytes: snapshot.size_bytes,
      db_size_bytes: snapshot.db_size_bytes,
      pg_version: snapshot.pg_version,
      error_message: snapshot.error_message,
      retention: snapshot.retention,
      expires_at: snapshot.expires_at?.toISOString() ?? null,
      created_at: snapshot.created_at.toISOString(),
      completed_at: snapshot.completed_at?.toISOString() ?? null,
    };
  }

  private async emitEvent(
    projectId: string,
    type: string,
    envName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.eventsService.create(projectId, {
        type,
        source: 'system',
        env_name: envName,
        payload_json: payload,
      });
    } catch (err) {
      this.logger.warn(`Failed to emit event ${type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private parseConnectionUrl(ref: string): {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  } {
    const url = new URL(ref);
    return {
      host: url.hostname,
      port: parseInt(url.port, 10) || 5432,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
    };
  }
}

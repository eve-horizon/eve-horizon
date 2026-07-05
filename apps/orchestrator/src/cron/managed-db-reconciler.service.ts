import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { managedDbQueries, managedDbSnapshotQueries, createDb, type Db, orgQueries, projectQueries, environmentQueries } from '@eve/db';
import {
  generateManagedDbInstanceId,
  generateManagedDbSnapshotId,
  createSnapshotStorageClient,
  executeSnapshot,
  resolveManagedDbSnapshotRetention,
  snapshotRetentionToExpiresAt,
  buildSnapshotS3Key,
  getSupportedExtensionDefinition,
  isSupportedExtensionName,
  isManagedDbExtensionEnabled,
  MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS_ENV,
  normalizeManagedDbExtensions,
  quotePostgresIdentifier,
  sharedPreloadLibrariesContains,
  type SupportedExtension,
} from '@eve/shared';
import * as crypto from 'crypto';

class ManagedDbProvisioningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Managed DB Reconciler
 *
 * Periodically scans managed_db_tenants for tenants in transitional states
 * (provisioning, modifying, rotating, deleting) and drives them forward
 * via the provider contract.
 *
 * For local provider: runs CREATE DATABASE / CREATE ROLE on the system Postgres.
 * For cloud providers: will call the provider API (future).
 *
 * Disabled by default; enable with EVE_MANAGED_DB_RECONCILER_ENABLED=true.
 */
@Injectable()
export class ManagedDbReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedDbReconcilerService.name);
  private cronJob: CronJob | null = null;
  private reconciling = false;

  private readonly managedDb: ReturnType<typeof managedDbQueries>;
  private readonly snapshots: ReturnType<typeof managedDbSnapshotQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly environments: ReturnType<typeof environmentQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.managedDb = managedDbQueries(db);
    this.snapshots = managedDbSnapshotQueries(db);
    this.orgs = orgQueries(db);
    this.projects = projectQueries(db);
    this.environments = environmentQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_MANAGED_DB_RECONCILER_ENABLED !== 'true') {
      this.logger.log('[managed-db-reconciler] Disabled (set EVE_MANAGED_DB_RECONCILER_ENABLED=true to enable)');
      return;
    }

    // Seed local instance if requested
    if (process.env.EVE_MANAGED_DB_LOCAL_SEED === 'true') {
      await this.seedLocalInstance();
    }

    const cron = process.env.EVE_MANAGED_DB_RECONCILER_CRON ?? '*/30 * * * * *';

    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.reconcile().catch((err) => {
            this.logger.error(`[managed-db-reconciler] Reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        null,
        true,
        'UTC',
      );
      this.logger.log(`[managed-db-reconciler] Enabled (cron="${cron}")`);
    } catch (err) {
      this.logger.error(`[managed-db-reconciler] Failed to start cron: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cronJob) {
      try { this.cronJob.stop(); } catch { /* ignore */ }
      this.cronJob = null;
    }
  }

  /**
   * Main reconciliation loop. Finds tenants needing work and processes them.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return; // Prevent overlap
    this.reconciling = true;

    try {
      // Release locks held longer than 10 minutes (crash recovery)
      const stale = await this.managedDb.forceReleaseStaleOperationLocks(10);
      if (stale.length > 0) {
        this.logger.warn(`[managed-db-reconciler] Released ${stale.length} stale lock(s): ${stale.map(s => s.id).join(', ')}`);
      }

      const tenants = await this.managedDb.listTenantsNeedingReconciliation();
      if (tenants.length > 0) {
        this.logger.log(`[managed-db-reconciler] Processing ${tenants.length} tenant(s)`);

        for (const tenant of tenants) {
          try {
            await this.reconcileTenant(tenant);
          } catch (err) {
            this.logger.error(`[managed-db-reconciler] Failed to reconcile tenant ${tenant.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Orphan reconciliation
      await this.reconcileOrphans();
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Find and clean up orphaned tenants whose environment has been deleted.
   * Called at the end of each reconciliation cycle.
   */
  private async reconcileOrphans(): Promise<void> {
    const orphans = await this.managedDb.findOrphanedTenants();
    if (orphans.length === 0) return;

    this.logger.log(`[managed-db-reconciler] Found ${orphans.length} orphaned tenant(s)`);

    for (const orphan of orphans) {
      try {
        if (orphan.status !== 'deleting') {
          await this.managedDb.softDeleteTenant(orphan.id);
          this.logger.log(`[managed-db-reconciler] Marked orphan ${orphan.id} for deletion`);
        }
      } catch (err) {
        this.logger.error(`[managed-db-reconciler] Failed to clean up orphan ${orphan.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async reconcileTenant(tenant: {
    id: string;
    status: string;
    instance_id: string;
    db_name: string;
    db_user: string;
    class: string;
    desired_class: string | null;
    provider_tenant_id: string | null;
    credential_secret_ref: string | null;
    snapshot_on_delete: boolean | null;
    org_id: string;
    project_id: string;
    env_id: string;
    backup_retention: string | null;
    desired_extensions: string[];
    enabled_extensions: string[];
  }): Promise<void> {
    const token = crypto.randomUUID();
    const locked = await this.managedDb.acquireOperationLock(tenant.id, token);
    if (!locked) {
      this.logger.log(`[managed-db-reconciler] Tenant ${tenant.id} locked by another operation, skipping`);
      return;
    }

    try {
      switch (tenant.status) {
        case 'provisioning':
          await this.handleProvisioning(tenant, token);
          break;
        case 'modifying':
          await this.handleModifying(tenant, token);
          break;
        case 'rotating':
          await this.handleRotating(tenant, token);
          break;
        case 'deleting':
          await this.handleDeleting(tenant, token);
          break;
        default:
          // Release lock for unknown states
          await this.managedDb.releaseOperationLock(tenant.id, token);
      }
    } catch (err) {
      const error = err instanceof ManagedDbProvisioningError
        ? { code: err.code, message: err.message }
        : {
            code: 'reconcile_error',
            message: err instanceof Error ? err.message : String(err),
          };
      // On failure, transition to failed state and release lock
      await this.managedDb.transitionStatus(tenant.id, token, 'failed', {
        error,
      });
    }
  }

  private async handleProvisioning(
    tenant: {
      id: string;
      instance_id: string;
      db_name: string;
      db_user: string;
      class: string;
      desired_extensions: string[];
      enabled_extensions: string[];
    },
    token: string,
  ): Promise<void> {
    const instance = await this.managedDb.findInstanceById(tenant.instance_id);
    if (!instance) {
      await this.managedDb.transitionStatus(tenant.id, token, 'failed', {
        error: { code: 'instance_not_found', message: `Instance ${tenant.instance_id} not found` },
      });
      return;
    }

    this.logger.log(
      `[managed-db-reconciler] Provisioning tenant ${tenant.id} on instance ${instance.id} ` +
      `(${instance.provider}/${instance.provider_instance_id})`,
    );

    const desiredExtensions = normalizeManagedDbExtensions(tenant.desired_extensions, {
      includeDisabledProviderGated: true,
    });
    if (instance.provider === 'local') {
      const connectionUrl = await this.provisionLocalDb(instance, tenant);
      if (desiredExtensions.length > 0) {
        await this.installTenantExtensions(instance, tenant, desiredExtensions);
        await this.managedDb.markTenantExtensionsEnabled(
          tenant.id,
          token,
          this.mergeEnabledExtensions(tenant.enabled_extensions, desiredExtensions),
        );
      }
      await this.managedDb.transitionStatus(tenant.id, token, 'ready', {
        providerTenantId: `local:${tenant.db_name}`,
        credentialSecretRef: connectionUrl,
        setReady: true,
      });
      this.logger.log(`[managed-db-reconciler] Tenant ${tenant.id} provisioned (local: ${tenant.db_name})`);
    } else {
      if (desiredExtensions.length > 0) {
        throw new ManagedDbProvisioningError(
          'provider_unsupported',
          `Managed DB extension provisioning is not implemented for provider "${instance.provider}"`,
        );
      }
      // Cloud providers — stub for future implementation
      await this.managedDb.transitionStatus(tenant.id, token, 'ready', {
        providerTenantId: `${instance.provider}:${tenant.db_name}`,
        setReady: true,
      });
      this.logger.log(`[managed-db-reconciler] Tenant ${tenant.id} provisioned (stub: ${instance.provider})`);
    }
  }

  private async handleModifying(
    tenant: {
      id: string;
      instance_id: string;
      db_name: string;
      db_user: string;
      desired_class: string | null;
      desired_extensions: string[];
      enabled_extensions: string[];
    },
    token: string,
  ): Promise<void> {
    const missingExtensions = this.getMissingExtensions(tenant.desired_extensions, tenant.enabled_extensions);
    if (missingExtensions.length > 0) {
      const instance = await this.managedDb.findInstanceById(tenant.instance_id);
      if (!instance) {
        throw new ManagedDbProvisioningError('instance_not_found', `Instance ${tenant.instance_id} not found`);
      }
      if (instance.provider !== 'local') {
        throw new ManagedDbProvisioningError(
          'provider_unsupported',
          `Managed DB extension provisioning is not implemented for provider "${instance.provider}"`,
        );
      }

      this.logger.log(
        `[managed-db-reconciler] Installing extension(s) for tenant ${tenant.id}: ` +
        missingExtensions.join(', '),
      );
      await this.installTenantExtensions(instance, tenant, missingExtensions);
      await this.managedDb.markTenantExtensionsEnabled(
        tenant.id,
        token,
        this.mergeEnabledExtensions(tenant.enabled_extensions, missingExtensions),
      );
    }

    if (tenant.desired_class) {
      this.logger.log(`[managed-db-reconciler] Scaling tenant ${tenant.id} to ${tenant.desired_class}`);
    }
    await this.managedDb.transitionStatus(tenant.id, token, 'ready', {
      desiredClass: null,
    });
  }

  private async handleRotating(
    tenant: { id: string; instance_id: string; db_name: string; db_user: string; provider_tenant_id: string | null },
    token: string,
  ): Promise<void> {
    this.logger.log(`[managed-db-reconciler] Rotating credentials for tenant ${tenant.id}`);

    if (tenant.provider_tenant_id?.startsWith('local:')) {
      const instance = await this.managedDb.findInstanceById(tenant.instance_id);
      if (instance) {
        const newPassword = crypto.randomBytes(16).toString('hex');
        const adminSql = this.connectToInstance(instance);
        try {
          await adminSql.unsafe(`ALTER ROLE "${tenant.db_user}" WITH PASSWORD '${newPassword}'`);
          const connectionUrl = this.buildTenantConnectionUrl(instance, tenant, newPassword);
          await this.managedDb.transitionStatus(tenant.id, token, 'ready', {
            credentialSecretRef: connectionUrl,
          });
          this.logger.log(`[managed-db-reconciler] Rotated credentials for local tenant ${tenant.id}`);
          return;
        } finally {
          await adminSql.end();
        }
      }
    }

    await this.managedDb.transitionStatus(tenant.id, token, 'ready');
  }

  private async handleDeleting(
    tenant: {
      id: string;
      instance_id: string;
      db_name: string;
      db_user: string;
      provider_tenant_id: string | null;
      credential_secret_ref: string | null;
      snapshot_on_delete: boolean | null;
      org_id: string;
      project_id: string;
      env_id: string;
      class: string;
      backup_retention: string | null;
    },
    token: string,
  ): Promise<void> {
    this.logger.log(`[managed-db-reconciler] Deleting tenant ${tenant.id}`);

    // Snapshot-on-delete: create a safety snapshot before destroying
    if (this.resolveTenantSnapshotSetting(tenant.snapshot_on_delete, tenant.class) && tenant.credential_secret_ref) {
      try {
        this.logger.log(`[managed-db-reconciler] Creating pre-delete snapshot for ${tenant.id}`);
        const [org, project, environment] = await Promise.all([
          this.orgs.findById(tenant.org_id),
          this.projects.findById(tenant.project_id),
          this.environments.findById(tenant.env_id),
        ]);

        await this.createPreDeleteSnapshot({
          ...tenant,
          credential_secret_ref: tenant.credential_secret_ref,
          org_slug: org?.slug ?? tenant.org_id,
          project_slug: project?.slug ?? tenant.project_id,
          env_name: environment?.name ?? tenant.env_id,
        });
      } catch (err) {
        // Best-effort: log warning but don't block teardown
        this.logger.warn(`[managed-db-reconciler] Pre-delete snapshot failed for ${tenant.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (tenant.provider_tenant_id?.startsWith('local:')) {
      const instance = await this.managedDb.findInstanceById(tenant.instance_id);
      if (instance) {
        await this.deleteLocalDb(instance, tenant);
      }
    }

    await this.managedDb.markTenantDeleted(tenant.id);
    this.logger.log(`[managed-db-reconciler] Tenant ${tenant.id} deleted`);
  }

  private async createPreDeleteSnapshot(tenant: {
    id: string;
    instance_id: string;
    org_id: string;
    project_id: string;
    env_id: string;
    class: string;
    backup_retention: string | null;
    org_slug: string;
    project_slug: string;
    env_name: string;
    credential_secret_ref: string;
  }): Promise<void> {
    const snapshotStorage = createSnapshotStorageClient();
    if (!snapshotStorage) {
      this.logger.warn('[managed-db-reconciler] Storage not configured, skipping pre-delete snapshot');
      return;
    }
    const snapshotId = generateManagedDbSnapshotId();
    const retention = resolveManagedDbSnapshotRetention(undefined, {
      dbClass: tenant.class,
      tenantRetention: tenant.backup_retention,
    });
    const s3Key = buildSnapshotS3Key(
      tenant.org_slug,
      tenant.project_slug,
      tenant.env_name,
      snapshotId,
    );

    await this.snapshots.createSnapshot({
      id: snapshotId,
      tenant_id: tenant.id,
      org_id: tenant.org_id,
      project_id: tenant.project_id,
      env_id: tenant.env_id,
      instance_id: tenant.instance_id,
      created_by: 'system:pre-delete',
      trigger: 'pre_delete',
      s3_bucket: snapshotStorage.bucket,
      s3_key: s3Key,
      retention,
      expires_at: snapshotRetentionToExpiresAt(retention),
    });

    // Parse connection URL
    const url = new URL(tenant.credential_secret_ref);
    const dbConfig = {
      host: url.hostname,
      port: parseInt(url.port, 10) || 5432,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
    };

    // Execute synchronously (block deletion until snapshot completes, with 5 min timeout)
    try {
      const result = await executeSnapshot(dbConfig, { client: snapshotStorage.client, bucket: snapshotStorage.bucket, key: s3Key }, { timeoutMs: 5 * 60 * 1000 });
      await this.snapshots.completeSnapshot(snapshotId, {
        size_bytes: result.sizeBytes,
        db_size_bytes: result.dbSizeBytes,
        pg_version: result.pgVersion,
      });
      this.logger.log(`[managed-db-reconciler] Pre-delete snapshot ${snapshotId} completed (${result.sizeBytes} bytes)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.snapshots.failSnapshot(snapshotId, message);
      throw err; // Re-throw so caller can handle
    }
  }

  private resolveTenantSnapshotSetting(configured: boolean | null, dbClass: string): boolean {
    if (configured !== null) {
      return configured;
    }
    return dbClass === 'db.p2' || dbClass === 'db.p3';
  }

  // ---------------------------------------------------------------------------
  // Local Postgres provider
  // ---------------------------------------------------------------------------

  /**
   * Connect to the system Postgres as admin (using DATABASE_URL).
   * Returns a short-lived sql connection for admin DDL operations.
   */
  private connectToInstance(instance: { host: string; port: number }): Db {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set — cannot connect for local managed DB provisioning');
    }
    // Parse admin credentials from DATABASE_URL, override host/port from instance.
    // sslmode is inherited from DATABASE_URL — both connect to the same Postgres.
    const url = new URL(databaseUrl);
    url.hostname = instance.host;
    url.port = String(instance.port);
    url.pathname = '/postgres';
    return createDb(url.toString());
  }

  private connectToTenantDb(
    instance: { host: string; port: number },
    tenant: { db_name: string },
  ): Db {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set — cannot connect for managed DB extension provisioning');
    }
    const url = new URL(databaseUrl);
    url.hostname = instance.host;
    url.port = String(instance.port);
    url.pathname = `/${tenant.db_name}`;
    return createDb(url.toString());
  }

  private getMissingExtensions(
    desiredExtensions: string[] | null | undefined,
    enabledExtensions: string[] | null | undefined,
  ): SupportedExtension[] {
    const desired = normalizeManagedDbExtensions(desiredExtensions, {
      includeDisabledProviderGated: true,
    });
    const enabled = new Set(enabledExtensions ?? []);
    return desired.filter((extension) => !enabled.has(extension));
  }

  private mergeEnabledExtensions(
    currentExtensions: string[] | null | undefined,
    installedExtensions: SupportedExtension[],
  ): SupportedExtension[] {
    const current = (currentExtensions ?? []).filter(isSupportedExtensionName);
    return normalizeManagedDbExtensions([...current, ...installedExtensions], {
      includeDisabledProviderGated: true,
    });
  }

  private async installTenantExtensions(
    instance: {
      id: string;
      provider: string;
      provider_instance_id: string;
      engine_version: string;
      host: string;
      port: number;
    },
    tenant: { id: string; db_name: string; db_user: string },
    requestedExtensions: SupportedExtension[],
  ): Promise<void> {
    const needsTenantConnection = requestedExtensions.some(
      (extension) => getSupportedExtensionDefinition(extension).installScope === 'tenant_db',
    );
    const needsInstanceConnection = requestedExtensions.some(
      (extension) => getSupportedExtensionDefinition(extension).installScope === 'instance_admin_db',
    );
    const tenantSql = needsTenantConnection ? this.connectToTenantDb(instance, tenant) : null;
    const instanceSql = needsInstanceConnection ? this.connectToInstance(instance) : null;

    try {
      for (const extension of requestedExtensions) {
        const definition = getSupportedExtensionDefinition(extension);
        if (definition.mode === 'preload' && !isManagedDbExtensionEnabled(extension)) {
          throw new ManagedDbProvisioningError(
            'provider_unsupported',
            `Managed DB extension "${extension}" is provider-gated. Configure provider support and set ` +
            `${MANAGED_DB_ENABLED_PRELOAD_EXTENSIONS_ENV}=${extension} on the API, worker, and orchestrator.`,
          );
        }

        const sql = definition.installScope === 'instance_admin_db' ? instanceSql : tenantSql;
        if (!sql) {
          throw new ManagedDbProvisioningError(
            'extension_install_failed',
            `No admin connection available for managed DB extension "${extension}" install scope "${definition.installScope}"`,
          );
        }

        const [available] = await sql<{ name: string }[]>`
          SELECT name
          FROM pg_available_extensions
          WHERE name = ${definition.extname}
        `;
        if (!available) {
          throw new ManagedDbProvisioningError(
            'extension_unavailable',
            `Managed DB extension "${extension}" (Postgres extname "${definition.extname}") ` +
            `is not available on instance ${instance.id} ` +
            `(${instance.provider}/${instance.provider_instance_id}, engine ${instance.engine_version})`,
          );
        }

        if (definition.mode === 'preload') {
          const [preloadSetting] = await sql<{ setting: string }[]>`
            SELECT setting
            FROM pg_settings
            WHERE name = 'shared_preload_libraries'
          `;
          if (!sharedPreloadLibrariesContains(preloadSetting?.setting, definition.preloadName)) {
            throw new ManagedDbProvisioningError(
              'preload_missing',
              `Managed DB extension "${extension}" requires shared_preload_libraries to include ` +
              `"${definition.preloadName}" on instance ${instance.id} ` +
              `(${instance.provider}/${instance.provider_instance_id}). Configure the Terraform-managed ` +
              `RDS parameter group in the deployment instance repo, reboot/restart the backing DB, ` +
              `then re-run deploy.`,
            );
          }
        }

        try {
          await sql.unsafe(
            `CREATE EXTENSION IF NOT EXISTS ${quotePostgresIdentifier(definition.extname)}`,
          );
        } catch (err) {
          throw new ManagedDbProvisioningError(
            'extension_install_failed',
            `Failed to install managed DB extension "${extension}" on tenant ${tenant.id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const [schema] = await sql<{ schema_name: string }[]>`
          SELECT n.nspname AS schema_name
          FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE e.extname = ${definition.extname}
        `;
        if (schema && !['public', 'pg_catalog', 'information_schema'].includes(schema.schema_name)) {
          await sql.unsafe(
            `GRANT USAGE ON SCHEMA ${quotePostgresIdentifier(schema.schema_name)} ` +
            `TO ${quotePostgresIdentifier(tenant.db_user)}`,
          );
        }
      }
    } finally {
      await tenantSql?.end();
      await instanceSql?.end();
    }
  }

  private buildTenantConnectionUrl(
    instance: { host: string; port: number },
    tenant: { db_name: string; db_user: string },
    password: string,
  ): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL not set — cannot build managed DB connection URL');
    }

    // Inherit sslmode (and any other query params) from DATABASE_URL.
    // The tenant connects to the same Postgres instance as the platform.
    const url = new URL(databaseUrl);
    url.username = tenant.db_user;
    url.password = password;
    url.hostname = instance.host;
    url.port = String(instance.port);
    url.pathname = `/${tenant.db_name}`;

    return url.toString();
  }

  /**
   * Create a real Postgres database and role on the local system Postgres.
   * Idempotent: will not fail if the role/database already exists.
   */
  private async provisionLocalDb(
    instance: { host: string; port: number },
    tenant: { db_name: string; db_user: string },
  ): Promise<string> {
    const password = crypto.randomBytes(16).toString('hex');
    const adminSql = this.connectToInstance(instance);

    try {
      // Create role (idempotent)
      const [existingRole] = await adminSql`
        SELECT 1 FROM pg_roles WHERE rolname = ${tenant.db_user}
      `;
      if (!existingRole) {
        await adminSql.unsafe(
          `CREATE ROLE "${tenant.db_user}" WITH LOGIN PASSWORD '${password}'`,
        );
      } else {
        // Role exists — update password so we always have a working credential
        await adminSql.unsafe(
          `ALTER ROLE "${tenant.db_user}" WITH PASSWORD '${password}'`,
        );
      }

      // PG 15+ no longer grants implicit membership when CREATEROLE creates a role.
      // We need membership to set the role as database OWNER.
      await adminSql.unsafe(
        `GRANT "${tenant.db_user}" TO CURRENT_USER`,
      );

      // Create database (idempotent)
      const [existingDb] = await adminSql`
        SELECT 1 FROM pg_database WHERE datname = ${tenant.db_name}
      `;
      if (!existingDb) {
        await adminSql.unsafe(
          `CREATE DATABASE "${tenant.db_name}" OWNER "${tenant.db_user}"`,
        );
      }

      return this.buildTenantConnectionUrl(instance, tenant, password);
    } finally {
      await adminSql.end();
    }
  }

  /**
   * Drop database and role for a local tenant.
   * Terminates existing connections before dropping.
   */
  private async deleteLocalDb(
    instance: { host: string; port: number },
    tenant: { db_name: string; db_user: string },
  ): Promise<void> {
    const adminSql = this.connectToInstance(instance);

    try {
      // Terminate connections to the database
      await adminSql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${tenant.db_name} AND pid != pg_backend_pid()
      `;

      await adminSql.unsafe(`DROP DATABASE IF EXISTS "${tenant.db_name}"`);
      await adminSql.unsafe(`DROP ROLE IF EXISTS "${tenant.db_user}"`);
    } finally {
      await adminSql.end();
    }
  }

  /**
   * Register the system Postgres as a local managed DB instance.
   * Idempotent — checks for existing instance with provider='local' first.
   */
  private async seedLocalInstance(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      this.logger.warn('[managed-db-reconciler] Cannot seed local instance: DATABASE_URL not set');
      return;
    }

    // Check if we already have a local instance
    const instances = await this.managedDb.listInstances();
    const existing = instances.find(i => i.provider === 'local');
    if (existing) {
      this.logger.log(`[managed-db-reconciler] Local instance already exists: ${existing.id}`);
      return;
    }

    // Parse host/port from DATABASE_URL
    const url = new URL(databaseUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '5432', 10);

    const instance = await this.managedDb.createInstance({
      id: generateManagedDbInstanceId(),
      provider: 'local',
      provider_instance_id: 'local-system-postgres',
      region: 'local',
      engine: 'postgres',
      engine_version: '16',
      host,
      port,
      instance_class: 'db.p1',
      capacity_json: { max_tenants: 50 },
    });

    this.logger.log(`[managed-db-reconciler] Seeded local managed DB instance: ${instance.id} (${host}:${port})`);
  }
}

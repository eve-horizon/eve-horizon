import { Inject, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { createDb, managedDbQueries, projectQueries, environmentQueries, orgQueries } from '@eve/db';
import {
  generateManagedDbInstanceId,
  generateManagedDbTenantId,
  generateManagedDbName,
  generateManagedDbUser,
  isValidManagedDbClass,
  getManagedDbLimits,
} from '@eve/shared';

@Injectable()
export class ManagedDbService {
  private managedDb: ReturnType<typeof managedDbQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.managedDb = managedDbQueries(db);
    this.projects = projectQueries(db);
    this.environments = environmentQueries(db);
    this.orgs = orgQueries(db);
  }

  // -----------------------------------------------------------------------
  // Project/Env scope
  // -----------------------------------------------------------------------

  async getManagedDb(projectId: string, envName: string) {
    const env = await this.requireEnv(projectId, envName);
    const orgId = await this.resolveProjectOrgId(projectId);
    // Find any managed DB tenant for this environment
    const tenants = await this.managedDb.listTenantsByOrg(
      orgId,
    );
    const tenant = tenants.find(t => t.env_id === env.id);
    if (!tenant) {
      throw new NotFoundException(`No managed DB found for environment "${envName}"`);
    }
    const extensionStatus = await this.resolveTenantExtensionStatus(tenant);
    return this.formatTenant(tenant, extensionStatus);
  }

  async rotateCredentials(projectId: string, envName: string) {
    const env = await this.requireEnv(projectId, envName);
    const orgId = await this.resolveProjectOrgId(projectId);
    // Find the tenant and request rotation
    const tenants = await this.managedDb.listTenantsByOrg(
      orgId,
    );
    const tenant = tenants.find(t => t.env_id === env.id);
    if (!tenant) {
      throw new NotFoundException(`No managed DB found for environment "${envName}"`);
    }
    if (tenant.status !== 'ready') {
      throw new BadRequestException(`Cannot rotate: managed DB is in "${tenant.status}" state`);
    }

    const token = crypto.randomUUID();
    const locked = await this.managedDb.acquireOperationLock(tenant.id, token);
    if (!locked) {
      throw new ConflictException('Another operation is in progress on this managed DB');
    }

    await this.managedDb.transitionStatus(tenant.id, token, 'rotating');
    // Reconciler will pick up the rotating state and execute
    return { message: 'Credential rotation initiated', tenant_id: tenant.id };
  }

  async scaleManagedDb(projectId: string, envName: string, desiredClass: string) {
    if (!isValidManagedDbClass(desiredClass)) {
      throw new BadRequestException(`Invalid DB class: ${desiredClass}`);
    }

    const env = await this.requireEnv(projectId, envName);
    const orgId = await this.resolveProjectOrgId(projectId);
    const tenants = await this.managedDb.listTenantsByOrg(
      orgId,
    );
    const tenant = tenants.find(t => t.env_id === env.id);
    if (!tenant) {
      throw new NotFoundException(`No managed DB found for environment "${envName}"`);
    }
    if (tenant.status !== 'ready') {
      throw new BadRequestException(`Cannot scale: managed DB is in "${tenant.status}" state`);
    }
    if (tenant.class === desiredClass) {
      return { message: 'Already at requested class', tenant_id: tenant.id };
    }

    const token = crypto.randomUUID();
    const locked = await this.managedDb.acquireOperationLock(tenant.id, token);
    if (!locked) {
      throw new ConflictException('Another operation is in progress on this managed DB');
    }

    await this.managedDb.transitionStatus(tenant.id, token, 'modifying', {
      desiredClass,
    });
    return { message: `Scaling to ${desiredClass} initiated`, tenant_id: tenant.id };
  }

  async destroyManagedDb(projectId: string, envName: string, opts?: { skip_snapshot?: boolean }) {
    const env = await this.requireEnv(projectId, envName);
    const orgId = await this.resolveProjectOrgId(projectId);
    const tenants = await this.managedDb.listTenantsByOrg(
      orgId,
    );
    const tenant = tenants.find(t => t.env_id === env.id);
    if (!tenant) {
      throw new NotFoundException(`No managed DB found for environment "${envName}"`);
    }

    // Clear snapshot_on_delete so the reconciler skips the pre-delete snapshot
    if (
      opts?.skip_snapshot &&
      this.resolveTenantSnapshotSetting(tenant.snapshot_on_delete, tenant.class)
    ) {
      await this.managedDb.updateTenantBackupConfig(tenant.id, {
        backup_schedule: tenant.backup_schedule ?? null,
        backup_retention: tenant.backup_retention ?? null,
        snapshot_on_delete: false,
        snapshot_on_reset: tenant.snapshot_on_reset,
      });
    }

    await this.managedDb.softDeleteTenant(tenant.id);
    return { message: 'Managed DB destruction initiated', tenant_id: tenant.id };
  }

  // -----------------------------------------------------------------------
  // Provisioning validation
  // -----------------------------------------------------------------------

  async validateProvisioningLimits(orgId: string, dbClass: string): Promise<void> {
    const limits = getManagedDbLimits(dbClass);
    if (!limits) {
      throw new BadRequestException(`Unknown DB class: ${dbClass}`);
    }

    const existingTenants = await this.managedDb.listTenantsByOrg(orgId);
    const activeTenants = existingTenants.filter(
      t => t.status !== 'failed' && !t.deleted_at,
    );

    if (activeTenants.length >= limits.maxTenantsPerOrg) {
      throw new BadRequestException(
        `Org has reached the maximum of ${limits.maxTenantsPerOrg} managed DB tenants for class ${dbClass}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Admin scope
  // -----------------------------------------------------------------------

  async listInstances() {
    const instances = await this.managedDb.listInstances();
    return instances.map(i => ({
      id: i.id,
      provider: i.provider,
      provider_instance_id: i.provider_instance_id,
      region: i.region,
      engine: i.engine,
      engine_version: i.engine_version,
      instance_class: i.instance_class,
      status: i.status,
      created_at: i.created_at.toISOString(),
      updated_at: i.updated_at.toISOString(),
    }));
  }

  async registerInstance(input: {
    provider: string;
    provider_instance_id: string;
    region: string;
    engine?: string;
    engine_version: string;
    host: string;
    port?: number;
    instance_class: string;
    capacity_json?: Record<string, unknown>;
  }) {
    const instance = await this.managedDb.createInstance({
      id: generateManagedDbInstanceId(),
      ...input,
    });
    return {
      id: instance.id,
      provider: instance.provider,
      provider_instance_id: instance.provider_instance_id,
      region: instance.region,
      engine: instance.engine,
      engine_version: instance.engine_version,
      instance_class: instance.instance_class,
      status: instance.status,
      created_at: instance.created_at.toISOString(),
      updated_at: instance.updated_at.toISOString(),
    };
  }

  async getInstance(instanceId: string) {
    const instance = await this.managedDb.findInstanceById(instanceId);
    if (!instance) {
      throw new NotFoundException(`Instance ${instanceId} not found`);
    }
    return {
      id: instance.id,
      provider: instance.provider,
      provider_instance_id: instance.provider_instance_id,
      region: instance.region,
      engine: instance.engine,
      engine_version: instance.engine_version,
      host: instance.host,
      port: instance.port,
      instance_class: instance.instance_class,
      status: instance.status,
      capacity_json: instance.capacity_json,
      created_at: instance.created_at.toISOString(),
      updated_at: instance.updated_at.toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async resolveProjectOrgId(projectId: string): Promise<string> {
    const project = await this.projects.findById(projectId);
    if (!project?.org_id) {
      throw new NotFoundException(`Project "${projectId}" not found`);
    }

    return project.org_id;
  }

  private async requireEnv(projectId: string, envName: string) {
    const env = await this.environments.findByProjectAndName(projectId, envName);
    if (!env) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }
    return env;
  }

  private formatTenant(tenant: {
    id: string;
    org_id: string;
    project_id: string;
    env_id: string;
    service_name: string;
    instance_id: string;
    db_name: string;
    class: string;
    desired_class: string | null;
    status: string;
    last_error_code: string | null;
    last_error_message: string | null;
    desired_extensions: string[];
    enabled_extensions: string[];
    ready_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }, extensions?: {
    installed_extensions?: Array<{ name: string; version: string }>;
    installed_extensions_error?: string | null;
  }) {
    return {
      id: tenant.id,
      org_id: tenant.org_id,
      project_id: tenant.project_id,
      env_id: tenant.env_id,
      service_name: tenant.service_name,
      instance_id: tenant.instance_id,
      db_name: tenant.db_name,
      class: tenant.class,
      desired_class: tenant.desired_class,
      status: tenant.status,
      last_error_code: tenant.last_error_code,
      last_error_message: tenant.last_error_message,
      declared_extensions: tenant.desired_extensions ?? [],
      enabled_extensions: tenant.enabled_extensions ?? [],
      installed_extensions: extensions?.installed_extensions,
      installed_extensions_error: extensions?.installed_extensions_error ?? null,
      ready_at: tenant.ready_at?.toISOString() ?? null,
      created_at: tenant.created_at.toISOString(),
      updated_at: tenant.updated_at.toISOString(),
    };
  }

  private async resolveTenantExtensionStatus(tenant: {
    status: string;
    credential_secret_ref: string | null;
  }): Promise<{
    installed_extensions?: Array<{ name: string; version: string }>;
    installed_extensions_error?: string | null;
  }> {
    if (tenant.status !== 'ready' || !tenant.credential_secret_ref) {
      return { installed_extensions: [] };
    }

    const client = createDb(tenant.credential_secret_ref);
    try {
      const rows = await client<{ name: string; version: string }[]>`
        SELECT extname AS name, extversion AS version
        FROM pg_extension
        ORDER BY extname
      `;
      return {
        installed_extensions: rows.map((row) => ({
          name: row.name,
          version: row.version,
        })),
      };
    } catch (err) {
      return {
        installed_extensions: [],
        installed_extensions_error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await client.end({ timeout: 5 });
    }
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
}

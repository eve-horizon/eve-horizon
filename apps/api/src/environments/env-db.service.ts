import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { createDb, environmentQueries, projectManifestQueries, projectQueries, orgQueries, managedDbQueries, accessGroupQueries } from '@eve/db';
import {
  getServicesFromManifest,
  loadConfig,
  ManifestSchema,
  generateManagedDbSnapshotId,
  createSnapshotStorageClient,
  buildSnapshotS3Key,
  executeSnapshot,
  resolveManagedDbSnapshotRetention,
  snapshotRetentionToExpiresAt,
  toK8sName,
  deriveNamespace,
} from '@eve/shared';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { SecretsService } from '../secrets/secrets.service.js';

type DbContext = {
  user_id?: string;
  project_id?: string;
  org_id?: string;
  env_name?: string;
  principal_type?: 'user' | 'service_principal';
  group_ids?: string[];
  permissions?: string[];
};

type DbContextDiagnostics = {
  user_id: string | null;
  principal_type: 'user' | 'service_principal' | null;
  org_id: string | null;
  project_id: string | null;
  env_name: string | null;
  group_ids: string[];
  permissions: string[];
};

type EnvDbConfig = {
  url: string;
  schema: string | null;
};

type DbClient = ReturnType<typeof createDb>;

@Injectable()
export class EnvDbService {
  private environments: ReturnType<typeof environmentQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private managedDb: ReturnType<typeof managedDbQueries>;
  private accessGroups: ReturnType<typeof accessGroupQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly secretsService: SecretsService,
  ) {
    this.environments = environmentQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.managedDb = managedDbQueries(db);
    this.accessGroups = accessGroupQueries(db);
  }

  async getSchema(projectId: string, envName: string, context: DbContext) {
    const { config, schemaFilter, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);

    return this.withClient(config, sessionContext, false, async (client) => {
      if (schemaFilter && !(await this.schemaExists(client, schemaFilter))) {
        return { tables: [] };
      }

      const tables = await client<{
        table_schema: string;
        table_name: string;
        table_type: string;
      }[]>`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ${schemaFilter ? client`AND table_schema = ${schemaFilter}` : client``}
        ORDER BY table_schema, table_name
      `;

      const columns = await client<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]>`
        SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ${schemaFilter ? client`AND table_schema = ${schemaFilter}` : client``}
        ORDER BY table_schema, table_name, ordinal_position
      `;

      type ColumnRow = typeof columns[number];
      const columnMap = new Map<string, ColumnRow[]>();
      for (const column of columns) {
        const key = `${column.table_schema}.${column.table_name}`;
        const existing = columnMap.get(key);
        if (existing) {
          existing.push(column);
        } else {
          columnMap.set(key, [column]);
        }
      }

      return {
        tables: tables.map((table) => {
          const key = `${table.table_schema}.${table.table_name}`;
          const tableColumns = columnMap.get(key) ?? [];
          const tableType: 'view' | 'table' = table.table_type === 'VIEW' ? 'view' : 'table';
          return {
            schema: table.table_schema,
            name: table.table_name,
            type: tableType,
            columns: tableColumns.map((column) => ({
              name: column.column_name,
              data_type: column.data_type,
              is_nullable: column.is_nullable === 'YES',
              default_value: column.column_default,
            })),
          };
        }),
      };
    }, { allowMissingSchema: true });
  }

  async getRls(projectId: string, envName: string, context: DbContext) {
    const { config, schemaFilter, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);
    const diagnostics = this.toContextDiagnostics(sessionContext);

    return this.withClient(config, sessionContext, false, async (client) => {
      if (schemaFilter && !(await this.schemaExists(client, schemaFilter))) {
        return {
          tables: [],
          diagnostics: {
            context: diagnostics,
          },
        };
      }

      const rows = await client<{
        schema: string;
        name: string;
        rls_enabled: boolean;
        policies: Array<{
          name: string;
          command: string;
          roles: string[];
          using: string | null;
          with_check: string | null;
        }>;
      }[]>`
        SELECT
          n.nspname AS schema,
          c.relname AS name,
          c.relrowsecurity AS rls_enabled,
          COALESCE(
            json_agg(
              json_build_object(
                'name', p.polname,
                'command', p.polcmd,
                'roles', COALESCE(
                  (SELECT array_agg(r.rolname)
                   FROM unnest(p.polroles) AS role_id
                   JOIN pg_roles r ON r.oid = role_id),
                  ARRAY[]::text[]
                ),
                'using', pg_get_expr(p.polqual, p.polrelid),
                'with_check', pg_get_expr(p.polwithcheck, p.polrelid)
              )
            ) FILTER (WHERE p.polname IS NOT NULL),
            '[]'::json
          ) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relkind IN ('r', 'p', 'v')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ${schemaFilter ? client`AND n.nspname = ${schemaFilter}` : client``}
        GROUP BY n.nspname, c.relname, c.relrowsecurity
        ORDER BY n.nspname, c.relname
      `;

      return {
        tables: rows.map((row) => ({
          schema: row.schema,
          name: row.name,
          rls_enabled: row.rls_enabled,
          policies: row.policies ?? [],
        })),
        diagnostics: {
          context: diagnostics,
        },
      };
    }, { allowMissingSchema: true });
  }

  async getExtensions(projectId: string, envName: string, context: DbContext) {
    const { config, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);

    return this.withClient(config, sessionContext, false, async (client) => {
      const rows = await client<{ name: string; version: string }[]>`
        SELECT extname AS name, extversion AS version
        FROM pg_extension
        ORDER BY extname
      `;

      return {
        extensions: rows.map((row) => ({
          name: row.name,
          version: row.version,
        })),
      };
    }, { allowMissingSchema: true });
  }

  async executeSql(
    projectId: string,
    envName: string,
    sql: string,
    params: unknown[] | undefined,
    allowWrite: boolean,
    context: DbContext,
  ) {
    const { config, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);

    return this.withClient(config, sessionContext, allowWrite, async (client) => {
      const parameters = (params ?? []) as Parameters<DbClient['unsafe']>[1];
      const result = await client.unsafe(sql, parameters);
      const rowCount = Array.isArray(result)
        ? result.length
        : typeof (result as { count?: number }).count === 'number'
          ? (result as { count: number }).count
          : 0;
      return {
        rows: result as unknown[],
        row_count: rowCount,
      };
    });
  }

  async migrate(
    projectId: string,
    envName: string,
    migrations: Array<{ name: string; sql: string }>,
    context: DbContext,
  ) {
    const { config, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);
    const applied: Array<{ name: string; checksum: string; applied_at: string }> = [];

    for (const migration of migrations) {
      await this.withClient(config, sessionContext, true, async (client) => {
        await client`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;

        const [existing] = await client<{ checksum: string; applied_at: Date }[]>`
          SELECT checksum, applied_at FROM schema_migrations WHERE name = ${migration.name}
        `;

        const checksum = crypto.createHash('sha256').update(migration.sql).digest('hex');
        if (existing) {
          if (existing.checksum !== checksum) {
            throw new BadRequestException(`Migration ${migration.name} has changed checksum`);
          }
          applied.push({
            name: migration.name,
            checksum: existing.checksum,
            applied_at: existing.applied_at.toISOString(),
          });
          return;
        }

        await client.unsafe(migration.sql);
        const [inserted] = await client<{ name: string; checksum: string; applied_at: Date }[]>`
          INSERT INTO schema_migrations (name, checksum)
          VALUES (${migration.name}, ${checksum})
          RETURNING name, checksum, applied_at
        `;

        if (inserted) {
          applied.push({
            name: inserted.name,
            checksum: inserted.checksum,
            applied_at: inserted.applied_at.toISOString(),
          });
        }
      });
    }

    return { applied };
  }

  async listMigrations(projectId: string, envName: string, context: DbContext) {
    const { config, schemaFilter, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);

    return this.withClient(config, sessionContext, true, async (client) => {
      if (schemaFilter && !(await this.schemaExists(client, schemaFilter))) {
        return { migrations: [] };
      }

      const [table] = await client<{ name: string | null }[]>`
        SELECT to_regclass('schema_migrations') as name
      `;
      if (!table?.name) {
        return { migrations: [] };
      }

      const rows = await client<{ name: string; checksum: string; applied_at: Date }[]>`
        SELECT name, checksum, applied_at
        FROM schema_migrations
        ORDER BY applied_at ASC
      `;

      return {
        migrations: rows.map((row) => ({
          name: row.name,
          checksum: row.checksum,
          applied_at: row.applied_at.toISOString(),
        })),
      };
    }, { allowMissingSchema: true });
  }

  async reset(
    projectId: string,
    envName: string,
    options: {
      migrations?: Array<{ name: string; sql: string }>;
      no_migrate?: boolean;
      force?: boolean;
      danger_reset_production?: boolean;
      skip_snapshot?: boolean;
    },
    context: DbContext,
  ): Promise<{ reset: boolean; migrations_applied: Array<{ name: string; checksum: string; applied_at: string }> }> {
    const isProduction = this.isProductionEnvName(envName);
    if (isProduction) {
      if (!options.danger_reset_production) {
        throw new BadRequestException(
          'Resetting production requires danger_reset_production=true',
        );
      }
    } else if (!options.force) {
      throw new BadRequestException('Reset requires force=true for non-production environments');
    }

    // Snapshot-on-reset: create safety snapshot if configured on the tenant
    if (!options.skip_snapshot) {
      try {
        const env = await this.environments.findByProjectAndName(projectId, envName);
        if (env) {
          const project = await this.projects.findById(projectId, { include_deleted: true });
          if (project) {
            const org = await this.orgs.findById(project.org_id);
            const tenants = await this.managedDb.listTenantsByOrg(project.org_id);
            const tenant = tenants.find(t => t.env_id === env.id && t.status === 'ready');
            if (
              tenant
              && this.resolveSnapshotBooleanSetting(tenant.snapshot_on_reset, tenant.class)
              && tenant.credential_secret_ref
              && org
            ) {
              const { managedDbSnapshotQueries } = await import('@eve/db');
              const snapshots = managedDbSnapshotQueries(this.db);
              const snapshotStorage = createSnapshotStorageClient();
              if (snapshotStorage) {
                const snapshotId = generateManagedDbSnapshotId();
                const s3Key = buildSnapshotS3Key(org.slug, project.slug, envName, snapshotId);
                const retention = resolveManagedDbSnapshotRetention(undefined, {
                  dbClass: tenant.class,
                  tenantRetention: tenant.backup_retention,
                });

                await snapshots.createSnapshot({
                  id: snapshotId,
                  tenant_id: tenant.id,
                  org_id: org.id,
                  project_id: project.id,
                  env_id: env.id,
                  instance_id: tenant.instance_id,
                  created_by: 'system:pre-reset',
                  trigger: 'pre_reset',
                  s3_bucket: snapshotStorage.bucket,
                  s3_key: s3Key,
                  retention,
                  expires_at: snapshotRetentionToExpiresAt(retention),
                });

                const url = new URL(tenant.credential_secret_ref);
                const dbConfig = {
                  host: url.hostname,
                  port: parseInt(url.port, 10) || 5432,
                  username: decodeURIComponent(url.username),
                  password: decodeURIComponent(url.password),
                  database: url.pathname.replace(/^\//, ''),
                };

                // Fire and forget — don't block reset
                executeSnapshot(dbConfig, { client: snapshotStorage.client, bucket: snapshotStorage.bucket, key: s3Key })
                  .then(async (result) => {
                    await snapshots.completeSnapshot(snapshotId, {
                      size_bytes: result.sizeBytes,
                      db_size_bytes: result.dbSizeBytes,
                      pg_version: result.pgVersion,
                    });
                    await snapshots.updateTenantLastSnapshotAt(tenant.id);
                  })
                  .catch(async (err) => {
                    await snapshots.failSnapshot(snapshotId, err instanceof Error ? err.message : String(err));
                  });
              }
            }
          }
        }
      } catch (err) {
        // Best-effort: don't block reset if snapshot fails
        console.warn(`Pre-reset snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { config, orgId } = await this.resolveEnvDb(projectId, envName);
    const sessionContext = await this.enrichContext(context, orgId);

    await this.withClient(config, sessionContext, true, async (client) => {
      await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    });

    if (options.no_migrate) {
      return {
        reset: true,
        migrations_applied: [],
      };
    }

    const migrations = options.migrations ?? [];
    if (migrations.length === 0) {
      throw new BadRequestException('migrations are required unless no_migrate=true');
    }

    const result = await this.migrate(projectId, envName, migrations, context);
    return {
      reset: true,
      migrations_applied: result.applied,
    };
  }

  async resolveOrgIdForProject(projectId: string): Promise<string> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    return project.org_id;
  }

  private async resolveEnvDb(projectId: string, envName: string): Promise<{
    config: EnvDbConfig;
    schemaFilter: string | null;
    orgId: string;
  }> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const environment = await this.environments.findByProjectAndName(projectId, envName);
    if (!environment) {
      throw new NotFoundException(`Environment "${envName}" not found for project ${projectId}`);
    }

    const overrides = environment.overrides_json ?? {};
    const dbOverrides = typeof overrides.db === 'object' && overrides.db !== null
      ? (overrides.db as Record<string, unknown>)
      : null;

    const overrideUrl = dbOverrides
      ? (dbOverrides.url ?? dbOverrides.connection_url ?? dbOverrides.database_url)
      : null;
    const overrideSchema = dbOverrides && typeof dbOverrides.schema === 'string'
      ? dbOverrides.schema
      : null;

    if (typeof overrideUrl === 'string' && overrideUrl.length > 0) {
      return {
        config: {
          url: overrideUrl,
          schema: this.normalizeSchemaName(overrideSchema),
        },
        schemaFilter: this.normalizeSchemaName(overrideSchema),
        orgId: project.org_id,
      };
    }

    const org = await this.orgs.findById(project.org_id);
    const orgSlug = org?.slug ?? '';

    const manifest = await this.manifests.findLatestByProject(projectId);
    if (manifest) {
      const parsed = yaml.parse(manifest.manifest_yaml);
      const validated = ManifestSchema.safeParse(parsed);
      const services = validated.success ? getServicesFromManifest(validated.data) : null;

      if (services) {
        const serviceName = environment.db_ref && services[environment.db_ref]
          ? environment.db_ref
          : this.findDatabaseServiceName(services) ?? this.findManagedDbServiceName(services);

        if (serviceName) {
          const service = services[serviceName] as Record<string, unknown>;
          const xEve = this.resolveXeve(service);

          // Managed DB: resolve from tenant record instead of manifest service config
          if (xEve.role === 'managed_db') {
            const tenant = await this.managedDb.findReadyTenantByEnv(environment.id, serviceName);
            if (tenant && tenant.credential_secret_ref) {
              // credential_secret_ref stores the connection URL encrypted via secrets framework
              const connectionUrl = await this.interpolateSecrets(tenant.credential_secret_ref, projectId);
              return {
                config: { url: connectionUrl, schema: null },
                schemaFilter: null,
                orgId: project.org_id,
              };
            }
            // Managed DB exists but not ready — fail fast per plan requirements
            if (tenant) {
              throw new BadRequestException(
                `Managed DB for service "${serviceName}" is in "${tenant.status}" state (not ready). ` +
                `Wait for provisioning to complete or check "eve db status".`
              );
            }
            // No tenant record yet — this is expected before first deploy triggers provisioning
            throw new NotFoundException(
              `No managed DB tenant found for service "${serviceName}" in environment "${envName}". ` +
              `Deploy the environment to trigger provisioning.`
            );
          }

          const connectionUrl = await this.resolveServiceConnectionUrl(service, orgSlug, project.slug, envName, environment.namespace, serviceName, projectId);
          if (connectionUrl) {
            return {
              config: { url: connectionUrl, schema: null },
              schemaFilter: null,
              orgId: project.org_id,
            };
          }
        }
      }
    }

    const fallbackSchema = this.normalizeSchemaName(`eve_env_${project.slug}_${envName}`);
    const coreUrl = loadConfig().DATABASE_URL;
    return {
      config: {
        url: coreUrl,
        schema: fallbackSchema,
      },
      schemaFilter: fallbackSchema,
      orgId: project.org_id,
    };
  }

  private async resolveServiceConnectionUrl(
    service: Record<string, unknown>,
    orgSlug: string,
    projectSlug: string,
    envName: string,
    namespace: string | null,
    serviceName: string,
    projectId: string,
  ): Promise<string | null> {
    const xEve = this.resolveXeve(service);
    const connectionUrl = typeof xEve.connection_url === 'string'
      ? xEve.connection_url
      : typeof (service as Record<string, unknown>).connection_url === 'string'
        ? (service as Record<string, unknown>).connection_url as string
        : typeof (service as Record<string, unknown>).url === 'string'
          ? (service as Record<string, unknown>).url as string
          : null;
    if (connectionUrl) {
      return await this.interpolateSecrets(connectionUrl, projectId);
    }

    const env = typeof (service as Record<string, unknown>).environment === 'object'
      && (service as Record<string, unknown>).environment
      ? ((service as Record<string, unknown>).environment as Record<string, unknown>)
      : {};

    const directUrl = env.DATABASE_URL;
    if (typeof directUrl === 'string') {
      return await this.interpolateSecrets(directUrl, projectId);
    }

    const user = typeof env.POSTGRES_USER === 'string' ? env.POSTGRES_USER : 'postgres';
    const rawPassword = typeof env.POSTGRES_PASSWORD === 'string' ? env.POSTGRES_PASSWORD : '';
    const password = await this.interpolateSecrets(rawPassword, projectId);
    const database = typeof env.POSTGRES_DB === 'string' ? env.POSTGRES_DB : 'postgres';
    const portValue = typeof env.POSTGRES_PORT === 'string'
      ? parseInt(env.POSTGRES_PORT, 10)
      : typeof env.DB_PORT === 'string'
        ? parseInt(env.DB_PORT, 10)
        : this.resolveServicePort(service) ?? 5432;
    const port = Number.isFinite(portValue) ? portValue : 5432;
    const host = typeof env.POSTGRES_HOST === 'string'
      ? env.POSTGRES_HOST
      : typeof env.DB_HOST === 'string'
        ? env.DB_HOST
        : this.resolveK8sServiceHost(orgSlug, projectSlug, envName, namespace, serviceName);

    const passwordPart = password ? `:${encodeURIComponent(password)}` : '';
    return `postgres://${encodeURIComponent(user)}${passwordPart}@${host}:${port}/${database}`;
  }

  private async interpolateSecrets(value: string, projectId: string): Promise<string> {
    const secretPattern = /\$\{secret\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
    const matches = value.matchAll(secretPattern);
    let result = value;

    for (const match of matches) {
      const secretKey = match[1];
      const secretValue = await this.secretsService.resolveProjectSecretValue(projectId, secretKey);
      if (secretValue !== null) {
        result = result.replace(match[0], secretValue);
      }
    }

    return result;
  }

  private resolveK8sServiceHost(
    orgSlug: string,
    projectSlug: string,
    envName: string,
    namespace: string | null,
    serviceName: string,
  ): string {
    const envSlug = toK8sName(envName, 'environment');
    const componentSlug = toK8sName(serviceName, 'service');
    const resourceName = `${envSlug}-${componentSlug}`;
    const namespaceName = deriveNamespace(orgSlug, projectSlug, envName, namespace);
    return `${resourceName}.${namespaceName}.svc.cluster.local`;
  }

  private findDatabaseServiceName(services: Record<string, unknown>): string | null {
    const matches = Object.entries(services).filter(([, value]) => {
      if (!value || typeof value !== 'object') return false;
      const xEve = this.resolveXeve(value as Record<string, unknown>);
      return xEve.role === 'database';
    });

    if (matches.length === 1) {
      return matches[0][0];
    }

    return null;
  }

  private findManagedDbServiceName(services: Record<string, unknown>): string | null {
    const matches = Object.entries(services).filter(([, value]) => {
      if (!value || typeof value !== 'object') return false;
      const xEve = this.resolveXeve(value as Record<string, unknown>);
      return xEve.role === 'managed_db';
    });

    if (matches.length === 1) {
      return matches[0][0];
    }

    return null;
  }

  private resolveXeve(service: Record<string, unknown>): Record<string, unknown> {
    const xEve = service['x-eve'] ?? service.x_eve;
    return xEve && typeof xEve === 'object' ? xEve as Record<string, unknown> : {};
  }

  private resolveServicePort(service: Record<string, unknown>): number | null {
    const ports = service.ports;
    if (!Array.isArray(ports)) return null;
    for (const port of ports) {
      if (typeof port === 'number' && Number.isFinite(port)) {
        return port;
      }
      if (typeof port === 'string') {
        const parts = port.split(':');
        const candidate = parts.length > 1 ? parts[parts.length - 1] : parts[0];
        const parsed = Number.parseInt(candidate, 10);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  private normalizeSchemaName(schema: string | null): string | null {
    if (!schema) return null;
    const normalized = schema.replace(/[^A-Za-z0-9_]/g, '_');
    const trimmed = normalized.replace(/^_+/, '').slice(0, 63);
    if (!trimmed) {
      return null;
    }
    return trimmed;
  }

  private isProductionEnvName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === 'production' || normalized === 'prod';
  }

  private resolveSnapshotBooleanSetting(enabled: boolean | null, dbClass: string): boolean {
    if (enabled !== null) {
      return enabled;
    }
    return dbClass === 'db.p2' || dbClass === 'db.p3';
  }

  private async withClient<T>(
    config: EnvDbConfig,
    context: DbContext,
    allowWrite: boolean,
    action: (client: DbClient) => Promise<T>,
    options?: { allowMissingSchema?: boolean },
  ): Promise<T> {
    const client = createDb(config.url);
    try {
      return await client.begin(async (tx) => {
        const transaction = tx as unknown as DbClient;
        if (!allowWrite) {
          await transaction.unsafe('SET TRANSACTION READ ONLY');
        }

        if (config.schema && !options?.allowMissingSchema) {
          await this.ensureSchema(transaction, config.schema, allowWrite);
        }

        await this.applySessionContext(transaction, context);
        return action(transaction);
      }) as Promise<T>;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  private async ensureSchema(
    client: DbClient,
    schema: string,
    allowWrite = true,
  ): Promise<void> {
    if (allowWrite) {
      await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }
    await client.unsafe(`SET search_path TO "${schema}"`);
  }

  private async schemaExists(client: DbClient, schema: string): Promise<boolean> {
    const [row] = await client<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}
      ) AS exists
    `;
    if (row?.exists) {
      await client.unsafe(`SET search_path TO "${schema}"`);
      return true;
    }
    return false;
  }

  private async applySessionContext(client: DbClient, context: DbContext): Promise<void> {
    if (context.user_id) {
      await client`SELECT set_config('app.user_id', ${context.user_id}, true)`;
    }
    if (context.principal_type) {
      await client`SELECT set_config('app.principal_type', ${context.principal_type}, true)`;
    }
    if (context.org_id) {
      await client`SELECT set_config('app.org_id', ${context.org_id}, true)`;
    }
    if (context.project_id) {
      await client`SELECT set_config('app.project_id', ${context.project_id}, true)`;
    }
    if (context.env_name) {
      await client`SELECT set_config('app.env_name', ${context.env_name}, true)`;
    }
    if (context.group_ids) {
      await client`SELECT set_config('app.group_ids', ${JSON.stringify(context.group_ids)}, true)`;
    }
    if (context.permissions) {
      await client`SELECT set_config('app.permissions', ${JSON.stringify(context.permissions)}, true)`;
    }
  }

  private async enrichContext(context: DbContext, orgId: string): Promise<DbContext> {
    const principalType = context.principal_type ?? 'user';
    let groupIds = context.group_ids;

    if (!groupIds && context.user_id && (principalType === 'user' || principalType === 'service_principal')) {
      groupIds = await this.accessGroups.listGroupIdsForPrincipal(orgId, principalType, context.user_id);
    }

    return {
      ...context,
      org_id: orgId,
      principal_type: principalType,
      group_ids: groupIds ?? [],
    };
  }

  private toContextDiagnostics(context: DbContext): DbContextDiagnostics {
    return {
      user_id: context.user_id ?? null,
      principal_type: context.principal_type ?? null,
      org_id: context.org_id ?? null,
      project_id: context.project_id ?? null,
      env_name: context.env_name ?? null,
      group_ids: context.group_ids ?? [],
      permissions: context.permissions ?? [],
    };
  }

}

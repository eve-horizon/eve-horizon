import type { FlagValue } from '../lib/args';
import { getStringFlag, toBoolean } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { renderTable } from '../lib/format';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { applyMigrations, listMigrations, resetSchema } from '@eve/migrate';
import type { DbExtensionsResponse } from '@eve/shared';
import postgres from 'postgres';

const MIGRATION_REGEX = /^(\d{14})_([a-z0-9_]+)\.sql$/;

type DbRlsResponse = {
  tables: Array<{
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
  }>;
  diagnostics?: {
    context?: {
      user_id?: string | null;
      principal_type?: 'user' | 'service_principal' | null;
      org_id?: string | null;
      project_id?: string | null;
      env_name?: string | null;
      group_ids?: string[];
      permissions?: string[];
    };
  };
};

export async function handleDb(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const jsonOutput = Boolean(flags.json);

  switch (subcommand) {
    case 'schema':
      return handleSchema(positionals, flags, context, jsonOutput);
    case 'rls':
      return handleRls(positionals, flags, context, jsonOutput);
    case 'sql':
      return handleSql(positionals, flags, context, jsonOutput);
    case 'migrate':
      return handleMigrate(positionals, flags, context, jsonOutput);
    case 'migrations':
      return handleMigrations(positionals, flags, context, jsonOutput);
    case 'reset':
      return handleReset(positionals, flags, context, jsonOutput);
    case 'wipe':
      return handleWipe(positionals, flags, context, jsonOutput);
    case 'new':
      return handleNew(positionals, flags);
    case 'status':
      return handleStatus(positionals, flags, context, jsonOutput);
    case 'extensions':
      return handleExtensions(positionals, flags, context, jsonOutput);
    case 'rotate-credentials':
      return handleRotateCredentials(positionals, flags, context, jsonOutput);
    case 'scale':
      return handleScale(positionals, flags, context, jsonOutput);
    case 'destroy':
      return handleDestroy(positionals, flags, context, jsonOutput);
    case 'snapshot':
      return handleSnapshot(positionals, flags, context, jsonOutput);
    case 'snapshots':
      return handleSnapshots(positionals, flags, context, jsonOutput);
    case 'restore':
      return handleRestore(positionals, flags, context, jsonOutput);
    case 'backup-status':
      return handleBackupStatus(positionals, flags, context, jsonOutput);
    default:
      throw new Error(
        'Usage: eve db <command> [options]\n\n' +
        'Commands:\n' +
        '  schema              --env <name>|--url <url>     Show DB schema info\n' +
        '  rls                 --env <name>                 Show RLS policies and tables\n' +
        '  rls init            --with-groups               Scaffold group-aware RLS helper SQL\n' +
        '  sql                 --env <name>|--url <url> --sql <stmt>  Run parameterized SQL\n' +
        '  migrate             --env <name>|--url <url> [--path <dir>]  Apply pending migrations\n' +
        '  migrations          --env <name>|--url <url>     List applied migrations\n' +
        '  reset               --env <name>|--url <url> --force [--no-migrate] [--skip-snapshot]  Reset DB schema\n' +
        '  wipe                --env <name>|--url <url> --force  Reset schema without migrations\n' +
        '  new                 <description>                Create new migration file\n' +
        '  status              --env <name>                 Show managed DB status\n' +
        '  extensions list     --env <name>                 List installed DB extensions\n' +
        '  rotate-credentials  --env <name>                 Rotate managed DB credentials\n' +
        '  scale               --env <name> --class <cls>   Scale managed DB class\n' +
        '  destroy             --env <name> --force [--skip-snapshot]  Destroy managed DB\n' +
        '  snapshot             --env <name>                 Create a DB snapshot\n' +
        '  snapshot show        <snapshot_id>                Show snapshot details\n' +
        '  snapshot delete      <snapshot_id> [--force]      Delete a snapshot\n' +
        '  snapshots            --env <name>                 List DB snapshots\n' +
        '  restore              --env <name> --snapshot <id> Restore from snapshot\n' +
        '  backup-status        --env <name>                 Show backup schedule/status',
      );
  }
}

async function handleSchema(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const target = resolveDbTarget(positionals, flags, context, {
    usage: 'Usage: eve db schema --env <name>|--url <postgres-url> [--project <id>]',
    envVarPrecedence: false,
  });

  if (target.mode === 'url') {
    const response = await getSchemaDirect(target.url);
    outputJson(response, jsonOutput);
    return;
  }

  const response = await requestJson(context, `/projects/${target.projectId}/envs/${target.envName}/db/schema`);
  outputJson(response, jsonOutput);
}

async function handleRls(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  if (positionals[0] === 'init') {
    return handleRlsInit(flags, jsonOutput);
  }

  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/rls`) as DbRlsResponse;
  if (jsonOutput) {
    outputJson(response, true);
    return;
  }
  printRlsResponse(response);
}

function handleRlsInit(
  flags: Record<string, FlagValue>,
  jsonOutput: boolean,
): void {
  const withGroups = toBoolean(flags['with-groups']) ?? false;
  const force = toBoolean(flags.force) ?? false;

  if (!withGroups) {
    throw new Error('Usage: eve db rls init --with-groups [--out <path>] [--force]');
  }

  const outPath = getStringFlag(flags, ['out']) ?? 'db/rls/helpers.sql';
  const fullPath = resolvePath(outPath);

  if (existsSync(fullPath) && !force) {
    throw new Error(`RLS helper file already exists: ${fullPath}\nUse --force to overwrite.`);
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, renderRlsHelperTemplate());

  const payload = {
    path: fullPath,
    with_groups: true,
  };

  outputJson(payload, jsonOutput, `Created group-aware RLS helpers at ${fullPath}`);
}

function renderRlsHelperTemplate(): string {
  return `-- Eve RLS helpers generated by "eve db rls init --with-groups"
-- Usage:
--   1. Apply this SQL in your target environment DB.
--   2. Reference app.current_user_id()/app.current_group_ids()/app.has_group() in policies.
--
-- Example:
--   CREATE POLICY notes_group_read
--   ON notes
--   FOR SELECT
--   USING (group_id = ANY(app.current_group_ids()));

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '');
$$;

CREATE OR REPLACE FUNCTION app.current_group_ids()
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  WITH raw AS (
    SELECT NULLIF(current_setting('app.group_ids', true), '') AS value
  )
  SELECT COALESCE(
    ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(raw.value::jsonb, '[]'::jsonb))
      FROM raw
    ),
    ARRAY[]::text[]
  );
$$;

CREATE OR REPLACE FUNCTION app.has_group(group_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT group_id = ANY(app.current_group_ids());
$$;
`;
}

function printRlsResponse(response: DbRlsResponse): void {
  const diagnostics = response.diagnostics?.context;
  if (diagnostics) {
    const groups = diagnostics.group_ids ?? [];
    const permissions = diagnostics.permissions ?? [];
    console.log('Context:');
    console.log(`  Principal: ${diagnostics.principal_type ?? 'unknown'} ${diagnostics.user_id ?? '(none)'}`);
    console.log(`  Org: ${diagnostics.org_id ?? '(none)'}`);
    console.log(`  Project: ${diagnostics.project_id ?? '(none)'}`);
    console.log(`  Env: ${diagnostics.env_name ?? '(none)'}`);
    console.log(`  Groups (${groups.length}): ${groups.length > 0 ? groups.join(', ') : '(none)'}`);
    console.log(`  Permissions (${permissions.length}): ${permissions.length > 0 ? permissions.join(', ') : '(none)'}`);
    console.log('');
  }

  const tables = response.tables ?? [];
  if (tables.length === 0) {
    console.log('No user tables/views found.');
    return;
  }

  console.log(`RLS tables (${tables.length}):`);
  for (const table of tables) {
    const state = table.rls_enabled ? 'enabled' : 'disabled';
    console.log(`  - ${table.schema}.${table.name} (${state}, ${table.policies.length} policies)`);
  }
}

function printExtensionsResponse(envName: string, response: DbExtensionsResponse): void {
  const extensions = response.extensions ?? [];
  console.log(`Installed DB Extensions for ${envName}:\n`);
  if (extensions.length === 0) {
    console.log('  (none)');
    return;
  }

  console.log(`  ${'Name'.padEnd(28)} Version`);
  console.log(`  ${'-'.repeat(28)} ${'-'.repeat(12)}`);
  for (const extension of extensions) {
    console.log(`  ${extension.name.padEnd(28)} ${extension.version}`);
  }
}

async function handleExtensions(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const subcommand = positionals[0];
  if (subcommand !== 'list') {
    throw new Error('Usage: eve db extensions list --env <name> [--project <id>]');
  }

  const { projectId, envName } = resolveProjectEnv(positionals.slice(1), flags, context);
  const response = await requestJson(
    context,
    `/projects/${projectId}/envs/${envName}/db/extensions`,
  ) as DbExtensionsResponse;

  if (jsonOutput) {
    outputJson(response, true);
  } else {
    printExtensionsResponse(envName, response);
  }
}

async function handleSql(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const target = resolveDbTarget(positionals, flags, context, {
    usage: 'Usage: eve db sql --env <name>|--url <postgres-url> --sql <statement> [--params <json>] [--write]',
    envVarPrecedence: true,
  });

  const sqlPositionals = target.mode === 'env' ? target.remainingPositionals : positionals;
  const sqlInput = getStringFlag(flags, ['sql']) ?? sqlPositionals.join(' ');
  const fileInput = getStringFlag(flags, ['file']);
  const sqlText = fileInput ? readFileSync(resolvePath(fileInput), 'utf-8') : sqlInput;

  if (!sqlText) {
    throw new Error('Usage: eve db sql --env <name>|--url <postgres-url> --sql <statement> [--params <json>] [--write]');
  }

  const paramsFlag = getStringFlag(flags, ['params']);
  const params = paramsFlag ? parseJson(paramsFlag, '--params') as unknown[] : undefined;

  const allowWrite = toBoolean(flags.write);

  if (allowWrite) {
    console.warn('⚠️  Write mode enabled - changes will be committed to the database');
  }

  const body: Record<string, unknown> = {
    sql: sqlText,
    ...(params !== undefined ? { params } : {}),
    ...(allowWrite !== undefined ? { allow_write: allowWrite } : {}),
  };

  if (target.mode === 'url') {
    const response = await executeSqlDirect(target.url, sqlText, params, allowWrite ?? false);
    outputJson(response, jsonOutput);
    return;
  }

  const response = await requestJson(context, `/projects/${target.projectId}/envs/${target.envName}/db/sql`, {
    method: 'POST',
    body,
  });

  outputJson(response, jsonOutput);
}

function resolveProjectEnv(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): { projectId: string; envName: string } {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = getStringFlag(flags, ['env']) ?? positionals[0];

  if (!projectId || !envName) {
    throw new Error('Missing project or env. Usage: --env <name> [--project <id>]');
  }

  return { projectId, envName };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error as Error).message}`);
  }
}

type DbTarget =
  | { mode: 'url'; url: string }
  | { mode: 'env'; projectId: string; envName: string; remainingPositionals: string[] };

function resolveDbTarget(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  options: { usage: string; envVarPrecedence: boolean },
): DbTarget {
  const url = getStringFlag(flags, ['url']);
  if (url) {
    return { mode: 'url', url };
  }

  const envFromFlag = getStringFlag(flags, ['env']);
  if (envFromFlag) {
    const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    if (!projectId) {
      throw new Error(options.usage);
    }
    return {
      mode: 'env',
      projectId,
      envName: envFromFlag,
      remainingPositionals: positionals,
    };
  }

  const envUrl = resolveDbUrlFromEnv();
  if (options.envVarPrecedence && envUrl) {
    return { mode: 'url', url: envUrl };
  }

  if (positionals.length > 0) {
    const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    if (!projectId) {
      throw new Error(options.usage);
    }
    return {
      mode: 'env',
      projectId,
      envName: positionals[0],
      remainingPositionals: positionals.slice(1),
    };
  }

  if (envUrl) {
    return { mode: 'url', url: envUrl };
  }

  throw new Error(options.usage);
}

function resolveDbUrlFromEnv(): string | undefined {
  const fromProcess = process.env.EVE_DB_URL;
  if (fromProcess && fromProcess.trim().length > 0) {
    return fromProcess.trim();
  }
  return readEnvFileValue('EVE_DB_URL');
}

function readEnvFileValue(key: string): string | undefined {
  const envPath = resolvePath('.env');
  if (!existsSync(envPath)) return undefined;

  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (name !== key) continue;
    const value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function loadMigrationsFromPath(migrationsPath: string): Array<{ name: string; sql: string }> {
  const fullPath = resolvePath(migrationsPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Migrations directory not found: ${fullPath}`);
  }

  const files = readdirSync(fullPath)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (!MIGRATION_REGEX.test(file)) {
      throw new Error(
        `Invalid migration filename: ${file}\n` +
          'Expected format: YYYYMMDDHHmmss_description.sql\n' +
          'Example: 20260128100000_create_users.sql',
      );
    }
  }

  return files.map((file) => ({
    name: file,
    sql: readFileSync(join(fullPath, file), 'utf-8'),
  }));
}

async function executeSqlDirect(
  connectionUrl: string,
  sql: string,
  params: unknown[] | undefined,
  allowWrite: boolean,
): Promise<{ rows: unknown[]; row_count: number }> {
  const db = postgres(connectionUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    return await db.begin(async (tx) => {
      if (!allowWrite) {
        await tx.unsafe('SET TRANSACTION READ ONLY');
      }
      const result = await tx.unsafe(sql, (params ?? []) as Parameters<typeof tx.unsafe>[1]);
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
  } finally {
    await db.end();
  }
}

async function getSchemaDirect(connectionUrl: string): Promise<{
  tables: Array<{
    schema: string;
    name: string;
    type: 'table' | 'view';
    columns: Array<{
      name: string;
      data_type: string;
      is_nullable: boolean;
      default_value: string | null;
    }>;
  }>;
}> {
  const db = postgres(connectionUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    const tables = await db<{
      table_schema: string;
      table_name: string;
      table_type: string;
    }[]>`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `;

    const columns = await db<{
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
      ORDER BY table_schema, table_name, ordinal_position
    `;

    type ColumnRow = typeof columns[number];
    const byTable = new Map<string, ColumnRow[]>();
    for (const column of columns) {
      const key = `${column.table_schema}.${column.table_name}`;
      const entry = byTable.get(key);
      if (entry) {
        entry.push(column);
      } else {
        byTable.set(key, [column]);
      }
    }

    return {
      tables: tables.map((table) => {
        const key = `${table.table_schema}.${table.table_name}`;
        const tableColumns = byTable.get(key) ?? [];
        return {
          schema: table.table_schema,
          name: table.table_name,
          type: table.table_type === 'VIEW' ? 'view' : 'table',
          columns: tableColumns.map((column) => ({
            name: column.column_name,
            data_type: column.data_type,
            is_nullable: column.is_nullable === 'YES',
            default_value: column.column_default,
          })),
        };
      }),
    };
  } finally {
    await db.end();
  }
}

async function handleMigrate(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const target = resolveDbTarget(positionals, flags, context, {
    usage: 'Usage: eve db migrate --env <name>|--url <postgres-url> [--path <dir>] [--project <id>]',
    envVarPrecedence: false,
  });
  const migrations = loadMigrationsFromPath(getStringFlag(flags, ['path']) ?? 'db/migrations');

  console.log(`Found ${migrations.length} migration files`);
  if (migrations.length === 0) {
    console.log('No migration files found');
    return;
  }

  if (target.mode === 'url') {
    const applied = await applyMigrations({
      connectionUrl: target.url,
      migrations,
    });
    if (jsonOutput) {
      outputJson({
        applied: applied
          .filter((entry) => entry.applied)
          .map((entry) => ({ name: entry.filename, checksum: entry.checksum })),
      }, true);
      return;
    }
    const newlyApplied = applied.filter((entry) => entry.applied);
    if (newlyApplied.length === 0) {
      console.log('No new migrations to apply');
    } else {
      console.log(`Applied ${newlyApplied.length} migrations:`);
      for (const migration of newlyApplied) {
        console.log(`  ✓ ${migration.filename}`);
      }
    }
    return;
  }

  const response = await requestJson(context, `/projects/${target.projectId}/envs/${target.envName}/db/migrate`, {
    method: 'POST',
    body: { migrations },
  });

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const applied = (response as { applied?: Array<{ name: string }> }).applied ?? [];
    if (applied.length === 0) {
      console.log('No new migrations to apply');
    } else {
      console.log(`Applied ${applied.length} migrations:`);
      for (const m of applied) {
        console.log(`  ✓ ${m.name}`);
      }
    }
  }
}

async function handleMigrations(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const target = resolveDbTarget(positionals, flags, context, {
    usage: 'Usage: eve db migrations --env <name>|--url <postgres-url> [--project <id>]',
    envVarPrecedence: false,
  });

  const response = target.mode === 'url'
    ? {
        migrations: (await listMigrations({ connectionUrl: target.url })).map((migration) => ({
          name: migration.filename,
          checksum: migration.checksum,
          applied_at: migration.appliedAt,
        })),
      }
    : await requestJson(context, `/projects/${target.projectId}/envs/${target.envName}/db/migrations`);

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const migrations = (response as { migrations?: Array<{ name: string; checksum: string; applied_at: string }> }).migrations ?? [];
    if (migrations.length === 0) {
      console.log('No migrations have been applied');
    } else {
      console.log(`Applied migrations (${migrations.length}):\n`);
      console.log('  Name                                     Applied At');
      console.log('  ' + '-'.repeat(70));
      for (const m of migrations) {
        const date = new Date(m.applied_at).toLocaleString();
        console.log(`  ${m.name.padEnd(40)} ${date}`);
      }
    }
  }
}

async function handleReset(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const target = resolveDbTarget(positionals, flags, context, {
    usage: 'Usage: eve db reset --env <name>|--url <postgres-url> --force [--no-migrate] [--path <dir>]',
    envVarPrecedence: false,
  });

  const noMigrate = toBoolean(flags['no-migrate']) ?? toBoolean(flags.no_migrate) ?? false;
  const force = toBoolean(flags.force) ?? false;
  const dangerResetProduction = toBoolean(flags['danger-reset-production']) ?? toBoolean(flags.danger_reset_production) ?? false;
  const skipSnapshot = toBoolean(flags['skip-snapshot']) ?? false;
  const migrations = noMigrate ? [] : loadMigrationsFromPath(getStringFlag(flags, ['path']) ?? 'db/migrations');

  if (target.mode === 'url') {
    if (!force) {
      throw new Error('Direct URL resets are destructive.\nAdd --force to confirm: eve db reset --url <postgres-url> --force');
    }

    await resetSchema(target.url);
    const applied = noMigrate
      ? []
      : await applyMigrations({
          connectionUrl: target.url,
          migrations,
        });

    const payload = {
      reset: true,
      migrations_applied: applied
        .filter((entry) => entry.applied)
        .map((entry) => ({ name: entry.filename, checksum: entry.checksum })),
    };

    if (jsonOutput) {
      outputJson(payload, true);
      return;
    }

    console.log('Database schema reset complete.');
    if (payload.migrations_applied.length > 0) {
      console.log(`Applied ${payload.migrations_applied.length} migration(s).`);
    } else if (noMigrate) {
      console.log('Skipped migration re-apply (--no-migrate).');
    } else {
      console.log('No new migrations to apply.');
    }
    return;
  }

  if (!force && !dangerResetProduction) {
    throw new Error(
      'Reset is destructive.\n' +
      'Add --force for non-production envs, or --danger-reset-production for production envs.',
    );
  }

  const response = await requestJson<{
    reset: boolean;
    migrations_applied: Array<{ name: string; checksum: string; applied_at: string }>;
  }>(
    context,
    `/projects/${target.projectId}/envs/${target.envName}/db/reset`,
    {
      method: 'POST',
      body: {
        no_migrate: noMigrate,
        force,
        danger_reset_production: dangerResetProduction,
        skip_snapshot: skipSnapshot,
        ...(noMigrate ? {} : { migrations }),
      },
    },
  );

  if (jsonOutput) {
    outputJson(response, true);
    return;
  }

  console.log('Database schema reset complete.');
  if (response.migrations_applied.length > 0) {
    console.log(`Applied ${response.migrations_applied.length} migration(s).`);
  } else if (noMigrate) {
    console.log('Skipped migration re-apply (--no-migrate).');
  } else {
    console.log('No new migrations to apply.');
  }
}

async function handleWipe(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const nextFlags: Record<string, FlagValue> = {
    ...flags,
    'no-migrate': true,
  };
  await handleReset(positionals, nextFlags, context, jsonOutput);
}

function handleNew(
  positionals: string[],
  flags: Record<string, FlagValue>,
): void {
  const description = positionals[0] ?? getStringFlag(flags, ['name']);

  if (!description) {
    throw new Error('Usage: eve db new <description>\nExample: eve db new create_users');
  }

  // Validate description format
  const normalizedDescription = description.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!normalizedDescription || !/^[a-z0-9_]+$/.test(normalizedDescription)) {
    throw new Error('Description must contain only lowercase letters, numbers, and underscores');
  }

  // Generate timestamp (YYYYMMDDHHmmss in UTC)
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');

  const filename = `${timestamp}_${normalizedDescription}.sql`;
  const migrationsPath = getStringFlag(flags, ['path']) ?? 'db/migrations';
  const fullPath = resolvePath(migrationsPath);

  // Create directory if it doesn't exist
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }

  const filePath = join(fullPath, filename);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Migration file already exists: ${filePath}`);
  }

  const template = `-- Migration: ${normalizedDescription}
-- Created: ${now.toISOString()}

-- Write your SQL migration here

`;

  writeFileSync(filePath, template);
  console.log(`Created: ${filePath}`);
}

async function handleStatus(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/managed`);

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const tenant = response as Record<string, unknown>;
    console.log(`Managed DB Status for ${envName}:\n`);
    console.log(`  ID:          ${tenant.id}`);
    console.log(`  Class:       ${tenant.class}`);
    console.log(`  Status:      ${tenant.status}`);
    console.log(`  DB Name:     ${tenant.db_name}`);
    console.log(`  Instance:    ${tenant.instance_id}`);
    if (tenant.desired_class) {
      console.log(`  Scaling To:  ${tenant.desired_class}`);
    }
    if (Array.isArray(tenant.declared_extensions)) {
      console.log(
        `  Declared Extensions: ${tenant.declared_extensions.length > 0 ? tenant.declared_extensions.join(', ') : '(none)'}`,
      );
    }
    if (Array.isArray(tenant.enabled_extensions)) {
      console.log(
        `  Enabled Extensions:  ${tenant.enabled_extensions.length > 0 ? tenant.enabled_extensions.join(', ') : '(none)'}`,
      );
    }
    if (Array.isArray(tenant.installed_extensions)) {
      const installed = tenant.installed_extensions as Array<{ name?: unknown; version?: unknown }>;
      const label = installed.length > 0
        ? installed.map((extension) => `${extension.name ?? '?'}@${extension.version ?? '?'}`).join(', ')
        : '(none)';
      console.log(`  Installed Extensions: ${label}`);
    }
    if (tenant.installed_extensions_error) {
      console.log(`  Extension Query Error: ${tenant.installed_extensions_error}`);
    }
    if (tenant.last_error_code) {
      console.log(`  Last Error:  [${tenant.last_error_code}] ${tenant.last_error_message}`);
    }
    if (tenant.ready_at) {
      console.log(`  Ready At:    ${tenant.ready_at}`);
    }
    console.log(`  Created:     ${tenant.created_at}`);
    console.log(`  Updated:     ${tenant.updated_at}`);
  }
}

async function handleRotateCredentials(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const response = await requestJson(
    context,
    `/projects/${projectId}/envs/${envName}/db/managed/rotate`,
    { method: 'POST' },
  );

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const result = response as Record<string, unknown>;
    console.log(`${result.message}`);
  }
}

async function handleScale(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const dbClass = getStringFlag(flags, ['class']);

  if (!dbClass) {
    throw new Error('Usage: eve db scale --env <name> --class <db.p1|db.p2|db.p3>');
  }

  const response = await requestJson(
    context,
    `/projects/${projectId}/envs/${envName}/db/managed/scale`,
    { method: 'POST', body: { class: dbClass } },
  );

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const result = response as Record<string, unknown>;
    console.log(`${result.message}`);
  }
}

async function handleDestroy(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);

  if (!toBoolean(flags.force)) {
    throw new Error(
      'This will destroy the managed database permanently.\n' +
      'Add --force to confirm: eve db destroy --env <name> --force',
    );
  }

  const skipSnapshot = toBoolean(flags['skip-snapshot']);
  const params = new URLSearchParams();
  if (skipSnapshot) params.set('skip_snapshot', 'true');
  const qs = params.toString();

  const response = await requestJson(
    context,
    `/projects/${projectId}/envs/${envName}/db/managed${qs ? '?' + qs : ''}`,
    { method: 'DELETE' },
  );

  if (jsonOutput) {
    outputJson(response, jsonOutput);
  } else {
    const result = response as Record<string, unknown>;
    console.log(`${result.message}`);
  }
}

async function handleSnapshot(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  // Sub-routing: show, delete, or create
  const sub = positionals[0];

  if (sub === 'show') {
    const snapshotId = positionals[1] ?? getStringFlag(flags, ['id']);
    if (!snapshotId) {
      throw new Error('Usage: eve db snapshot show <snapshot_id> [--env <name>] [--project <id>]');
    }
    const { projectId, envName } = resolveProjectEnv(positionals.slice(2), flags, context);
    const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/snapshots/${snapshotId}`);
    if (jsonOutput) {
      outputJson(response, true);
    } else {
      printSnapshotDetail(response as Record<string, unknown>);
    }
    return;
  }

  if (sub === 'delete') {
    const snapshotId = positionals[1] ?? getStringFlag(flags, ['id']);
    if (!snapshotId) {
      throw new Error('Usage: eve db snapshot delete <snapshot_id> [--env <name>] [--force]');
    }
    if (!toBoolean(flags.force)) {
      throw new Error('Add --force to confirm snapshot deletion');
    }
    const { projectId, envName } = resolveProjectEnv(positionals.slice(2), flags, context);
    const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/snapshots/${snapshotId}`, {
      method: 'DELETE',
    });
    outputJson(response, jsonOutput, 'Snapshot deleted');
    return;
  }

  if (sub === 'download') {
    const snapshotId = positionals[1] ?? getStringFlag(flags, ['id']);
    if (!snapshotId) {
      throw new Error('Usage: eve db snapshot download <snapshot_id> --output <path> [--env <name>]');
    }
    const outputPath = getStringFlag(flags, ['output', 'o']);
    if (!outputPath) {
      throw new Error('--output <path> is required');
    }
    const { projectId, envName } = resolveProjectEnv(positionals.slice(2), flags, context);
    const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/snapshots/${snapshotId}/download`) as { url: string };
    console.log(`Download URL: ${response.url}`);
    console.log('Use: curl -o <file> "<url>" or wget -O <file> "<url>"');
    return;
  }

  // Default: create snapshot
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const retention = getStringFlag(flags, ['retention']);
  const body: Record<string, unknown> = {};
  if (retention) body.retention = retention;

  const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/snapshots`, {
    method: 'POST',
    body,
  });

  if (jsonOutput) {
    outputJson(response, true);
  } else {
    const snap = response as Record<string, unknown>;
    console.log(`Snapshot: ${snap.id} (${snap.status})`);
    if (snap.s3_key) {
      console.log(`S3 Key: ${snap.s3_key}`);
    }
    console.log(`Trigger: ${snap.trigger}`);
    console.log(`Retention: ${snap.retention}`);
  }
}

async function handleSnapshots(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const status = getStringFlag(flags, ['status']);
  const limit = getStringFlag(flags, ['limit']);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', limit);
  const qs = params.toString();

  const response = await requestJson(
    context,
    `/projects/${projectId}/envs/${envName}/db/snapshots${qs ? '?' + qs : ''}`,
  );

  if (jsonOutput) {
    outputJson(response, true);
  } else {
    const snapshots = response as Array<Record<string, unknown>>;
    if (snapshots.length === 0) {
      console.log('No snapshots found.');
      return;
    }
    const [header, ...rows] = renderTable(
      [
        { header: 'ID', width: 20 },
        { header: 'Trigger', width: 12 },
        { header: 'Status', width: 12 },
        { header: 'Size', width: 11 },
        { header: 'DB Size', width: 11 },
        { header: 'Created' },
      ],
      snapshots.map((snap) => [
        String(snap.id),
        String(snap.trigger),
        String(snap.status),
        snap.size_bytes ? formatBytes(snap.size_bytes as number) : '-',
        snap.db_size_bytes ? formatBytes(snap.db_size_bytes as number) : '-',
        snap.created_at ? new Date(snap.created_at as string).toLocaleString() : '-',
      ]),
    );
    console.log(header);
    console.log('-'.repeat(85));
    for (const row of rows) {
      console.log(row);
    }
  }
}

async function handleRestore(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const snapshotId = getStringFlag(flags, ['snapshot']);

  if (!snapshotId) {
    throw new Error('Usage: eve db restore --env <name> --snapshot <snapshot_id> [--force] [--skip-safety-snapshot]');
  }

  if (!toBoolean(flags.force)) {
    throw new Error(
      'This will overwrite the current database with snapshot data.\n' +
      'Add --force to confirm: eve db restore --env <name> --snapshot <id> --force',
    );
  }

  const body: Record<string, unknown> = {
    snapshot_id: snapshotId,
  };

  const sourceEnv = getStringFlag(flags, ['source-env']);
  const sourceProject = getStringFlag(flags, ['source-project']);
  if (sourceEnv) body.source_env = sourceEnv;
  if (sourceProject) body.source_project = sourceProject;
  if (toBoolean(flags['skip-safety-snapshot'])) body.skip_safety_snapshot = true;

  const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/restore`, {
    method: 'POST',
    body,
  });

  outputJson(response, jsonOutput, 'Restore initiated successfully');
}

async function handleBackupStatus(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  jsonOutput: boolean,
): Promise<void> {
  const { projectId, envName } = resolveProjectEnv(positionals, flags, context);
  const response = await requestJson(context, `/projects/${projectId}/envs/${envName}/db/backup-status`);

  if (jsonOutput) {
    outputJson(response, true);
  } else {
    const status = response as Record<string, unknown>;
    console.log(`Environment: ${envName} (${status.class})`);
    console.log(`Schedule:    ${status.schedule ?? 'none'}`);
    console.log(`Retention:   ${status.retention ?? 'default'}`);
    if (status.last_snapshot_at) {
      console.log(`Last:        ${new Date(status.last_snapshot_at as string).toLocaleString()}`);
    }
    if (status.next_snapshot_at) {
      console.log(`Next:        ${new Date(status.next_snapshot_at as string).toLocaleString()}`);
    }
    console.log(`Snapshots:   ${status.snapshot_count ?? 0} stored`);
    console.log(`Snapshot-on-delete: ${status.snapshot_on_delete ? 'enabled' : 'disabled'}`);
    console.log(`Snapshot-on-reset:  ${status.snapshot_on_reset ? 'enabled' : 'disabled'}`);
  }
}

function printSnapshotDetail(snap: Record<string, unknown>): void {
  console.log(`Snapshot: ${snap.id}\n`);
  console.log(`  Status:      ${snap.status}`);
  console.log(`  Trigger:     ${snap.trigger}`);
  if (snap.size_bytes) console.log(`  Size:        ${formatBytes(snap.size_bytes as number)}`);
  if (snap.db_size_bytes) console.log(`  DB Size:     ${formatBytes(snap.db_size_bytes as number)}`);
  if (snap.pg_version) console.log(`  PG Version:  ${snap.pg_version}`);
  console.log(`  Retention:   ${snap.retention}`);
  if (snap.expires_at) console.log(`  Expires:     ${new Date(snap.expires_at as string).toLocaleString()}`);
  if (snap.error_message) console.log(`  Error:       ${snap.error_message}`);
  console.log(`  Created:     ${snap.created_at ? new Date(snap.created_at as string).toLocaleString() : '-'}`);
  if (snap.completed_at) console.log(`  Completed:   ${new Date(snap.completed_at as string).toLocaleString()}`);
  if (snap.created_by) console.log(`  Created By:  ${snap.created_by}`);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

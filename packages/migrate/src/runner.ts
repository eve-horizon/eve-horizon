import postgres from 'postgres';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const MIGRATION_REGEX = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export interface MigrationInput {
  name: string;
  sql: string;
}

export interface MigrateOptions {
  connectionUrl: string;
  migrationsDir?: string;
  migrations?: MigrationInput[];
}

export interface MigrationResult {
  filename: string;
  applied: boolean;
  checksum: string;
}

export interface MigrationStatus {
  filename: string;
  checksum: string;
  appliedAt: string;
}

interface AppliedMigration {
  name: string;
  checksum: string;
}

interface AppliedMigrationRow extends AppliedMigration {
  applied_at: Date;
}

function loadMigrationsFromDir(migrationsDir: string): MigrationInput[] {
  const stat = statSync(migrationsDir);
  if (!stat.isDirectory()) {
    throw new Error(`${migrationsDir} is not a directory`);
  }

  const files = readdirSync(migrationsDir)
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
    sql: readFileSync(join(migrationsDir, file), 'utf-8'),
  }));
}

function normalizeMigrations(options: MigrateOptions): MigrationInput[] {
  if (Array.isArray(options.migrations)) {
    if (options.migrations.length === 0) {
      return [];
    }
    const sorted = [...options.migrations].sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of sorted) {
      if (!MIGRATION_REGEX.test(migration.name)) {
        throw new Error(
          `Invalid migration filename: ${migration.name}\n` +
            'Expected format: YYYYMMDDHHmmss_description.sql\n' +
            'Example: 20260128100000_create_users.sql',
        );
      }
    }
    return sorted;
  }

  if (!options.migrationsDir) {
    throw new Error('migrationsDir is required when migrations are not provided');
  }

  return loadMigrationsFromDir(options.migrationsDir);
}

async function ensureMigrationsTable(db: ReturnType<typeof postgres>): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function ensureExtensions(db: ReturnType<typeof postgres>): Promise<void> {
  console.log('Ensuring optional migration prerequisites...');
  await db`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await db`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
}

export async function listMigrations(options: MigrateOptions): Promise<MigrationStatus[]> {
  const db = postgres(options.connectionUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    const [table] = await db<{ name: string | null }[]>`
      SELECT to_regclass('schema_migrations') as name
    `;

    if (!table?.name) {
      return [];
    }

    const rows = await db<AppliedMigrationRow[]>`
      SELECT name, checksum, applied_at
      FROM schema_migrations
      ORDER BY applied_at ASC
    `;

    return rows.map((row) => ({
      filename: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at.toISOString(),
    }));
  } finally {
    await db.end();
  }
}

export async function applyMigrations(options: MigrateOptions): Promise<MigrationResult[]> {
  const migrations = normalizeMigrations(options);
  const db = postgres(options.connectionUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    await ensureMigrationsTable(db);
    await ensureExtensions(db);

    const appliedRows = await db<AppliedMigration[]>`
      SELECT name, checksum
      FROM schema_migrations
      ORDER BY name
    `;
    const appliedMap = new Map(appliedRows.map((row) => [row.name, row.checksum]));

    const results: MigrationResult[] = [];
    const isBaseline = appliedMap.size === 0;
    console.log(`Running ${migrations.length} migration file(s) from directory: ${options.migrationsDir ?? '(inline)'}`);

    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existingChecksum = appliedMap.get(migration.name);

      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(
            `Migration ${migration.name} has been modified after being applied.\n` +
              `Expected checksum: ${existingChecksum}\n` +
              `Current checksum:  ${checksum}`,
          );
        }
        results.push({
          filename: migration.name,
          applied: false,
          checksum,
        });
        continue;
      }

      try {
        await db.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
            [migration.name, checksum],
          );
        });
      } catch (error: unknown) {
        // Auto-baseline: if no migrations were previously tracked and the
        // SQL fails because objects already exist, record the migration as
        // applied rather than failing.  This handles the common case where
        // a database was bootstrapped outside the migration tool.
        const msg = error instanceof Error ? error.message : String(error);
        const isAlreadyExists = /already exists/i.test(msg);
        if (isBaseline && isAlreadyExists) {
          console.log(`  → ${migration.name} (baselined — schema already present)`);
          await db`
            INSERT INTO schema_migrations (name, checksum)
            VALUES (${migration.name}, ${checksum})
          `;
          results.push({ filename: migration.name, applied: true, checksum });
          continue;
        }
        throw error;
      }

      results.push({
        filename: migration.name,
        applied: true,
        checksum,
      });
    }

    return results;
  } finally {
    await db.end();
  }
}

export async function resetSchema(connectionUrl: string): Promise<void> {
  const db = postgres(connectionUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    await db.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  } finally {
    await db.end();
  }
}

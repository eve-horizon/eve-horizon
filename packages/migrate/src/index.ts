#!/usr/bin/env node
import { applyMigrations } from './runner.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export * from './runner.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const migrationsDir = process.env.MIGRATIONS_DIR || '/migrations';

  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  try {
    console.log('Connecting to database...');
    const results = await applyMigrations({
      connectionUrl: databaseUrl,
      migrationsDir,
    });

    const appliedCount = results.filter((result) => result.applied).length;
    const skippedCount = results.length - appliedCount;

    if (results.length === 0) {
      console.log('No migration files found');
      return;
    }

    console.log('\nMigration complete:');
    console.log(`  Applied: ${appliedCount}`);
    console.log(`  Skipped: ${skippedCount} (already applied)`);
    console.log(`  Total:   ${results.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nMigration failed: ${message}`);
    process.exit(1);
  }
}

const scriptPath = (process.argv[1] ?? '').replace(/\\/g, '/');
const scriptUrl = process.argv[1] ? pathToFileURL(path.resolve(scriptPath)).href : '';
const invokedAsCli = import.meta.url === scriptUrl;

if (invokedAsCli) {
  void main();
}

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const db = createDb(databaseUrl);

  // Ensure migrations table exists
  await db`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Get applied migrations
  const applied = await db<{ name: string }[]>`
    SELECT name FROM _migrations ORDER BY id
  `;
  const appliedSet = new Set(applied.map(m => m.name));

  // Read migration files - __dirname is dist/, so go up one level to migrations/
  const migrationsDir = join(__dirname, '../migrations');
  let files: string[];
  try {
    files = (await readdir(migrationsDir))
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    console.log(`No migrations directory found at ${migrationsDir}`);
    await db.end();
    return;
  }

  // Apply new migrations
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    console.log(`Applying ${file}...`);
    const sql = await readFile(join(migrationsDir, file), 'utf-8');

    await db.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx.unsafe(`INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
    });

    console.log(`Applied ${file}`);
  }

  await db.end();
  console.log('Migrations complete');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

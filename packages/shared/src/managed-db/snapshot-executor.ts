import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ObjectStorageClient } from '../storage/index.js';

export interface SnapshotExecutorConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface SnapshotUploadTarget {
  client: ObjectStorageClient;
  bucket: string;
  key: string;
}

export interface SnapshotResult {
  sizeBytes: number;
  dbSizeBytes: number;
  pgVersion: string;
}

/**
 * Execute pg_dump and stream output directly to object storage.
 * Returns the compressed dump size and DB metadata.
 */
export async function executeSnapshot(
  dbConfig: SnapshotExecutorConfig,
  target: SnapshotUploadTarget,
  opts?: { timeoutMs?: number },
): Promise<SnapshotResult> {
  const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000; // 30 minutes default

  // Get DB size and PG version before dump
  const [dbSizeBytes, pgVersion] = await Promise.all([
    queryDbSize(dbConfig),
    queryPgVersion(dbConfig),
  ]);

  const args = [
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-acl',
    `--dbname=${dbConfig.database}`,
    `--host=${dbConfig.host}`,
    `--port=${dbConfig.port}`,
    `--username=${dbConfig.username}`,
  ];

  const child = spawn('pg_dump', args, {
    env: { ...process.env, PGPASSWORD: dbConfig.password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Listen for exit/error from spawn time: a spawn failure (e.g. pg_dump not
  // installed) emits 'error' with no 'exit', and an unhandled 'error' event
  // would crash the whole process. The spawn failure also tears down stdout,
  // which makes the upload reject with an unrelated stream error — so the
  // process error is recorded and preferred over whatever surfaces first.
  let processError: Error | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      processError =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('pg_dump is not installed in this container')
          : err;
      resolve(-1);
    });
  });

  // Set up timeout
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);

  try {
    // Stream pg_dump stdout directly to object storage
    const sizeBytes = await target.client.uploadStream(
      target.bucket,
      target.key,
      child.stdout,
      'application/octet-stream',
    );

    clearTimeout(timer);

    // Wait for child process to exit
    const exitCode = await exitPromise;

    if (processError) throw processError;
    if (exitCode !== 0) {
      throw new Error(`pg_dump exited with code ${exitCode}: ${stderr.trim()}`);
    }

    return { sizeBytes, dbSizeBytes, pgVersion };
  } catch (error) {
    clearTimeout(timer);
    child.kill('SIGTERM');
    throw processError ?? error;
  }
}

/**
 * Execute pg_restore from an object storage snapshot into a target database.
 */
export async function executeRestore(
  dbConfig: SnapshotExecutorConfig,
  source: SnapshotUploadTarget,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000;

  // Download from object storage
  const stream = await source.client.getObjectStream(source.bucket, source.key);

  const args = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--clean',
    '--if-exists',
    `--dbname=${dbConfig.database}`,
    `--host=${dbConfig.host}`,
    `--port=${dbConfig.port}`,
    `--username=${dbConfig.username}`,
  ];

  const child = spawn('pg_restore', args, {
    env: { ...process.env, PGPASSWORD: dbConfig.password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Listen for exit/error from spawn time (see executeSnapshot).
  let processError: Error | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      processError =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('pg_restore is not installed in this container')
          : err;
      resolve(-1);
    });
  });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);

  try {
    // Pipe storage stream to pg_restore stdin
    await pipeline(stream, child.stdin);

    const exitCode = await exitPromise;

    clearTimeout(timer);

    if (processError) throw processError;
    // pg_restore exit code 1 means "warnings" (e.g., "relation does not exist" during --clean)
    // Only fail on exit code 2+ which indicates actual errors
    if (exitCode > 1) {
      throw new Error(`pg_restore exited with code ${exitCode}: ${stderr.trim()}`);
    }
  } catch (error) {
    clearTimeout(timer);
    child.kill('SIGTERM');
    throw processError ?? error;
  }
}

/**
 * Terminate all active connections to a database.
 */
export async function terminateConnections(
  adminConfig: SnapshotExecutorConfig,
  targetDbName: string,
): Promise<void> {
  const { spawn: spawnPsql } = await import('child_process');
  const sql = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${targetDbName}' AND pid <> pg_backend_pid();`;

  const child = spawnPsql('psql', [
    `--host=${adminConfig.host}`,
    `--port=${adminConfig.port}`,
    `--username=${adminConfig.username}`,
    '--no-password',
    '--command', sql,
    adminConfig.database,
  ], {
    env: { ...process.env, PGPASSWORD: adminConfig.password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql terminate connections exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function queryDbSize(config: SnapshotExecutorConfig): Promise<number> {
  return new Promise((resolve, reject) => {
    const sql = `SELECT pg_database_size('${config.database}')::bigint AS size;`;
    const child = spawn('psql', [
      `--host=${config.host}`,
      `--port=${config.port}`,
      `--username=${config.username}`,
      '--no-password',
      '--tuples-only',
      '--no-align',
      '--command', sql,
      config.database,
    ], {
      env: { ...process.env, PGPASSWORD: config.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== 0) return resolve(0); // Non-critical, default to 0
      resolve(parseInt(stdout.trim(), 10) || 0);
    });
    child.on('error', () => resolve(0));
  });
}

async function queryPgVersion(config: SnapshotExecutorConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [
      `--host=${config.host}`,
      `--port=${config.port}`,
      `--username=${config.username}`,
      '--no-password',
      '--tuples-only',
      '--no-align',
      '--command', 'SHOW server_version;',
      config.database,
    ], {
      env: { ...process.env, PGPASSWORD: config.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('exit', (code) => {
      if (code !== 0) return resolve('unknown');
      resolve(stdout.trim() || 'unknown');
    });
    child.on('error', () => resolve('unknown'));
  });
}

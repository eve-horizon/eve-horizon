import { createHash } from 'crypto';
import type { ManagedDbTenantStatus } from '../schemas/managed-db.js';
export * from './extensions.js';

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type ManagedDbProvider = 'aws-rds' | 'gcp-cloudsql';

export interface ManagedDbProviderConfig {
  provider: ManagedDbProvider;
  region: string;
  credentials?: Record<string, string>; // Provider-specific auth
}

// ---------------------------------------------------------------------------
// Provider contract — each cloud provider implements this
// ---------------------------------------------------------------------------

export interface ProvisionTenantInput {
  instanceId: string;
  orgId: string;
  projectId: string;
  envId: string;
  serviceName: string;
  dbName: string;
  dbUser: string;
  dbClass: string;
}

export interface ProvisionTenantResult {
  providerTenantId: string;
  connectionUrl: string;
  credential: {
    username: string;
    password: string;
  };
}

export interface TenantStatusResult {
  status: ManagedDbTenantStatus;
  connectionUrl?: string;
  storageUsedBytes?: number;
  connectionCount?: number;
}

export interface RotateCredentialResult {
  credential: {
    username: string;
    password: string;
  };
  connectionUrl: string;
}

export interface ScaleTenantInput {
  currentClass: string;
  desiredClass: string;
}

export interface TenantUsageResult {
  storageUsedBytes: number;
  connectionCount: number;
  cpuUtilizationPercent?: number;
}

export interface ManagedDbProviderContract {
  provisionTenantDb(input: ProvisionTenantInput): Promise<ProvisionTenantResult>;
  getTenantStatus(providerTenantId: string): Promise<TenantStatusResult>;
  rotateTenantCredentials(providerTenantId: string): Promise<RotateCredentialResult>;
  scaleTenantClass(providerTenantId: string, input: ScaleTenantInput): Promise<void>;
  deleteTenantDb(providerTenantId: string): Promise<void>;
  collectTenantUsage(providerTenantId: string): Promise<TenantUsageResult>;
}

// ---------------------------------------------------------------------------
// DB class definitions
// ---------------------------------------------------------------------------

export interface ManagedDbClass {
  name: string;
  label: string;
  maxConnections: number;
  maxStorageGb: number;
  description: string;
}

export const MANAGED_DB_CLASSES: Record<string, ManagedDbClass> = {
  'db.p1': {
    name: 'db.p1',
    label: 'Starter',
    maxConnections: 25,
    maxStorageGb: 10,
    description: 'Shared instance, suitable for development and small production workloads',
  },
  'db.p2': {
    name: 'db.p2',
    label: 'Standard',
    maxConnections: 100,
    maxStorageGb: 50,
    description: 'Shared instance, suitable for production workloads',
  },
  'db.p3': {
    name: 'db.p3',
    label: 'Performance',
    maxConnections: 200,
    maxStorageGb: 200,
    description: 'Dedicated instance, high-performance production workloads',
  },
};

export function getManagedDbClass(className: string): ManagedDbClass | undefined {
  return MANAGED_DB_CLASSES[className];
}

export function isValidManagedDbClass(className: string): boolean {
  return className in MANAGED_DB_CLASSES;
}

// ---------------------------------------------------------------------------
// Tier-based limits (guardrails applied per DB class)
// ---------------------------------------------------------------------------

export interface ManagedDbLimits {
  maxTenantsPerOrg: number;
  maxStorageGb: number;
  maxConnections: number;
  connectionLimitSql: number;    // PG CONNECTION LIMIT for the role
  statementTimeoutMs: number;    // PG statement_timeout
  idleTimeoutMs: number;         // PG idle_in_transaction_session_timeout
}

export const MANAGED_DB_LIMITS: Record<string, ManagedDbLimits> = {
  'db.p1': {
    maxTenantsPerOrg: 3,
    maxStorageGb: 10,
    maxConnections: 25,
    connectionLimitSql: 25,
    statementTimeoutMs: 30_000,
    idleTimeoutMs: 60_000,
  },
  'db.p2': {
    maxTenantsPerOrg: 10,
    maxStorageGb: 50,
    maxConnections: 100,
    connectionLimitSql: 100,
    statementTimeoutMs: 60_000,
    idleTimeoutMs: 120_000,
  },
  'db.p3': {
    maxTenantsPerOrg: 25,
    maxStorageGb: 200,
    maxConnections: 200,
    connectionLimitSql: 200,
    statementTimeoutMs: 120_000,
    idleTimeoutMs: 300_000,
  },
};

export function getManagedDbLimits(className: string): ManagedDbLimits | undefined {
  return MANAGED_DB_LIMITS[className];
}

// ---------------------------------------------------------------------------
// Backup config defaults (class-based)
// ---------------------------------------------------------------------------

/**
 * Resolved backup config ready to write to managed_db_tenants columns.
 * All fields are non-optional — the resolver fills in class-based defaults.
 */
export interface ResolvedBackupConfig {
  backup_schedule: string | null;
  backup_retention: string | null;
  snapshot_on_delete: boolean;
  snapshot_on_reset: boolean;
}

/** Default backup policy for db.p2+ classes */
const PRODUCTION_BACKUP_DEFAULTS: ResolvedBackupConfig = {
  backup_schedule: '0 2 * * *',   // daily at 02:00 UTC
  backup_retention: '30d',
  snapshot_on_delete: true,
  snapshot_on_reset: true,
};

/** Default backup policy for db.p1 (starter tier — no automatic backups) */
const STARTER_BACKUP_DEFAULTS: ResolvedBackupConfig = {
  backup_schedule: null,
  backup_retention: null,
  snapshot_on_delete: false,
  snapshot_on_reset: false,
};

/**
 * Resolve the effective backup config for a managed DB tenant.
 *
 * Priority:
 *  1. Explicit manifest `backup:` block (user intent)
 *  2. Class-based defaults (db.p1 = none, db.p2+ = daily + snapshots)
 *
 * `schedule: false` in the manifest means "explicitly disable scheduled
 * backups" — resolves to backup_schedule = null.
 */
export function resolveBackupConfig(
  dbClass: string,
  manifestBackup?: {
    schedule?: string | false;
    retention?: string;
    snapshot_on_delete?: boolean;
    snapshot_on_reset?: boolean;
  },
): ResolvedBackupConfig {
  const classDefaults = dbClass === 'db.p1'
    ? STARTER_BACKUP_DEFAULTS
    : PRODUCTION_BACKUP_DEFAULTS;

  if (!manifestBackup) {
    return classDefaults;
  }

  // Explicit manifest block overrides class defaults field-by-field
  return {
    backup_schedule: manifestBackup.schedule === false
      ? null
      : (manifestBackup.schedule ?? classDefaults.backup_schedule),
    backup_retention: manifestBackup.retention ?? classDefaults.backup_retention,
    snapshot_on_delete: manifestBackup.snapshot_on_delete ?? classDefaults.snapshot_on_delete,
    snapshot_on_reset: manifestBackup.snapshot_on_reset ?? classDefaults.snapshot_on_reset,
    };
}

// ---------------------------------------------------------------------------
// Snapshot retention helpers
// ---------------------------------------------------------------------------

const MANAGED_DB_CLASS_DEFAULT_RETENTION: Record<string, string> = {
  'db.p1': '7d',
  'db.p2': '30d',
  'db.p3': '90d',
};

const MANAGED_DB_SNAPSHOT_RETENTION_REGEX = /^\s*(\d+)\s*d\s*$/i;

export function normalizeManagedDbSnapshotRetention(retention: string | null | undefined): string | null {
  const match = (retention ?? '').trim().match(MANAGED_DB_SNAPSHOT_RETENTION_REGEX);
  if (!match) {
    return null;
  }

  const days = Number.parseInt(match[1], 10);
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }

  return `${days}d`;
}

export function resolveManagedDbSnapshotRetention(
  requestedRetention: string | undefined,
  opts?: {
    dbClass?: string;
    tenantRetention?: string | null;
    fallbackRetention?: string;
  },
): string {
  if (requestedRetention !== undefined) {
    const normalizedRequested = normalizeManagedDbSnapshotRetention(requestedRetention);
    if (normalizedRequested) {
      return normalizedRequested;
    }
  }

  const normalizedTenantRetention = normalizeManagedDbSnapshotRetention(opts?.tenantRetention);
  if (normalizedTenantRetention) {
    return normalizedTenantRetention;
  }

  if (opts?.dbClass) {
    const classDefault = MANAGED_DB_CLASS_DEFAULT_RETENTION[opts.dbClass];
    if (classDefault) return classDefault;
  }

  return opts?.fallbackRetention ?? '30d';
}

export function snapshotRetentionToExpiresAt(
  retention: string,
  now: Date = new Date(),
): Date {
  const normalized = normalizeManagedDbSnapshotRetention(retention);
  if (!normalized) {
    throw new Error(`Invalid retention '${retention}'`);
  }

  const match = normalized.match(MANAGED_DB_SNAPSHOT_RETENTION_REGEX);
  const days = match ? Number.parseInt(match[1], 10) : 0;
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

// ---------------------------------------------------------------------------
// Manifest config types
// ---------------------------------------------------------------------------

/** Config block for x-eve.managed in manifest services */
export interface ManagedDbServiceConfig {
  class: string;
  engine: 'postgres';
  engine_version?: string;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

const MAX_PG_IDENTIFIER = 63;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
}

function shortHash(input: string, len = 6): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** Deterministic, collision-safe DB name */
export function generateManagedDbName(
  orgSlug: string,
  projectSlug: string,
  envName: string,
): string {
  const base = `${slugify(orgSlug)}-${slugify(projectSlug)}-${slugify(envName)}`;
  const hash = shortHash(`${orgSlug}/${projectSlug}/${envName}`);
  const name = `${base}-${hash}`;
  return name.slice(0, MAX_PG_IDENTIFIER);
}

/** Deterministic, collision-safe DB user */
export function generateManagedDbUser(
  orgSlug: string,
  projectSlug: string,
  envName: string,
): string {
  const base = `${slugify(orgSlug)}-${slugify(projectSlug)}-${slugify(envName)}-u`;
  const hash = shortHash(`${orgSlug}/${projectSlug}/${envName}/user`);
  const name = `${base}-${hash}`;
  return name.slice(0, MAX_PG_IDENTIFIER);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export * from './placement.js';
export * from './snapshot-storage.js';
export * from './snapshot-executor.js';
export * from './trust/index.js';

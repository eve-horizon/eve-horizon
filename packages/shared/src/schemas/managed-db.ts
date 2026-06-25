import { z } from 'zod';

export const ManagedDbTenantStatusSchema = z.enum([
  'provisioning',
  'ready',
  'modifying',
  'rotating',
  'deleting',
  'failed',
]);

export type ManagedDbTenantStatus = z.infer<typeof ManagedDbTenantStatusSchema>;

export const ManagedDbInstanceStatusSchema = z.enum([
  'available',
  'maintenance',
  'retired',
]);

export type ManagedDbInstanceStatus = z.infer<typeof ManagedDbInstanceStatusSchema>;

export const ManagedDbInstalledExtensionSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export type ManagedDbInstalledExtension = z.infer<typeof ManagedDbInstalledExtensionSchema>;

export const ManagedDbTenantResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  env_id: z.string(),
  service_name: z.string(),
  instance_id: z.string(),
  db_name: z.string(),
  class: z.string(),
  desired_class: z.string().nullable(),
  status: ManagedDbTenantStatusSchema,
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
  declared_extensions: z.array(z.string()),
  enabled_extensions: z.array(z.string()),
  installed_extensions: z.array(ManagedDbInstalledExtensionSchema).optional(),
  installed_extensions_error: z.string().nullable().optional(),
  ready_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ManagedDbTenantResponse = z.infer<typeof ManagedDbTenantResponseSchema>;

export const ManagedDbInstanceResponseSchema = z.object({
  id: z.string(),
  provider: z.string(),
  region: z.string(),
  engine: z.string(),
  engine_version: z.string(),
  instance_class: z.string(),
  status: ManagedDbInstanceStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type ManagedDbInstanceResponse = z.infer<typeof ManagedDbInstanceResponseSchema>;

export const RegisterManagedDbInstanceRequestSchema = z.object({
  provider: z.string().min(1),
  provider_instance_id: z.string().min(1),
  region: z.string().min(1),
  engine: z.string().default('postgres'),
  engine_version: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().default(5432),
  instance_class: z.string().min(1),
  capacity_json: z.record(z.unknown()).optional(),
});

export type RegisterManagedDbInstanceRequest = z.infer<typeof RegisterManagedDbInstanceRequestSchema>;

export const ScaleManagedDbRequestSchema = z.object({
  class: z.string().min(1),
});

export type ScaleManagedDbRequest = z.infer<typeof ScaleManagedDbRequestSchema>;

// ---------------------------------------------------------------------------
// Snapshot schemas
// ---------------------------------------------------------------------------

export const ManagedDbSnapshotTriggerSchema = z.enum([
  'manual',
  'scheduled',
  'pre_delete',
  'pre_reset',
]);

export type ManagedDbSnapshotTrigger = z.infer<typeof ManagedDbSnapshotTriggerSchema>;

export const ManagedDbSnapshotStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
]);

export type ManagedDbSnapshotStatus = z.infer<typeof ManagedDbSnapshotStatusSchema>;

export const ManagedDbSnapshotResponseSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  env_id: z.string(),
  instance_id: z.string(),
  created_by: z.string().nullable(),
  trigger: ManagedDbSnapshotTriggerSchema,
  status: ManagedDbSnapshotStatusSchema,
  s3_bucket: z.string().nullable(),
  s3_key: z.string().nullable(),
  size_bytes: z.number().nullable(),
  db_size_bytes: z.number().nullable(),
  pg_version: z.string().nullable(),
  error_message: z.string().nullable(),
  retention: z.string(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

export type ManagedDbSnapshotResponse = z.infer<typeof ManagedDbSnapshotResponseSchema>;

export const CreateSnapshotRequestSchema = z.object({
  retention: z
    .string()
    .regex(/^\s*\d+\s*d\s*$/, 'Retention must be in days, e.g. "30d"')
    .optional(),
});

export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequestSchema>;

export const RestoreSnapshotRequestSchema = z.object({
  snapshot_id: z.string().min(1),
  source_env: z.string().optional(),
  source_project: z.string().optional(),
  skip_safety_snapshot: z.boolean().optional(),
});

export type RestoreSnapshotRequest = z.infer<typeof RestoreSnapshotRequestSchema>;

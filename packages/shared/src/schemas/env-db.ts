import { z } from 'zod';
import { ManagedDbInstalledExtensionSchema } from './managed-db.js';

export const DbSchemaColumnSchema = z.object({
  name: z.string(),
  data_type: z.string(),
  is_nullable: z.boolean(),
  default_value: z.string().nullable(),
});

export const DbSchemaTableSchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(['table', 'view']),
  columns: z.array(DbSchemaColumnSchema),
});

export const DbSchemaResponseSchema = z.object({
  tables: z.array(DbSchemaTableSchema),
});

export type DbSchemaResponse = z.infer<typeof DbSchemaResponseSchema>;

export const DbPolicySchema = z.object({
  name: z.string(),
  command: z.string(),
  roles: z.array(z.string()),
  using: z.string().nullable(),
  with_check: z.string().nullable(),
});

export const DbRlsTableSchema = z.object({
  schema: z.string(),
  name: z.string(),
  rls_enabled: z.boolean(),
  policies: z.array(DbPolicySchema),
});

export const DbRlsDiagnosticsContextSchema = z.object({
  user_id: z.string().nullable(),
  principal_type: z.enum(['user', 'service_principal']).nullable(),
  org_id: z.string().nullable(),
  project_id: z.string().nullable(),
  env_name: z.string().nullable(),
  group_ids: z.array(z.string()),
  permissions: z.array(z.string()),
});

export const DbRlsDiagnosticsSchema = z.object({
  context: DbRlsDiagnosticsContextSchema,
});

export const DbRlsResponseSchema = z.object({
  tables: z.array(DbRlsTableSchema),
  diagnostics: DbRlsDiagnosticsSchema,
});

export type DbRlsResponse = z.infer<typeof DbRlsResponseSchema>;

export const DbExtensionsResponseSchema = z.object({
  extensions: z.array(ManagedDbInstalledExtensionSchema),
});

export type DbExtensionsResponse = z.infer<typeof DbExtensionsResponseSchema>;

export const DbSqlRequestSchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
  allow_write: z.boolean().optional(),
});

export type DbSqlRequest = z.infer<typeof DbSqlRequestSchema>;

export const DbSqlResponseSchema = z.object({
  rows: z.array(z.unknown()),
  row_count: z.number(),
});

export type DbSqlResponse = z.infer<typeof DbSqlResponseSchema>;

export const DbMigrationInputSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
});

export const DbMigrateRequestSchema = z.object({
  migrations: z.array(DbMigrationInputSchema).min(1),
});

export type DbMigrateRequest = z.infer<typeof DbMigrateRequestSchema>;

export const DbMigrationRecordSchema = z.object({
  name: z.string(),
  checksum: z.string(),
  applied_at: z.string(),
});

export const DbMigrateResponseSchema = z.object({
  applied: z.array(DbMigrationRecordSchema),
});

export type DbMigrateResponse = z.infer<typeof DbMigrateResponseSchema>;

export const DbMigrationsResponseSchema = z.object({
  migrations: z.array(DbMigrationRecordSchema),
});

export type DbMigrationsResponse = z.infer<typeof DbMigrationsResponseSchema>;

export const DbResetRequestSchema = z.object({
  migrations: z.array(DbMigrationInputSchema).optional(),
  no_migrate: z.boolean().optional(),
  force: z.boolean().optional(),
  danger_reset_production: z.boolean().optional(),
  skip_snapshot: z.boolean().optional(),
});

export type DbResetRequest = z.infer<typeof DbResetRequestSchema>;

export const DbResetResponseSchema = z.object({
  reset: z.boolean(),
  migrations_applied: z.array(DbMigrationRecordSchema),
});

export type DbResetResponse = z.infer<typeof DbResetResponseSchema>;

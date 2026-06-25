import { z } from 'zod';

export const AccessScopePrefixesSchema = z.object({
  allow_prefixes: z.array(z.string()).optional(),
  read_only_prefixes: z.array(z.string()).optional(),
}).strict();

export const AccessScopeEnvDbSchema = z.object({
  schemas: z.array(z.string()).optional(),
  tables: z.array(z.string()).optional(),
}).strict();

export const AccessScopeCloudFsSchema = z.object({
  allow_mount_ids: z.array(z.string()).optional(),
}).strict();

export const AccessBindingScopeSchema = z.object({
  orgfs: AccessScopePrefixesSchema.optional(),
  orgdocs: AccessScopePrefixesSchema.optional(),
  envdb: AccessScopeEnvDbSchema.optional(),
  cloud_fs: AccessScopeCloudFsSchema.optional(),
}).strict();

export type AccessBindingScope = z.infer<typeof AccessBindingScopeSchema>;

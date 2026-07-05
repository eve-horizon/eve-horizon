import { z } from 'zod';
import { AccessModeSchema } from './common.js';

// ---------------------------------------------------------------------------
// Mount responses
// ---------------------------------------------------------------------------

export const CloudFsMountResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string().nullable(),
  integration_id: z.string(),
  provider: z.string(),
  root_folder_id: z.string(),
  root_folder_path: z.string().nullable(),
  mode: AccessModeSchema,
  auto_index: z.boolean(),
  label: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CloudFsMountResponse = z.infer<typeof CloudFsMountResponseSchema>;

export const CloudFsMountListResponseSchema = z.object({
  mounts: z.array(CloudFsMountResponseSchema),
});

export type CloudFsMountListResponse = z.infer<typeof CloudFsMountListResponseSchema>;

// ---------------------------------------------------------------------------
// Create mount request
// ---------------------------------------------------------------------------

export const CreateCloudFsMountRequestSchema = z.object({
  integration_id: z.string().min(1).optional(),
  provider: z.string().min(1),
  root_folder_id: z.string().min(1),
  root_folder_path: z.string().optional(),
  project_id: z.string().optional(),
  mode: AccessModeSchema.default('read_write'),
  auto_index: z.boolean().default(true),
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateCloudFsMountRequest = z.infer<typeof CreateCloudFsMountRequestSchema>;

// ---------------------------------------------------------------------------
// Update mount request
// ---------------------------------------------------------------------------

export const UpdateCloudFsMountRequestSchema = z.object({
  mode: AccessModeSchema.optional(),
  auto_index: z.boolean().optional(),
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UpdateCloudFsMountRequest = z.infer<typeof UpdateCloudFsMountRequestSchema>;

// ---------------------------------------------------------------------------
// File entry (from browsing)
// ---------------------------------------------------------------------------

export const CloudFsEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().nullable(),
  modified_at: z.string(),
  web_url: z.string(),
  is_folder: z.boolean(),
});

export type CloudFsEntry = z.infer<typeof CloudFsEntrySchema>;

// ---------------------------------------------------------------------------
// Browse response
// ---------------------------------------------------------------------------

export const CloudFsBrowseResponseSchema = z.object({
  mount_id: z.string(),
  path: z.string(),
  entries: z.array(CloudFsEntrySchema),
  next_page_token: z.string().optional(),
  truncated: z.boolean().optional(),
});

export type CloudFsBrowseResponse = z.infer<typeof CloudFsBrowseResponseSchema>;

// ---------------------------------------------------------------------------
// Browse/search request (query params)
// ---------------------------------------------------------------------------

export const CloudFsOrderBySchema = z.enum(['name', 'name_desc', 'modified', 'modified_desc']);

export type CloudFsOrderBy = z.infer<typeof CloudFsOrderBySchema>;

const CloudFsQueryBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean().optional()).transform((value) => value ?? false);

const CloudFsQueryNumberSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}, z.coerce.number().int().optional());

export const CloudFsBrowseRequestSchema = z.object({
  mount_id: z.string().optional(),
  path: z.string().default('/'),
  recursive: CloudFsQueryBooleanSchema,
  page_token: z.string().optional(),
  page_size: CloudFsQueryNumberSchema,
  order_by: CloudFsOrderBySchema.optional(),
}).superRefine((request, ctx) => {
  if (request.recursive && request.page_token) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['page_token'],
      message: 'page_token cannot be used with recursive browse',
    });
  }
});

export type CloudFsBrowseRequest = z.infer<typeof CloudFsBrowseRequestSchema>;

export const CloudFsSearchRequestSchema = z.object({
  q: z.string().min(1),
  mount_id: z.string().optional(),
  mime_type: z.string().optional(),
  page_token: z.string().optional(),
  page_size: CloudFsQueryNumberSchema,
  order_by: CloudFsOrderBySchema.optional(),
});

export type CloudFsSearchRequest = z.infer<typeof CloudFsSearchRequestSchema>;

export const CloudFsSearchResponseSchema = z.object({
  mount_id: z.string(),
  entries: z.array(CloudFsEntrySchema),
  next_page_token: z.string().optional(),
});

export type CloudFsSearchResponse = z.infer<typeof CloudFsSearchResponseSchema>;

import { z } from 'zod';

export const OrgFsSyncModeSchema = z.enum(['two_way', 'push_only', 'pull_only']);
export type OrgFsSyncMode = z.infer<typeof OrgFsSyncModeSchema>;

export const OrgFsLinkStatusSchema = z.enum(['active', 'paused', 'revoked']);
export type OrgFsLinkStatus = z.infer<typeof OrgFsLinkStatusSchema>;

export const OrgFsDeviceStatusSchema = z.enum(['active', 'revoked']);
export type OrgFsDeviceStatus = z.infer<typeof OrgFsDeviceStatusSchema>;

export const OrgFsEventSourceSideSchema = z.enum(['local', 'remote', 'system']);
export type OrgFsEventSourceSide = z.infer<typeof OrgFsEventSourceSideSchema>;

export const OrgFsOwnerPrincipalTypeSchema = z.enum(['user', 'service_principal', 'system']);
export type OrgFsOwnerPrincipalType = z.infer<typeof OrgFsOwnerPrincipalTypeSchema>;

export const OrgFsLinkScopeSchema = z.object({
  allow_prefixes: z.array(z.string().min(1)),
  read_only_prefixes: z.array(z.string().min(1)).optional(),
}).passthrough();
export type OrgFsLinkScope = z.infer<typeof OrgFsLinkScopeSchema>;

export const ORG_FS_MARKDOWN_DEFAULT_INCLUDES = [
  '**/*.md',
  '**/*.mdx',
  '**/*.txt',
  '**/*.yaml',
  '**/*.yml',
] as const;

export const ORG_FS_MARKDOWN_DEFAULT_EXCLUDES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.DS_Store',
  '**/*.png',
  '**/*.jpg',
  '**/*.zip',
] as const;

export const OrgFsDeviceSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  device_name: z.string(),
  platform: z.string().nullable(),
  client_version: z.string().nullable(),
  public_key: z.string(),
  status: OrgFsDeviceStatusSchema,
  last_seen_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OrgFsDevice = z.infer<typeof OrgFsDeviceSchema>;

export const OrgFsEnrollmentSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  gateway_url: z.string().url(),
});
export type OrgFsEnrollment = z.infer<typeof OrgFsEnrollmentSchema>;

export const OrgFsEnrollDeviceRequestSchema = z.object({
  device_name: z.string().min(1),
  platform: z.string().optional(),
  client_version: z.string().optional(),
  public_key: z.string().optional(),
});
export type OrgFsEnrollDeviceRequest = z.infer<typeof OrgFsEnrollDeviceRequestSchema>;

export const OrgFsEnrollDeviceResponseSchema = z.object({
  device: OrgFsDeviceSchema,
  enrollment: OrgFsEnrollmentSchema,
});
export type OrgFsEnrollDeviceResponse = z.infer<typeof OrgFsEnrollDeviceResponseSchema>;

export const OrgFsLinkSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  device_id: z.string(),
  owner_principal_type: OrgFsOwnerPrincipalTypeSchema,
  owner_principal_id: z.string().nullable(),
  mode: OrgFsSyncModeSchema,
  status: OrgFsLinkStatusSchema,
  local_path: z.string(),
  remote_path: z.string(),
  scope_json: OrgFsLinkScopeSchema,
  includes: z.array(z.string()),
  excludes: z.array(z.string()),
  last_cursor: z.number().int().nonnegative(),
  lag_ms: z.number().int().nonnegative().nullable().optional(),
  backlog: z.number().int().nonnegative().optional(),
  last_synced_at: z.string().nullable(),
  last_heartbeat_at: z.string().nullable(),
  updated_at: z.string(),
  created_at: z.string(),
});
export type OrgFsLink = z.infer<typeof OrgFsLinkSchema>;

export const OrgFsCreateLinkRequestSchema = z.object({
  device_id: z.string().min(1),
  mode: OrgFsSyncModeSchema.default('two_way'),
  local_path: z.string().min(1),
  remote_path: z.string().min(1).default('/'),
  allow_prefixes: z.array(z.string().min(1)).min(1).optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});
export type OrgFsCreateLinkRequest = z.infer<typeof OrgFsCreateLinkRequestSchema>;

export const OrgFsLinkGatewayTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  header: z.string().default('x-eve-internal-token'),
  link_id: z.string(),
  mode: OrgFsSyncModeSchema,
  allow_prefixes: z.array(z.string()),
});
export type OrgFsLinkGatewayToken = z.infer<typeof OrgFsLinkGatewayTokenSchema>;

export const OrgFsCreateLinkResponseSchema = z.object({
  link: OrgFsLinkSchema,
  runtime: z.object({
    sync_engine: z.literal('syncthing'),
    profile: z.string(),
    gateway: OrgFsLinkGatewayTokenSchema,
  }),
});
export type OrgFsCreateLinkResponse = z.infer<typeof OrgFsCreateLinkResponseSchema>;

export const OrgFsRotateLinkTokenResponseSchema = z.object({
  gateway: OrgFsLinkGatewayTokenSchema,
});
export type OrgFsRotateLinkTokenResponse = z.infer<typeof OrgFsRotateLinkTokenResponseSchema>;

export const OrgFsListLinksResponseSchema = z.object({
  data: z.array(OrgFsLinkSchema),
});
export type OrgFsListLinksResponse = z.infer<typeof OrgFsListLinksResponseSchema>;

export const OrgFsUpdateLinkRequestSchema = z.object({
  mode: OrgFsSyncModeSchema.optional(),
  status: OrgFsLinkStatusSchema.optional(),
  allow_prefixes: z.array(z.string().min(1)).min(1).optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required',
});
export type OrgFsUpdateLinkRequest = z.infer<typeof OrgFsUpdateLinkRequestSchema>;

export const OrgFsDeleteLinkResponseSchema = z.object({
  success: z.boolean(),
});
export type OrgFsDeleteLinkResponse = z.infer<typeof OrgFsDeleteLinkResponseSchema>;

export const OrgFsStatusResponseSchema = z.object({
  org_id: z.string(),
  gateway: z.object({
    status: z.enum(['healthy', 'degraded', 'offline']),
    last_heartbeat_at: z.string().nullable(),
  }),
  links: z.object({
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
  }),
  events: z.object({
    latest_seq: z.number().int().nonnegative(),
  }),
});
export type OrgFsStatusResponse = z.infer<typeof OrgFsStatusResponseSchema>;

export const OrgFsEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_id: z.string(),
  org_id: z.string(),
  link_id: z.string().nullable().optional(),
  device_id: z.string().nullable().optional(),
  event_type: z.string(),
  path: z.string(),
  content_hash: z.string().nullable().optional(),
  size_bytes: z.number().int().nonnegative().nullable().optional(),
  source_side: OrgFsEventSourceSideSchema,
  metadata: z.record(z.unknown()).optional(),
  created_at: z.string(),
  download_url: z.string().nullable().optional(),  // presigned GET URL, included for file.created/file.updated
  storage_key: z.string().nullable().optional(),   // S3 object key, for reference
});
export type OrgFsEvent = z.infer<typeof OrgFsEventSchema>;

export const OrgFsEventListResponseSchema = z.object({
  data: z.array(OrgFsEventSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    next_after_seq: z.number().int().nonnegative().nullable(),
  }),
});
export type OrgFsEventListResponse = z.infer<typeof OrgFsEventListResponseSchema>;

export const OrgFsConflictSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  link_id: z.string().nullable(),
  path: z.string(),
  local_hash: z.string().nullable(),
  remote_hash: z.string().nullable(),
  status: z.enum(['open', 'resolved']),
  resolution: z.enum(['pick_local', 'pick_remote', 'manual']).nullable(),
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
});
export type OrgFsConflict = z.infer<typeof OrgFsConflictSchema>;

export const OrgFsListConflictsResponseSchema = z.object({
  data: z.array(OrgFsConflictSchema),
});
export type OrgFsListConflictsResponse = z.infer<typeof OrgFsListConflictsResponseSchema>;

export const OrgFsResolveConflictRequestSchema = z.object({
  strategy: z.enum(['pick_local', 'pick_remote', 'manual']),
  merged_content: z.string().optional(),
});
export type OrgFsResolveConflictRequest = z.infer<typeof OrgFsResolveConflictRequestSchema>;

export const OrgFsResolveConflictResponseSchema = z.object({
  conflict: OrgFsConflictSchema,
});
export type OrgFsResolveConflictResponse = z.infer<typeof OrgFsResolveConflictResponseSchema>;

export const OrgFsInternalIngestEventRequestSchema = z.object({
  event_id: z.string(),
  link_id: z.string().optional(),
  device_id: z.string().optional(),
  event_type: z.string(),
  path: z.string(),
  content_hash: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  source_side: OrgFsEventSourceSideSchema,
  metadata: z.record(z.unknown()).optional(),
  storage_key: z.string().optional(),   // S3 key; if provided, upserts org_fs_objects
  mime_type: z.string().optional(),     // MIME type; used for org_fs_objects upsert
});
export type OrgFsInternalIngestEventRequest = z.infer<typeof OrgFsInternalIngestEventRequestSchema>;

export const OrgFsInternalHeartbeatRequestSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  backlog: z.number().int().nonnegative().optional(),
  lag_ms: z.number().int().nonnegative().optional(),
});
export type OrgFsInternalHeartbeatRequest = z.infer<typeof OrgFsInternalHeartbeatRequestSchema>;

export const OrgFsInternalMetricsRequestSchema = z.object({
  metrics: z.record(z.unknown()),
});
export type OrgFsInternalMetricsRequest = z.infer<typeof OrgFsInternalMetricsRequestSchema>;

// --- Upload URL ---
export const OrgFsUploadUrlResponseSchema = z.object({
  upload_url: z.string(),
  storage_key: z.string(),
  method: z.literal('PUT'),
  expires_at: z.string(),
  max_bytes: z.number().int().positive(),
});
export type OrgFsUploadUrlResponse = z.infer<typeof OrgFsUploadUrlResponseSchema>;

// --- Download URL ---
export const OrgFsDownloadUrlResponseSchema = z.object({
  download_url: z.string(),
  storage_key: z.string(),
  content_hash: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string(),
  expires_at: z.string(),
});
export type OrgFsDownloadUrlResponse = z.infer<typeof OrgFsDownloadUrlResponseSchema>;

// --- Object metadata ---
export const OrgFsObjectSchema = z.object({
  id: z.string(),
  path: z.string(),
  storage_key: z.string(),
  content_hash: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mime_type: z.string(),
  deleted_at: z.string().nullable().optional(),
  updated_at: z.string(),
  created_at: z.string(),
});
export type OrgFsObject = z.infer<typeof OrgFsObjectSchema>;

export const OrgFsObjectListResponseSchema = z.object({
  data: z.array(OrgFsObjectSchema),
  pagination: z.object({
    limit: z.number().int().positive(),
    next_after: z.string().nullable(),
  }),
});
export type OrgFsObjectListResponse = z.infer<typeof OrgFsObjectListResponseSchema>;

// --- Share tokens ---
export const OrgFsCreateShareRequestSchema = z.object({
  path: z.string().min(1),
  expires_in: z.string().optional(),  // e.g. '7d', '24h', '30m'; null = never expires
  label: z.string().optional(),
});
export type OrgFsCreateShareRequest = z.infer<typeof OrgFsCreateShareRequestSchema>;

export const OrgFsShareSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  path: z.string(),
  label: z.string().nullable(),
  url: z.string(),
  created_by: z.string(),
  expires_at: z.string().nullable(),
  accessed_at: z.string().nullable(),
  access_count: z.number().int().nonnegative(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
export type OrgFsShare = z.infer<typeof OrgFsShareSchema>;

export const OrgFsShareListResponseSchema = z.object({
  data: z.array(OrgFsShareSchema),
});
export type OrgFsShareListResponse = z.infer<typeof OrgFsShareListResponseSchema>;

// --- Public paths ---
export const OrgFsCreatePublicPathRequestSchema = z.object({
  path_prefix: z.string().min(1),
  label: z.string().optional(),
});
export type OrgFsCreatePublicPathRequest = z.infer<typeof OrgFsCreatePublicPathRequestSchema>;

export const OrgFsPublicPathSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  path_prefix: z.string(),
  label: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type OrgFsPublicPath = z.infer<typeof OrgFsPublicPathSchema>;

export const OrgFsPublicPathListResponseSchema = z.object({
  data: z.array(OrgFsPublicPathSchema),
});
export type OrgFsPublicPathListResponse = z.infer<typeof OrgFsPublicPathListResponseSchema>;

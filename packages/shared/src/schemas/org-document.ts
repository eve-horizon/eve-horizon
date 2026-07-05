import { z } from 'zod';
import { DocLifecycleStatusSchema } from './common.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum size of a single org document in bytes (10 MB) */
export const MAX_ORG_DOCUMENT_SIZE = 10_485_760;

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateOrgDocumentRequestSchema = z.object({
  path: z.string().min(1, 'Document path is required'),
  content: z.string().min(1, 'Document content is required'),
  mime_type: z.string().optional().default('text/markdown'),
  project_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  review_due: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
  lifecycle_status: DocLifecycleStatusSchema.optional(),
});

export type CreateOrgDocumentRequest = z.infer<typeof CreateOrgDocumentRequestSchema>;

export const UpdateOrgDocumentRequestSchema = z.object({
  content: z.string().min(1, 'Document content is required'),
  mime_type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  review_due: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  lifecycle_status: DocLifecycleStatusSchema.optional(),
  embedding_model: z.string().nullable().optional(),
  embedding_json: z.record(z.unknown()).nullable().optional(),
  embedded_at: z.string().datetime().nullable().optional(),
});

export type UpdateOrgDocumentRequest = z.infer<typeof UpdateOrgDocumentRequestSchema>;

export const PatchOrgDocumentRequestSchema = z.object({
  operations: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('replace'), search: z.string(), replace: z.string() }),
    z.object({ op: z.literal('append'), content: z.string() }),
    z.object({ op: z.literal('insert_after'), anchor: z.string(), content: z.string() }),
  ])),
});

export type PatchOrgDocumentRequest = z.infer<typeof PatchOrgDocumentRequestSchema>;

// ============================================================================
// Response Schemas
// ============================================================================

/** List response -- metadata only, no content */
export const OrgDocumentResponseSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string().nullable().optional(),
  path: z.string(),
  mime_type: z.string(),
  content_hash: z.string(),
  current_version: z.number().int().optional(),
  latest_mutation_id: z.string().nullable().optional(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.record(z.unknown()).optional(),
  review_due: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  lifecycle_status: DocLifecycleStatusSchema.optional(),
  embedding_model: z.string().nullable().optional(),
  embedding_json: z.record(z.unknown()).nullable().optional(),
  embedded_at: z.string().nullable().optional(),
});

export type OrgDocumentResponse = z.infer<typeof OrgDocumentResponseSchema>;

/** Detail response -- includes content */
export const OrgDocumentDetailResponseSchema = OrgDocumentResponseSchema.extend({
  content: z.string(),
});

export type OrgDocumentDetailResponse = z.infer<typeof OrgDocumentDetailResponseSchema>;

/** Search result response */
export const OrgDocumentSearchResultSchema = z.object({
  documents: z.array(OrgDocumentResponseSchema.extend({
    rank: z.number().optional(),
    headline: z.string().optional(),
  })),
});

export type OrgDocumentSearchResult = z.infer<typeof OrgDocumentSearchResultSchema>;

/** List wrapper */
export const OrgDocumentListResponseSchema = z.object({
  documents: z.array(OrgDocumentResponseSchema),
});

export type OrgDocumentListResponse = z.infer<typeof OrgDocumentListResponseSchema>;

// ============================================================================
// Version history
// ============================================================================

export const OrgDocumentVersionSchema = z.object({
  id: z.string(),
  doc_id: z.string(),
  version: z.number().int(),
  content_hash: z.string(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
  metadata: z.record(z.unknown()).optional(),
  mutation_id: z.string().nullable().optional(),
});

export type OrgDocumentVersion = z.infer<typeof OrgDocumentVersionSchema>;

export const OrgDocumentVersionDetailSchema = OrgDocumentVersionSchema.extend({
  org_id: z.string(),
  project_id: z.string().nullable().optional(),
  path: z.string(),
  mime_type: z.string(),
  content: z.string(),
});

export type OrgDocumentVersionDetail = z.infer<typeof OrgDocumentVersionDetailSchema>;

export const OrgDocumentVersionListResponseSchema = z.object({
  versions: z.array(OrgDocumentVersionSchema),
});

export type OrgDocumentVersionListResponse = z.infer<typeof OrgDocumentVersionListResponseSchema>;

// ============================================================================
// Structured metadata query
// ============================================================================

const MetadataFilterSchema = z.object({
  eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  gte: z.number().optional(),
  lte: z.number().optional(),
  exists: z.boolean().optional(),
  prefix: z.string().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one operator is required',
});

export const OrgDocumentQueryRequestSchema = z.object({
  path_prefix: z.string().optional(),
  where: z.record(MetadataFilterSchema).optional(),
  sort: z.array(z.object({
    field: z.string(),
    direction: z.enum(['asc', 'desc']),
  })).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().nullable().optional(),
});

export type OrgDocumentQueryRequest = z.infer<typeof OrgDocumentQueryRequestSchema>;

export const OrgDocumentQueryResponseSchema = z.object({
  documents: z.array(OrgDocumentResponseSchema),
  pagination: z.object({
    limit: z.number().int(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  }),
});

export type OrgDocumentQueryResponse = z.infer<typeof OrgDocumentQueryResponseSchema>;

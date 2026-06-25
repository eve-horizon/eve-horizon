import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/** Maximum size of a single attachment in bytes (1 MB) */
export const MAX_ATTACHMENT_SIZE = 1_048_576;

/** Maximum total size of all attachments for a single job in bytes (10 MB) */
export const MAX_TOTAL_ATTACHMENTS_SIZE = 10_485_760;

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateJobAttachmentRequestSchema = z.object({
  name: z.string().min(1, 'Attachment name is required'),
  mime_type: z.string().optional().default('text/plain'),
  content: z.string().min(1, 'Attachment content is required'),
});

export type CreateJobAttachmentRequest = z.infer<typeof CreateJobAttachmentRequestSchema>;

// ============================================================================
// Response Schemas
// ============================================================================

/** List response — metadata only, no content */
export const JobAttachmentResponseSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  name: z.string(),
  mime_type: z.string(),
  content_hash: z.string(),
  created_by: z.string().nullable().optional(),
  created_at: z.string(),
});

export type JobAttachmentResponse = z.infer<typeof JobAttachmentResponseSchema>;

/** Detail response — includes content */
export const JobAttachmentDetailResponseSchema = JobAttachmentResponseSchema.extend({
  content: z.string(),
});

export type JobAttachmentDetailResponse = z.infer<typeof JobAttachmentDetailResponseSchema>;

/** List wrapper */
export const JobAttachmentListResponseSchema = z.object({
  attachments: z.array(JobAttachmentResponseSchema),
});

export type JobAttachmentListResponse = z.infer<typeof JobAttachmentListResponseSchema>;

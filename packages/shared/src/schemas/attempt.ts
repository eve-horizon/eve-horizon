import { z } from 'zod';
import { PaginationSchema } from './common.js';
import { ResolvedGitMetadataSchema } from './git-controls.js';

const AttachmentSchema = z.object({
  name: z.string(),
  mime: z.string(),
  content: z.string(),
});

export const CreateAttemptRequestSchema = z.object({});

export const ContinueAttemptRequestSchema = z.object({
  text: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  variant: z.string().optional(),
  retry_process_id: z.string().optional(),
});

export type ContinueAttemptRequest = z.infer<typeof ContinueAttemptRequestSchema>;

export const AttemptResponseSchema = z.object({
  attempt_id: z.string(),
  attempt_number: z.number().int(),
  job_id: z.string(),
  job_number: z.number().int().optional(),
  status: z.string(),
  session_id: z.string().optional(),
  deleted: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  runtime_meta: z.record(z.unknown()).optional(),
  git: ResolvedGitMetadataSchema.optional(),
});

export type AttemptResponse = z.infer<typeof AttemptResponseSchema>;

export const LogEntrySchema = z.object({
  sequence: z.number().int(),
  timestamp: z.string(),
  line: z.record(z.unknown()),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogsResponseSchema = z.object({
  logs: z.array(LogEntrySchema),
});

export type LogsResponse = z.infer<typeof LogsResponseSchema>;

export const AttemptListResponseSchema = z.object({
  data: z.array(AttemptResponseSchema),
  pagination: PaginationSchema,
});

export type AttemptListResponse = z.infer<typeof AttemptListResponseSchema>;

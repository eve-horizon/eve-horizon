import { z } from 'zod';

// ============================================================================
// ChatFile — file attachment from a chat message
// ============================================================================

export const ChatFileSchema = z.object({
  /** Provider file ID */
  id: z.string(),
  /** Original filename */
  name: z.string(),
  /** MIME type */
  mimetype: z.string().optional(),
  /** URL — provider URL initially, then eve-storage:// after resolution */
  url: z.string().optional(),
  /** File size in bytes */
  size: z.number().optional(),
  /** Set after resolveFiles: original provider URL */
  source_url: z.string().optional(),
  /** Set after resolveFiles: provider name */
  source_provider: z.string().optional(),
  /** Set after resolveFiles: eve-storage key */
  storage_key: z.string().optional(),
  /** Set when file resolution failed — reason code (e.g. 'auth_failed', 'content_mismatch') */
  error: z.string().optional(),
});

export type ChatFile = z.infer<typeof ChatFileSchema>;

// ============================================================================
// AttachmentIndex — written to .eve/attachments/index.json by the worker
// ============================================================================

export const AttachmentIndexEntrySchema = z.object({
  /** Provider attachment ID, when available */
  id: z.string().optional(),
  /** Original filename */
  name: z.string(),
  /** Relative path from workspace root */
  path: z.string().nullable(),
  /** MIME type (e.g. application/pdf) */
  mimetype: z.string().optional(),
  /** File size in bytes */
  size: z.number().optional(),
  /** Original provider URL */
  source_url: z.string().optional(),
  /** Provider that supplied this file */
  source_provider: z.string().optional(),
  /** Storage key for re-download/debug */
  storage_key: z.string().optional(),
  /** Error code if file could not be downloaded */
  error: z.string().optional(),
});

export const AttachmentIndexSchema = z.object({
  files: z.array(AttachmentIndexEntrySchema),
});

export type AttachmentIndexEntry = z.infer<typeof AttachmentIndexEntrySchema>;
export type AttachmentIndex = z.infer<typeof AttachmentIndexSchema>;

// ============================================================================
// FileResolveContext — passed to provider.resolveFiles()
// ============================================================================

export interface FileResolveContext {
  orgId: string;
  channelId: string;
  /** Message ts (top-level) or thread root ts (thread replies) */
  messageTs: string;
  accountId: string;
  provider: string;
  /** Get a presigned S3 upload URL from the API */
  getUploadUrl: (key: string, contentType?: string) => Promise<string>;
}

// ============================================================================
// Limits
// ============================================================================

/** Max size per individual chat file (50 MB) */
export const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024;

/** Max total size per message (100 MB) */
export const MAX_CHAT_TOTAL_SIZE = 100 * 1024 * 1024;

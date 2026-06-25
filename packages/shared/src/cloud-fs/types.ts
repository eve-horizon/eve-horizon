/**
 * Cloud FS Provider Abstraction
 *
 * Defines the interface that all cloud file system providers must implement.
 * Google Drive is the first implementation; Box, OneDrive follow the same interface.
 *
 * Note: CloudFsEntry is defined once in ../schemas/cloud-fs.ts (the Zod schema
 * is the single source of truth). This module imports it but does NOT re-export
 * it, since it's already exported via the schemas barrel. This avoids duplicate
 * export errors in the package root index.
 */

import type { CloudFsEntry } from '../schemas/cloud-fs.js';

export interface CloudFsChangeResult {
  changes: Array<{
    file_id: string;
    name: string;
    mime_type: string;
    removed: boolean;
    change_type: 'created' | 'modified' | 'deleted';
  }>;
  next_cursor: string;
  has_more: boolean;
}

export interface CloudFsWatchChannel {
  channel_id: string;
  resource_id: string;
  expiration: string;
}

export interface ListOptions {
  page_size?: number;
  page_token?: string;
  mime_type_filter?: string;
  order_by?: string;
}

export interface CloudFsProvider {
  readonly providerName: string;

  // File operations
  listFiles(
    accessToken: string,
    folderId: string,
    options?: ListOptions,
  ): Promise<{ entries: CloudFsEntry[]; next_page_token?: string }>;

  getFileMetadata(accessToken: string, fileId: string): Promise<CloudFsEntry>;

  downloadFile(
    accessToken: string,
    fileId: string,
  ): Promise<{ stream: ReadableStream; mime_type: string; name: string }>;

  uploadFile(
    accessToken: string,
    parentId: string,
    name: string,
    content: Buffer | ReadableStream,
    mimeType: string,
  ): Promise<CloudFsEntry>;

  moveFile(
    accessToken: string,
    fileId: string,
    newParentId: string,
    newName?: string,
  ): Promise<CloudFsEntry>;

  createFolder(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<CloudFsEntry>;

  deleteFile(accessToken: string, fileId: string): Promise<void>;

  searchFiles(
    accessToken: string,
    rootId: string,
    query: string,
    options?: ListOptions,
  ): Promise<{ entries: CloudFsEntry[]; next_page_token?: string }>;

  // Path resolution
  resolvePath(
    accessToken: string,
    rootId: string,
    path: string,
  ): Promise<string | null>;

  buildPath(
    accessToken: string,
    fileId: string,
    rootId: string,
  ): Promise<string>;

  // Change detection
  getChangesStartToken(
    accessToken: string,
    driveId?: string,
  ): Promise<string>;

  listChanges(
    accessToken: string,
    pageToken: string,
  ): Promise<CloudFsChangeResult>;

  // Token refresh
  refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<{ access_token: string; expires_in: number }>;
}

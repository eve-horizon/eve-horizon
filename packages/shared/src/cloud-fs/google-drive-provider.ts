/**
 * Google Drive Cloud FS Provider
 *
 * Implements CloudFsProvider using the Google Drive REST API v3.
 * Uses raw fetch calls -- no SDK dependency. This follows the project pattern
 * of keeping shared packages lightweight and SDK-free.
 */

import type { CloudFsEntry } from '../schemas/cloud-fs.js';
import type {
  CloudFsProvider,
  CloudFsChangeResult,
  ListOptions,
} from './types.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Standard file fields requested from the Drive API. */
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink,parents';

/**
 * Shared Drive support params. Every files.* call must include
 * supportsAllDrives=true; list/search calls additionally need
 * includeItemsFromAllDrives=true so results include Shared Drive content.
 */
const SHARED_DRIVE_PARAMS = { supportsAllDrives: 'true' };
const SHARED_DRIVE_LIST_PARAMS = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export class DriveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new DriveApiError(
      `Google Drive API error (${context}): HTTP ${response.status} — ${body}`,
      response.status,
      body,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Convert a Google Drive file resource to our CloudFsEntry. */
function toEntry(file: DriveFile, path = ''): CloudFsEntry {
  return {
    id: file.id,
    name: file.name,
    path,
    mime_type: file.mimeType,
    size_bytes: file.size != null ? Number(file.size) : null,
    modified_at: file.modifiedTime ?? new Date().toISOString(),
    web_url: file.webViewLink ?? '',
    is_folder: file.mimeType === FOLDER_MIME,
  };
}

/** Minimal shape of a Google Drive file resource. */
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string | null;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

interface DriveChangeList {
  changes: Array<{
    fileId: string;
    removed: boolean;
    file?: DriveFile;
    changeType?: string;
    time?: string;
  }>;
  nextPageToken?: string;
  newStartPageToken?: string;
}

// ---------------------------------------------------------------------------
// Buffer helpers for multipart upload
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class GoogleDriveProvider implements CloudFsProvider {
  readonly providerName = 'google_drive';

  // -----------------------------------------------------------------------
  // File operations
  // -----------------------------------------------------------------------

  async listFiles(
    accessToken: string,
    folderId: string,
    options?: ListOptions,
  ): Promise<{ entries: CloudFsEntry[]; next_page_token?: string }> {
    const params = new URLSearchParams({
      ...SHARED_DRIVE_LIST_PARAMS,
      q: `'${folderId}' in parents and trashed = false`,
      fields: `files(${FILE_FIELDS}),nextPageToken`,
      pageSize: String(options?.page_size ?? 100),
      orderBy: options?.order_by ?? 'folder,name',
    });

    if (options?.page_token) {
      params.set('pageToken', options.page_token);
    }

    if (options?.mime_type_filter) {
      // Refine the query with a mime type constraint
      const existing = params.get('q')!;
      params.set('q', `${existing} and mimeType = '${options.mime_type_filter}'`);
    }

    const url = `${DRIVE_API}/files?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'listFiles');

    const data = (await response.json()) as DriveFileList;

    const entries = data.files.map((f) => toEntry(f));
    return {
      entries,
      next_page_token: data.nextPageToken ?? undefined,
    };
  }

  async getFileMetadata(
    accessToken: string,
    fileId: string,
  ): Promise<CloudFsEntry> {
    const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: FILE_FIELDS });
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'getFileMetadata');

    const file = (await response.json()) as DriveFile;
    const path = await this.buildPath(accessToken, fileId, 'root');
    return toEntry(file, path);
  }

  async downloadFile(
    accessToken: string,
    fileId: string,
  ): Promise<{ stream: ReadableStream; mime_type: string; name: string }> {
    // First, get metadata to know the name and mime type
    const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'id,name,mimeType' });
    const metaUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const metaResponse = await fetch(metaUrl, { headers: authHeaders(accessToken) });
    await assertOk(metaResponse, 'downloadFile:metadata');

    const meta = (await metaResponse.json()) as DriveFile;

    // Google Workspace documents (Docs, Sheets, Slides) must be exported
    const exportMimeMap: Record<string, string> = {
      'application/vnd.google-apps.document': 'application/pdf',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'application/pdf',
      'application/vnd.google-apps.drawing': 'image/png',
    };

    const exportMime = exportMimeMap[meta.mimeType];

    let downloadUrl: string;
    let resultMime: string;

    if (exportMime) {
      downloadUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?supportsAllDrives=true&mimeType=${encodeURIComponent(exportMime)}`;
      resultMime = exportMime;
    } else {
      downloadUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&alt=media`;
      resultMime = meta.mimeType;
    }

    const response = await fetch(downloadUrl, { headers: authHeaders(accessToken) });
    await assertOk(response, 'downloadFile:content');

    if (!response.body) {
      throw new DriveApiError('downloadFile: response body is null', 0, '');
    }

    return {
      stream: response.body as ReadableStream,
      mime_type: resultMime,
      name: meta.name,
    };
  }

  async uploadFile(
    accessToken: string,
    parentId: string,
    name: string,
    content: Buffer | ReadableStream,
    mimeType: string,
  ): Promise<CloudFsEntry> {
    const contentBuffer = Buffer.isBuffer(content)
      ? content
      : await streamToBuffer(content);

    const boundary = `__eve_cloud_fs_${Date.now()}__`;
    const metadata = JSON.stringify({ name, parents: [parentId] });

    // Build multipart/related body
    const parts = [
      `--${boundary}\r\n`,
      'Content-Type: application/json; charset=UTF-8\r\n\r\n',
      metadata,
      `\r\n--${boundary}\r\n`,
      `Content-Type: ${mimeType}\r\n\r\n`,
    ];

    const preamble = Buffer.from(parts.join(''));
    const epilogue = Buffer.from(`\r\n--${boundary}--`);
    const body = Buffer.concat([preamble, contentBuffer, epilogue]);

    const url = `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.byteLength),
      },
      body,
    });
    await assertOk(response, 'uploadFile');

    const file = (await response.json()) as DriveFile;
    return toEntry(file);
  }

  async moveFile(
    accessToken: string,
    fileId: string,
    newParentId: string,
    newName?: string,
  ): Promise<CloudFsEntry> {
    // First, get current parents so we can remove them
    const metaParams = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'parents' });
    const metaUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${metaParams.toString()}`;
    const metaResponse = await fetch(metaUrl, { headers: authHeaders(accessToken) });
    await assertOk(metaResponse, 'moveFile:getParents');

    const meta = (await metaResponse.json()) as { parents?: string[] };
    const removeParents = (meta.parents ?? []).join(',');

    // Build PATCH request
    const params = new URLSearchParams({
      ...SHARED_DRIVE_PARAMS,
      addParents: newParentId,
      fields: FILE_FIELDS,
    });

    if (removeParents) {
      params.set('removeParents', removeParents);
    }

    const body: Record<string, string> = {};
    if (newName) {
      body.name = newName;
    }

    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    await assertOk(response, 'moveFile');

    const file = (await response.json()) as DriveFile;
    return toEntry(file);
  }

  async createFolder(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<CloudFsEntry> {
    const url = `${DRIVE_API}/files?supportsAllDrives=true&fields=${FILE_FIELDS}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
    });
    await assertOk(response, 'createFolder');

    const file = (await response.json()) as DriveFile;
    return toEntry(file);
  }

  async deleteFile(accessToken: string, fileId: string): Promise<void> {
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: authHeaders(accessToken),
    });
    await assertOk(response, 'deleteFile');
  }

  async searchFiles(
    accessToken: string,
    rootId: string,
    query: string,
    options?: ListOptions,
  ): Promise<{ entries: CloudFsEntry[]; next_page_token?: string }> {
    // Escape single quotes in the user's query for the Drive API query syntax
    const escapedQuery = query.replace(/'/g, "\\'");

    // Build a query that searches within the root folder's tree and matches name
    // Note: Google Drive's `in parents` only searches direct children. For a
    // recursive search we use `fullText contains` or `name contains` combined
    // with a corpora/driveId scope. Here we search by name within the user's
    // files, then filter results whose ancestry includes rootId via buildPath.
    const qParts = [
      `name contains '${escapedQuery}'`,
      'trashed = false',
    ];

    if (options?.mime_type_filter) {
      qParts.push(`mimeType = '${options.mime_type_filter}'`);
    }

    const params = new URLSearchParams({
      ...SHARED_DRIVE_LIST_PARAMS,
      q: qParts.join(' and '),
      fields: `files(${FILE_FIELDS}),nextPageToken`,
      pageSize: String(options?.page_size ?? 50),
      orderBy: options?.order_by ?? 'modifiedTime desc',
    });

    if (options?.page_token) {
      params.set('pageToken', options.page_token);
    }

    const url = `${DRIVE_API}/files?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'searchFiles');

    const data = (await response.json()) as DriveFileList;

    // If rootId is not 'root', filter to files that descend from rootId.
    // This is a post-filter because Drive API doesn't support recursive `in parents`.
    let files = data.files;
    if (rootId !== 'root') {
      const filtered: DriveFile[] = [];
      for (const file of files) {
        const isDescendant = await this.isDescendantOf(accessToken, file.id, rootId);
        if (isDescendant) {
          filtered.push(file);
        }
      }
      files = filtered;
    }

    return {
      entries: files.map((f) => toEntry(f)),
      next_page_token: data.nextPageToken ?? undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Path resolution
  // -----------------------------------------------------------------------

  async resolvePath(
    accessToken: string,
    rootId: string,
    pathStr: string,
  ): Promise<string | null> {
    // Normalize: strip leading/trailing slashes, split into segments
    const segments = pathStr
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      return rootId;
    }

    let currentId = rootId;

    for (const segment of segments) {
      const escapedName = segment.replace(/'/g, "\\'");
      const q = `'${currentId}' in parents and name = '${escapedName}' and trashed = false`;
      const params = new URLSearchParams({
        ...SHARED_DRIVE_LIST_PARAMS,
        q,
        fields: 'files(id,name,mimeType)',
        pageSize: '1',
      });

      const url = `${DRIVE_API}/files?${params.toString()}`;
      const response = await fetch(url, { headers: authHeaders(accessToken) });
      await assertOk(response, `resolvePath:${segment}`);

      const data = (await response.json()) as DriveFileList;
      if (data.files.length === 0) {
        return null; // path segment not found
      }

      currentId = data.files[0].id;
    }

    return currentId;
  }

  async buildPath(
    accessToken: string,
    fileId: string,
    rootId: string,
  ): Promise<string> {
    const segments: string[] = [];
    let currentId = fileId;

    // Walk up the parent chain until we hit rootId or the Drive root.
    // Guard against infinite loops with a depth limit.
    const MAX_DEPTH = 50;

    for (let i = 0; i < MAX_DEPTH; i++) {
      if (currentId === rootId) {
        break;
      }

      const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'id,name,parents' });
      const url = `${DRIVE_API}/files/${encodeURIComponent(currentId)}?${params.toString()}`;
      const response = await fetch(url, { headers: authHeaders(accessToken) });

      if (!response.ok) {
        // If we can't read the parent (permissions, etc.), stop here
        break;
      }

      const file = (await response.json()) as DriveFile;
      segments.unshift(file.name);

      if (!file.parents || file.parents.length === 0) {
        break;
      }

      currentId = file.parents[0];
    }

    return '/' + segments.join('/');
  }

  // -----------------------------------------------------------------------
  // Change detection
  // -----------------------------------------------------------------------

  async getChangesStartToken(
    accessToken: string,
    driveId?: string,
  ): Promise<string> {
    const params = new URLSearchParams();

    if (driveId) {
      params.set('driveId', driveId);
      params.set('supportsAllDrives', 'true');
    }

    const url = `${DRIVE_API}/changes/startPageToken?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'getChangesStartToken');

    const data = (await response.json()) as { startPageToken: string };
    return data.startPageToken;
  }

  async listChanges(
    accessToken: string,
    pageToken: string,
  ): Promise<CloudFsChangeResult> {
    const params = new URLSearchParams({
      pageToken,
      fields: 'changes(fileId,removed,file(id,name,mimeType,modifiedTime),changeType,time),nextPageToken,newStartPageToken',
      pageSize: '100',
      includeRemoved: 'true',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });

    const url = `${DRIVE_API}/changes?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'listChanges');

    const data = (await response.json()) as DriveChangeList;

    const changes = data.changes.map((c) => ({
      file_id: c.fileId,
      name: c.file?.name ?? '',
      mime_type: c.file?.mimeType ?? '',
      removed: c.removed,
      change_type: inferChangeType(c),
    }));

    // The cursor for the next poll is either newStartPageToken (when we've
    // consumed all pages) or nextPageToken (when there are more pages).
    const nextCursor = data.newStartPageToken ?? data.nextPageToken ?? pageToken;

    return {
      changes,
      next_cursor: nextCursor,
      has_more: data.nextPageToken != null,
    };
  }

  // -----------------------------------------------------------------------
  // Token refresh
  // -----------------------------------------------------------------------

  async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await assertOk(response, 'refreshAccessToken');

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      token_type: string;
    };

    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Check whether `fileId` is a descendant of `ancestorId` by walking up
   * the parent chain. Returns true if `fileId === ancestorId`.
   */
  private async isDescendantOf(
    accessToken: string,
    fileId: string,
    ancestorId: string,
  ): Promise<boolean> {
    if (fileId === ancestorId) {
      return true;
    }

    let currentId = fileId;
    const MAX_DEPTH = 50;

    for (let i = 0; i < MAX_DEPTH; i++) {
      const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'parents' });
      const url = `${DRIVE_API}/files/${encodeURIComponent(currentId)}?${params.toString()}`;
      const response = await fetch(url, { headers: authHeaders(accessToken) });

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { parents?: string[] };
      if (!data.parents || data.parents.length === 0) {
        return false;
      }

      const parentId = data.parents[0];
      if (parentId === ancestorId) {
        return true;
      }

      currentId = parentId;
    }

    return false;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function inferChangeType(
  change: DriveChangeList['changes'][number],
): 'created' | 'modified' | 'deleted' {
  if (change.removed) {
    return 'deleted';
  }

  // Drive API v3 doesn't expose a definitive "created vs modified"
  // distinction in the changes feed. We infer: if the change carries a
  // changeType of 'file' and the file exists, treat it as modified. The
  // consuming service can compare against its own index to detect new files.
  return 'modified';
}

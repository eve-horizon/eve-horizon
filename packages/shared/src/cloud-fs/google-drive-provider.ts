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
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Drive's alias for the whole of My Drive; a mount may name it as its root. */
const DRIVE_ROOT_ALIAS = 'root';

/** How many generations of parents a containment check will climb. */
const MAX_ANCESTRY_DEPTH = 64;

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

/** Escape a value for use inside a single-quoted Drive `q` string literal. */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Build a multipart/related body for Drive multipart uploads (create or update). */
function buildMultipartBody(
  metadata: Record<string, unknown>,
  content: Buffer,
  mimeType: string,
): { body: Buffer; contentType: string } {
  const boundary = `__eve_cloud_fs_${Date.now()}__`;
  const preamble = Buffer.from([
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
  ].join(''));
  const epilogue = Buffer.from(`\r\n--${boundary}--`);
  return {
    body: Buffer.concat([preamble, content, epilogue]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
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

    const { body, contentType } = buildMultipartBody({ name, parents: [parentId] }, contentBuffer, mimeType);

    const url = `${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      },
      body,
    });
    await assertOk(response, 'uploadFile');

    const file = (await response.json()) as DriveFile;
    return toEntry(file);
  }

  async updateFileContent(
    accessToken: string,
    fileId: string,
    content: Buffer | ReadableStream,
    mimeType: string,
  ): Promise<CloudFsEntry> {
    const contentBuffer = Buffer.isBuffer(content)
      ? content
      : await streamToBuffer(content);

    // PATCH with media uploads a new revision of the same file: id, link and
    // sharing stay stable and Drive keeps the revision history.
    const { body, contentType } = buildMultipartBody({ mimeType }, contentBuffer, mimeType);

    const url = `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
      },
      body,
    });
    await assertOk(response, 'updateFileContent');

    const file = (await response.json()) as DriveFile;
    return toEntry(file);
  }

  async findFileByName(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<CloudFsEntry | null> {
    // Drive allows same-name siblings. Prefer the most recently modified file so
    // replace-in-place converges on the copy readers already treat as current.
    const params = new URLSearchParams({
      ...SHARED_DRIVE_LIST_PARAMS,
      q: `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and mimeType != '${FOLDER_MIME}' and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc',
      pageSize: '1',
    });

    const url = `${DRIVE_API}/files?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'findFileByName');

    const data = (await response.json()) as DriveFileList;
    const file = data.files[0];
    return file ? toEntry(file) : null;
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

  async trashFile(accessToken: string, fileId: string): Promise<void> {
    // files.delete is permanent in Drive v3; trashing is recoverable (~30 days).
    const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'id,trashed' });
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    await assertOk(response, 'trashFile');
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

    // If rootId is not the whole-drive alias, keep only files inside rootId.
    // This is a post-filter because Drive API doesn't support recursive `in parents`.
    let files = data.files;
    if (rootId !== DRIVE_ROOT_ALIAS) {
      const filtered: DriveFile[] = [];
      for (const file of files) {
        if (await this.isWithinRoot(accessToken, file.id, rootId)) {
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
  // Containment
  // -----------------------------------------------------------------------

  /**
   * Whether a mount rooted at `rootId` may operate on `fileId`: the root
   * itself, or a real node somewhere beneath it.
   *
   * Drive is a DAG, not a tree — a file may have several parents — so every
   * parent is climbed breadth-first, each node fetched at most once, until the
   * root appears in a parents list or MAX_ANCESTRY_DEPTH generations have been
   * examined. The root is recognised in its children's parents lists, so a
   * file directly beneath it costs a single lookup and the root is never
   * fetched.
   *
   * A shortcut is never contained: it is a pointer whose target may live
   * anywhere, and the target is never followed here.
   *
   * The `root` alias names the whole of My Drive, so anything the account can
   * read is inside it; one lookup settles existence and the shortcut rule.
   *
   * An unreadable target surfaces as a DriveApiError so callers can map it
   * like any other Drive failure. An unreadable ancestor is a dead end, not an
   * error — a file shared directly with the account often sits in a folder it
   * cannot see.
   */
  async isWithinRoot(
    accessToken: string,
    fileId: string,
    rootId: string,
  ): Promise<boolean> {
    if (fileId === rootId) {
      return true;
    }

    const target = await this.fetchAncestryNode(accessToken, fileId);
    if (target.mimeType === SHORTCUT_MIME) {
      return false;
    }
    if (rootId === DRIVE_ROOT_ALIAS) {
      return true;
    }

    const visited = new Set<string>([fileId]);
    let frontier = target.parents ?? [];

    for (let depth = 1; depth <= MAX_ANCESTRY_DEPTH && frontier.length > 0; depth++) {
      if (frontier.includes(rootId)) {
        return true;
      }

      const next: string[] = [];
      for (const parentId of frontier) {
        if (visited.has(parentId)) {
          continue;
        }
        visited.add(parentId);

        try {
          const parent = await this.fetchAncestryNode(accessToken, parentId);
          next.push(...(parent.parents ?? []));
        } catch (err) {
          if (!(err instanceof DriveApiError)) {
            throw err;
          }
        }
      }
      frontier = next;
    }

    return false;
  }

  /** The least a climb needs to know about a node: what it is and where it sits. */
  private async fetchAncestryNode(
    accessToken: string,
    fileId: string,
  ): Promise<Pick<DriveFile, 'mimeType' | 'parents'>> {
    const params = new URLSearchParams({ ...SHARED_DRIVE_PARAMS, fields: 'id,mimeType,parents' });
    const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    await assertOk(response, 'isWithinRoot');
    return (await response.json()) as DriveFile;
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

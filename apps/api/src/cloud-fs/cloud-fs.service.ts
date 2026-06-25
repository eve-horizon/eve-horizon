import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { Db } from '@eve/db';
import { cloudFsMountQueries, integrationQueries, oauthAppConfigQueries } from '@eve/db';
import {
  generateCloudFsMountId,
  createJsonLogger,
  GoogleDriveProvider,
  DriveApiError,
  type CloudFsProvider,
  type CloudFsEntry,
  type CloudFsOrderBy,
  type CreateCloudFsMountRequest,
  type UpdateCloudFsMountRequest,
  type CloudFsMountResponse,
  type CloudFsBrowseResponse,
  type CloudFsSearchResponse,
  type ListOptions,
} from '@eve/shared';

const logger = createJsonLogger('api');
const MAX_PAGE_SIZE = 1000;
const DEFAULT_RECURSIVE_ENTRY_LIMIT = 5000;
const DEFAULT_RECURSIVE_DEPTH_LIMIT = 50;

interface CloudFsBrowseOptions {
  recursive?: boolean;
  pageToken?: string;
  pageSize?: number;
  orderBy?: CloudFsOrderBy;
}

interface CloudFsSearchOptions {
  pageToken?: string;
  pageSize?: number;
  orderBy?: CloudFsOrderBy;
  mimeType?: string;
}

interface ResolvedCloudFsMount {
  id: string;
  org_id: string;
  project_id: string | null;
  integration_id: string;
  provider: string;
  root_folder_id: string;
  root_folder_path: string | null;
  mode: string;
  auto_index: boolean;
  label: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RecursiveQueueItem {
  folderId: string;
  path: string;
  depth: number;
}

@Injectable()
export class CloudFsService {
  private mounts: ReturnType<typeof cloudFsMountQueries>;
  private integrations: ReturnType<typeof integrationQueries>;
  private oauthAppConfigs: ReturnType<typeof oauthAppConfigQueries>;
  private providers = new Map<string, CloudFsProvider>();

  constructor(@Inject('DB') private readonly db: Db) {
    this.mounts = cloudFsMountQueries(db);
    this.integrations = integrationQueries(db);
    this.oauthAppConfigs = oauthAppConfigQueries(db);
    this.providers.set('google_drive', new GoogleDriveProvider());
  }

  // ── Mount CRUD ──────────────────────────────────────────────────────────

  async listMounts(orgId: string, projectId?: string): Promise<CloudFsMountResponse[]> {
    const rows = projectId
      ? await this.mounts.listByProject(orgId, projectId)
      : await this.mounts.listByOrg(orgId);
    return rows.map(r => this.toMountResponse(r));
  }

  async getMount(id: string, orgId: string): Promise<CloudFsMountResponse> {
    const mount = await this.mounts.findById(id);
    if (!mount || mount.org_id !== orgId) throw new NotFoundException(`Mount ${id} not found`);
    return this.toMountResponse(mount);
  }

  async createMount(orgId: string, payload: CreateCloudFsMountRequest, createdBy?: string): Promise<CloudFsMountResponse> {
    let integrationId = payload.integration_id;

    if (integrationId) {
      // Verify explicit integration exists and belongs to org
      const integration = await this.integrations.findById(integrationId);
      if (!integration || integration.org_id !== orgId) {
        throw new BadRequestException(`Integration ${integrationId} not found in org ${orgId}`);
      }
      if (integration.provider !== payload.provider) {
        throw new BadRequestException(
          `Integration provider (${integration.provider}) doesn't match requested provider (${payload.provider})`,
        );
      }
    } else {
      // Auto-detect: find the first active integration for this provider+org
      const orgIntegrations = await this.integrations.listByOrg(orgId);
      const match = orgIntegrations.find(
        (i: { provider: string; status: string }) => i.provider === payload.provider && i.status === 'active',
      );
      if (!match) {
        throw new BadRequestException(
          `No active ${payload.provider} integration found for this org. Connect one first via OAuth.`,
        );
      }
      integrationId = match.id;
    }

    const mount = await this.mounts.insert({
      id: generateCloudFsMountId(),
      org_id: orgId,
      project_id: payload.project_id ?? null,
      integration_id: integrationId!,
      provider: payload.provider,
      root_folder_id: payload.root_folder_id,
      root_folder_path: payload.root_folder_path ?? null,
      mode: payload.mode ?? 'read_write',
      auto_index: payload.auto_index ?? true,
      changes_cursor: null,
      watch_channel_id: null,
      watch_expiry: null,
      label: payload.label ?? null,
      metadata_json: payload.metadata ?? {},
      created_by: createdBy ?? null,
    });

    logger.log({ event: 'cloud_fs.mount_created', mountId: mount.id, orgId, provider: payload.provider });
    return this.toMountResponse(mount);
  }

  async updateMount(id: string, orgId: string, payload: UpdateCloudFsMountRequest): Promise<CloudFsMountResponse> {
    const existing = await this.mounts.findById(id);
    if (!existing || existing.org_id !== orgId) throw new NotFoundException(`Mount ${id} not found`);

    const updated = await this.mounts.update(id, {
      mode: payload.mode,
      auto_index: payload.auto_index,
      label: payload.label,
      metadata_json: payload.metadata,
    });
    return this.toMountResponse(updated ?? existing);
  }

  async removeMount(id: string, orgId: string): Promise<void> {
    const existing = await this.mounts.findById(id);
    if (!existing || existing.org_id !== orgId) throw new NotFoundException(`Mount ${id} not found`);
    await this.mounts.remove(id);
    logger.log({ event: 'cloud_fs.mount_removed', mountId: id, orgId });
  }

  // ── File operations ─────────────────────────────────────────────────────

  async browse(
    orgId: string,
    mountId: string | undefined,
    path: string,
    options: CloudFsBrowseOptions = {},
  ): Promise<CloudFsBrowseResponse> {
    if (options.recursive && options.pageToken) {
      throw new BadRequestException('page_token cannot be used with recursive browse');
    }

    const mount = await this.resolveMount(orgId, mountId);
    const { provider, accessToken } = await this.getProviderAndToken(mount);
    const displayPath = this.normalizeBrowsePath(path);

    try {
      // Resolve path to folder ID
      let folderId = mount.root_folder_id;
      if (displayPath !== '/') {
        const resolved = await provider.resolvePath(accessToken, mount.root_folder_id, displayPath);
        if (!resolved) throw new NotFoundException(`Path not found: ${displayPath}`);
        folderId = resolved;
      }

      const listOptions = this.toListOptions(mount.provider, options);
      if (options.recursive) {
        return await this.browseRecursive(provider, accessToken, mount.id, folderId, displayPath, listOptions);
      }

      const result = await provider.listFiles(accessToken, folderId, listOptions);

      const entries: CloudFsEntry[] = result.entries.map(e => ({
        ...e,
        path: this.joinCloudFsPath(displayPath, e.name),
      }));

      return { mount_id: mount.id, path: displayPath, entries, next_page_token: result.next_page_token };
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  async search(
    orgId: string,
    mountId: string | undefined,
    query: string,
    options: CloudFsSearchOptions = {},
  ): Promise<CloudFsSearchResponse> {
    const mount = await this.resolveMount(orgId, mountId);
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      const result = await provider.searchFiles(accessToken, mount.root_folder_id, query, this.toListOptions(mount.provider, options));
      return { mount_id: mount.id, entries: result.entries, next_page_token: result.next_page_token };
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  // ── Per-mount file operations ───────────────────────────────────────────

  async browseMount(
    orgId: string,
    mountId: string,
    folderId?: string,
    path?: string,
    options: CloudFsBrowseOptions = {},
  ): Promise<CloudFsBrowseResponse> {
    if (options.recursive && options.pageToken) {
      throw new BadRequestException('page_token cannot be used with recursive browse');
    }

    const mount = await this.resolveMount(orgId, mountId);
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      let targetFolderId = folderId || mount.root_folder_id;
      let displayPath = this.normalizeBrowsePath(path);

      // If a path is provided and no explicit folder_id, resolve path from root
      if (displayPath !== '/' && !folderId) {
        const resolved = await provider.resolvePath(accessToken, mount.root_folder_id, displayPath);
        if (!resolved) throw new NotFoundException(`Path not found: ${displayPath}`);
        targetFolderId = resolved;
      }

      if (folderId && !path) {
        displayPath = this.normalizeBrowsePath(await provider.buildPath(accessToken, targetFolderId, mount.root_folder_id));
      }

      const listOptions = this.toListOptions(mount.provider, options);
      if (options.recursive) {
        return await this.browseRecursive(provider, accessToken, mount.id, targetFolderId, displayPath, listOptions);
      }

      const result = await provider.listFiles(accessToken, targetFolderId, listOptions);
      const entries: CloudFsEntry[] = result.entries.map(e => ({
        ...e,
        path: this.joinCloudFsPath(displayPath, e.name),
      }));

      return { mount_id: mount.id, path: displayPath, entries, next_page_token: result.next_page_token };
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  async getFileMeta(orgId: string, mountId: string, fileId: string): Promise<CloudFsEntry> {
    const mount = await this.resolveMount(orgId, mountId);
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      return await provider.getFileMetadata(accessToken, fileId);
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  async downloadFile(
    orgId: string,
    mountId: string,
    fileId: string,
  ): Promise<{ stream: ReadableStream | Buffer; mime_type: string; size_bytes: number; file_name: string }> {
    const mount = await this.resolveMount(orgId, mountId);
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      const result = await provider.downloadFile(accessToken, fileId);
      return {
        stream: result.stream,
        mime_type: result.mime_type,
        size_bytes: 0,
        file_name: result.name,
      };
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  async uploadFile(
    orgId: string,
    mountId: string,
    targetPath: string,
    content: Buffer,
    mimeType: string,
  ): Promise<{ file_id: string; web_view_link: string }> {
    const mount = await this.resolveMount(orgId, mountId);
    if (mount.mode === 'read_only') throw new ForbiddenException('Mount is read-only');
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      // Parse path into parent folder + filename
      const parts = targetPath.replace(/^\//, '').split('/');
      const fileName = parts.pop()!;
      const parentPath = parts.join('/');

      // Resolve or create parent folder chain
      let parentId = mount.root_folder_id;
      if (parentPath) {
        const resolved = await provider.resolvePath(accessToken, mount.root_folder_id, parentPath);
        if (!resolved) {
          // Create intermediate folders
          for (const segment of parts) {
            const existing = await provider.resolvePath(accessToken, parentId, segment);
            if (existing) {
              parentId = existing;
            } else {
              const folder = await provider.createFolder(accessToken, parentId, segment);
              parentId = folder.id;
            }
          }
        } else {
          parentId = resolved;
        }
      }

      const result = await provider.uploadFile(accessToken, parentId, fileName, content, mimeType);
      return { file_id: result.id, web_view_link: result.web_url || '' };
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  async createFolder(
    orgId: string,
    mountId: string,
    name: string,
    parentId?: string,
  ): Promise<CloudFsEntry> {
    const mount = await this.resolveMount(orgId, mountId);
    if (mount.mode === 'read_only') throw new ForbiddenException('Mount is read-only');
    const { provider, accessToken } = await this.getProviderAndToken(mount);

    try {
      return await provider.createFolder(accessToken, parentId || mount.root_folder_id, name);
    } catch (err) {
      this.handleProviderError(err);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async resolveMount(orgId: string, mountId?: string): Promise<ResolvedCloudFsMount> {
    if (mountId) {
      const mount = await this.mounts.findById(mountId);
      if (!mount || mount.org_id !== orgId) throw new NotFoundException(`Mount ${mountId} not found`);
      return mount;
    }
    // Default: first org-level mount (no project scope)
    const mounts = await this.mounts.listByOrg(orgId);
    const orgMount = mounts.find(m => !m.project_id);
    if (!orgMount) throw new NotFoundException('No cloud FS mount configured for this org');
    return orgMount;
  }

  private toListOptions(providerName: string, options: CloudFsBrowseOptions | CloudFsSearchOptions): ListOptions {
    const listOptions: ListOptions = {};
    const pageSize = this.clampPageSize(options.pageSize);
    if (pageSize !== undefined) listOptions.page_size = pageSize;
    if (options.pageToken) listOptions.page_token = options.pageToken;
    if ('mimeType' in options && options.mimeType) listOptions.mime_type_filter = options.mimeType;
    const orderBy = this.mapOrderBy(providerName, options.orderBy);
    if (orderBy) listOptions.order_by = orderBy;
    return listOptions;
  }

  private clampPageSize(pageSize?: number): number | undefined {
    if (pageSize === undefined) return undefined;
    return Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
  }

  private mapOrderBy(providerName: string, orderBy?: CloudFsOrderBy): string | undefined {
    if (!orderBy) return undefined;
    if (providerName !== 'google_drive') {
      throw new BadRequestException(`Unsupported order_by for provider: ${providerName}`);
    }

    switch (orderBy) {
      case 'name':
        return 'folder,name';
      case 'name_desc':
        return 'folder,name desc';
      case 'modified':
        return 'folder,modifiedTime';
      case 'modified_desc':
        return 'folder,modifiedTime desc';
    }
  }

  private async browseRecursive(
    provider: CloudFsProvider,
    accessToken: string,
    mountId: string,
    folderId: string,
    path: string,
    options: ListOptions,
  ): Promise<CloudFsBrowseResponse> {
    const entryLimit = this.readPositiveIntegerEnv('EVE_CLOUD_FS_MAX_RECURSIVE_ENTRIES', DEFAULT_RECURSIVE_ENTRY_LIMIT);
    const depthLimit = this.readPositiveIntegerEnv('EVE_CLOUD_FS_MAX_RECURSIVE_DEPTH', DEFAULT_RECURSIVE_DEPTH_LIMIT);
    const entries: CloudFsEntry[] = [];
    const seenFolders = new Set<string>([folderId]);
    const queue: RecursiveQueueItem[] = [{ folderId, path, depth: 0 }];
    let cursor = 0;
    let truncated = false;

    while (cursor < queue.length && entries.length < entryLimit) {
      const current = queue[cursor++]!;
      let pageToken: string | undefined;

      do {
        const result = await provider.listFiles(accessToken, current.folderId, {
          ...options,
          page_token: pageToken,
        });
        pageToken = result.next_page_token;

        for (const entry of result.entries) {
          if (entries.length >= entryLimit) {
            truncated = true;
            break;
          }

          const entryPath = this.joinCloudFsPath(current.path, entry.name);
          const mappedEntry = { ...entry, path: entryPath };
          entries.push(mappedEntry);

          if (mappedEntry.is_folder && !seenFolders.has(mappedEntry.id)) {
            seenFolders.add(mappedEntry.id);
            if (current.depth + 1 > depthLimit) {
              truncated = true;
            } else {
              queue.push({ folderId: mappedEntry.id, path: entryPath, depth: current.depth + 1 });
            }
          }
        }
      } while (pageToken && entries.length < entryLimit);

      if (pageToken) {
        truncated = true;
      }
    }

    if (cursor < queue.length) {
      truncated = true;
    }

    return { mount_id: mountId, path, entries, truncated };
  }

  private readPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return parsed;
  }

  private normalizeBrowsePath(path?: string): string {
    if (!path || path === '/') return '/';
    const trimmed = path.trim();
    if (!trimmed || trimmed === '/') return '/';
    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/+$/, '') || '/';
  }

  private joinCloudFsPath(basePath: string, name: string): string {
    const normalizedBasePath = this.normalizeBrowsePath(basePath);
    return normalizedBasePath === '/' ? `/${name}` : `${normalizedBasePath}/${name}`;
  }

  private async getProviderAndToken(mount: { provider: string; integration_id: string; org_id: string }) {
    const provider = this.providers.get(mount.provider);
    if (!provider) throw new BadRequestException(`Unsupported provider: ${mount.provider}`);

    const integration = await this.integrations.findById(mount.integration_id);
    if (!integration) throw new NotFoundException(`Integration ${mount.integration_id} not found`);

    const tokens = integration.tokens_json as Record<string, unknown> | null;
    if (!tokens?.access_token || !tokens?.refresh_token) {
      throw new BadRequestException('Integration missing required OAuth tokens');
    }

    // Refresh the access token if it expires within 60 seconds
    let accessToken = tokens.access_token as string;
    const expiryDate = tokens.expiry_date as number | undefined;
    if (expiryDate && expiryDate < Date.now() + 60_000) {
      // Look up per-org OAuth app credentials for token refresh
      const appConfig = await this.oauthAppConfigs.findByOrgAndProvider(mount.org_id, mount.provider);
      if (!appConfig) {
        throw new BadRequestException(
          `No OAuth app configured for provider "${mount.provider}" in this org. ` +
          'Register credentials first via: eve integrations configure',
        );
      }

      const refreshed = await provider.refreshAccessToken(appConfig.client_id, appConfig.client_secret, tokens.refresh_token as string);
      accessToken = refreshed.access_token;

      // Persist the refreshed token
      await this.integrations.updateTokens(integration.id, {
        ...tokens,
        access_token: refreshed.access_token,
        expiry_date: Date.now() + refreshed.expires_in * 1000,
      });
    }

    return { provider, accessToken };
  }

  /** Convert provider-level errors to appropriate HTTP exceptions. */
  private handleProviderError(err: unknown): never {
    if (err instanceof DriveApiError) {
      if (err.status === 401 || err.status === 403) {
        throw new ForbiddenException(
          'Cloud storage authentication failed. The OAuth token may be expired or revoked. Re-connect the integration.',
        );
      }
      if (err.status === 404) {
        throw new NotFoundException('File or folder not found in cloud storage');
      }
      throw new HttpException(
        `Cloud storage error: ${err.message}`,
        err.status >= 400 && err.status < 600 ? err.status : HttpStatus.BAD_GATEWAY,
      );
    }
    throw err;
  }

  private toMountResponse(row: {
    id: string;
    org_id: string;
    project_id: string | null;
    integration_id: string;
    provider: string;
    root_folder_id: string;
    root_folder_path: string | null;
    mode: string;
    auto_index: boolean;
    label: string | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }): CloudFsMountResponse {
    return {
      id: row.id,
      org_id: row.org_id,
      project_id: row.project_id,
      integration_id: row.integration_id,
      provider: row.provider,
      root_folder_id: row.root_folder_id,
      root_folder_path: row.root_folder_path,
      mode: row.mode as CloudFsMountResponse['mode'],
      auto_index: row.auto_index,
      label: row.label,
      created_by: row.created_by,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}

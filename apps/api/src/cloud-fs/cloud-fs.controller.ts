import { BadRequestException, Body, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodError } from 'zod';
import { RequirePermission } from '../auth/permission.decorator.js';
import { CloudFsService } from './cloud-fs.service.js';
import {
  CloudFsBrowseRequestSchema,
  CloudFsSearchRequestSchema,
} from '@eve/shared';
import type {
  CreateCloudFsMountRequest,
  UpdateCloudFsMountRequest,
  CloudFsMountResponse,
  CloudFsMountListResponse,
  CloudFsBrowseRequest,
  CloudFsBrowseResponse,
  CloudFsSearchRequest,
  CloudFsSearchResponse,
  CloudFsEntry,
} from '@eve/shared';
import { ScopedAccessService } from '../auth/scoped-access.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { CurrentUser } from '../common/request-decorators.js';

@ApiTags('cloud-fs')
@ApiBearerAuth()
@Controller('orgs/:org_id/cloud-fs')
export class CloudFsController {
  constructor(
    private readonly cloudFsService: CloudFsService,
    private readonly scopedAccess: ScopedAccessService,
  ) {}

  // ── Mount CRUD ──────────────────────────────────────────────────────────

  @RequirePermission('cloud_fs:admin')
  @Post('mounts')
  @ApiOperation({ summary: 'Create a cloud FS mount' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  async createMount(
    @Param('org_id') orgId: string,
    @Body() body: CreateCloudFsMountRequest,
  ): Promise<CloudFsMountResponse> {
    return this.cloudFsService.createMount(orgId, body);
  }

  @RequirePermission('cloud_fs:read')
  @Get('mounts')
  @ApiOperation({ summary: 'List cloud FS mounts' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Filter by project ID' })
  async listMounts(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Query('project_id') projectId?: string,
  ): Promise<CloudFsMountListResponse> {
    const mounts = await this.cloudFsService.listMounts(orgId, projectId);
    return { mounts: this.filterMountsForUser(mounts, caller) };
  }

  @RequirePermission('cloud_fs:read')
  @Get('mounts/:mount_id')
  @ApiOperation({ summary: 'Get cloud FS mount details' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  async getMount(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<CloudFsMountResponse> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:read', 'read', caller);
    return this.cloudFsService.getMount(mountId, orgId);
  }

  @RequirePermission('cloud_fs:admin')
  @Patch('mounts/:mount_id')
  @ApiOperation({ summary: 'Update a cloud FS mount' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  async updateMount(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Body() body: UpdateCloudFsMountRequest,
  ): Promise<CloudFsMountResponse> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:admin', 'admin', caller);
    return this.cloudFsService.updateMount(mountId, orgId, body);
  }

  @RequirePermission('cloud_fs:admin')
  @Delete('mounts/:mount_id')
  @ApiOperation({ summary: 'Remove a cloud FS mount' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  async removeMount(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<{ ok: boolean }> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:admin', 'admin', caller);
    await this.cloudFsService.removeMount(mountId, orgId);
    return { ok: true };
  }

  // ── File browsing ───────────────────────────────────────────────────────

  @RequirePermission('cloud_fs:read')
  @Get('browse')
  @ApiOperation({ summary: 'Browse files in a cloud FS mount' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiQuery({ name: 'mount_id', required: false, description: 'Mount ID (defaults to first org mount)' })
  @ApiQuery({ name: 'path', required: false, description: 'Folder path (defaults to /)' })
  @ApiQuery({ name: 'recursive', required: false, description: 'Return a bounded recursive listing (true/false)' })
  @ApiQuery({ name: 'page_token', required: false, description: 'Provider page token for the next browse page' })
  @ApiQuery({ name: 'page_size', required: false, description: 'Requested page size (clamped to provider maximum)' })
  @ApiQuery({ name: 'order_by', required: false, enum: ['name', 'name_desc', 'modified', 'modified_desc'] })
  async browse(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<CloudFsBrowseResponse> {
    const query = this.parseBrowseQuery(rawQuery);
    const resolvedMountId = await this.resolveReadableMountId(orgId, query.mount_id, caller);
    return this.cloudFsService.browse(orgId, resolvedMountId, query.path, {
      recursive: query.recursive,
      pageToken: query.page_token,
      pageSize: query.page_size,
      orderBy: query.order_by,
    });
  }

  // ── Per-mount file operations ──────────────────────────────────────────

  @RequirePermission('cloud_fs:read')
  @Get('mounts/:mount_id/browse')
  @ApiOperation({ summary: 'Browse files in a specific mount' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  @ApiQuery({ name: 'folder_id', required: false, description: 'Folder ID to browse (defaults to mount root)' })
  @ApiQuery({ name: 'path', required: false, description: 'Folder path to browse' })
  @ApiQuery({ name: 'recursive', required: false, description: 'Return a bounded recursive listing (true/false)' })
  @ApiQuery({ name: 'page_token', required: false, description: 'Provider page token for the next browse page' })
  @ApiQuery({ name: 'page_size', required: false, description: 'Requested page size (clamped to provider maximum)' })
  @ApiQuery({ name: 'order_by', required: false, enum: ['name', 'name_desc', 'modified', 'modified_desc'] })
  async browseMount(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<CloudFsBrowseResponse> {
    const query = this.parseBrowseQuery(rawQuery);
    const folderId = this.getStringQueryValue(rawQuery, 'folder_id');
    const requestedPath = this.getStringQueryValue(rawQuery, 'path');
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:read', 'read', caller);
    return this.cloudFsService.browseMount(orgId, mountId, folderId, requestedPath, {
      recursive: query.recursive,
      pageToken: query.page_token,
      pageSize: query.page_size,
      orderBy: query.order_by,
    });
  }

  @RequirePermission('cloud_fs:read')
  @Get('mounts/:mount_id/files/:file_id')
  @ApiOperation({ summary: 'Get file metadata' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  @ApiParam({ name: 'file_id', description: 'Provider file ID' })
  async getFileMeta(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @Param('file_id') fileId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<CloudFsEntry> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:read', 'read', caller);
    return this.cloudFsService.getFileMeta(orgId, mountId, fileId);
  }

  @RequirePermission('cloud_fs:read')
  @Get('mounts/:mount_id/files/:file_id/download')
  @ApiOperation({ summary: 'Download a file from cloud storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  @ApiParam({ name: 'file_id', description: 'Provider file ID' })
  async downloadFile(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @Param('file_id') fileId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Res() res: any,
  ): Promise<void> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:read', 'read', caller);
    const result = await this.cloudFsService.downloadFile(orgId, mountId, fileId);

    // Fastify uses .header() not .setHeader()
    res.header('Content-Type', result.mime_type);
    if (result.size_bytes > 0) res.header('Content-Length', result.size_bytes);
    if (result.file_name) res.header('Content-Disposition', `attachment; filename="${result.file_name}"`);

    if (Buffer.isBuffer(result.stream)) {
      res.send(result.stream);
    } else {
      // Stream the response — collect into buffer for Fastify compatibility
      const reader = (result.stream as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      res.send(Buffer.concat(chunks));
    }
  }

  @RequirePermission('cloud_fs:admin')
  @Post('mounts/:mount_id/upload')
  @ApiOperation({ summary: 'Upload a file to cloud storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  async uploadFile(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Headers('x-cloud-fs-path') targetPath: string,
    @Headers('content-type') mimeType: string,
    @Req() req: { rawBody?: Buffer; body?: Buffer },
  ): Promise<{ file_id: string; web_view_link: string }> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:admin', 'write', caller);
    if (!targetPath) throw new BadRequestException('X-Cloud-FS-Path header is required');
    // rawBody is set by the custom Fastify content-type parser in main.ts;
    // fall back to req.body which the catch-all parser also provides as Buffer.
    const body = req.rawBody ?? req.body;
    if (!body || (Buffer.isBuffer(body) && body.length === 0)) {
      throw new BadRequestException('Request body is empty');
    }
    const content = Buffer.isBuffer(body) ? body : Buffer.from(body as any);
    return this.cloudFsService.uploadFile(orgId, mountId, targetPath, content, mimeType);
  }

  @RequirePermission('cloud_fs:admin')
  @Post('mounts/:mount_id/folders')
  @ApiOperation({ summary: 'Create a folder in cloud storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'mount_id', description: 'Mount ID' })
  async createFolder(
    @Param('org_id') orgId: string,
    @Param('mount_id') mountId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Body() body: { name: string; parent_id?: string },
  ): Promise<CloudFsEntry> {
    await this.assertMountAccess(orgId, mountId, 'cloud_fs:admin', 'write', caller);
    return this.cloudFsService.createFolder(orgId, mountId, body.name, body.parent_id);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  @RequirePermission('cloud_fs:read')
  @Get('search')
  @ApiOperation({ summary: 'Search files across cloud FS mounts' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({ name: 'mount_id', required: false, description: 'Mount ID (defaults to first org mount)' })
  @ApiQuery({ name: 'mime_type', required: false, description: 'Limit search results to this MIME type' })
  @ApiQuery({ name: 'page_token', required: false, description: 'Provider page token for the next search page' })
  @ApiQuery({ name: 'page_size', required: false, description: 'Requested page size (clamped to provider maximum)' })
  @ApiQuery({ name: 'order_by', required: false, enum: ['name', 'name_desc', 'modified', 'modified_desc'] })
  async search(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<CloudFsSearchResponse> {
    const query = this.parseSearchQuery(rawQuery);
    const resolvedMountId = await this.resolveReadableMountId(orgId, query.mount_id, caller);
    return this.cloudFsService.search(orgId, resolvedMountId, query.q, {
      pageToken: query.page_token,
      pageSize: query.page_size,
      orderBy: query.order_by,
      mimeType: query.mime_type,
    });
  }

  private parseBrowseQuery(rawQuery: Record<string, unknown>): CloudFsBrowseRequest {
    try {
      return CloudFsBrowseRequestSchema.parse(rawQuery);
    } catch (err) {
      this.handleQueryParseError(err);
    }
  }

  private parseSearchQuery(rawQuery: Record<string, unknown>): CloudFsSearchRequest {
    try {
      return CloudFsSearchRequestSchema.parse(rawQuery);
    } catch (err) {
      this.handleQueryParseError(err);
    }
  }

  private getStringQueryValue(rawQuery: Record<string, unknown>, key: string): string | undefined {
    const value = rawQuery[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private handleQueryParseError(err: unknown): never {
    if (err instanceof ZodError) {
      const details = err.issues
        .map((issue) => {
          const path = issue.path.join('.') || 'query';
          return `${path}: ${issue.message}`;
        })
        .join('; ');
      throw new BadRequestException(`Invalid cloud FS query: ${details}`);
    }
    throw err;
  }

  private async assertMountAccess(
    orgId: string,
    mountId: string,
    permission: 'cloud_fs:read' | 'cloud_fs:admin',
    action: 'read' | 'write' | 'admin',
    user?: AuthUser,
  ): Promise<void> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission,
      user,
      project_id: user?.project_id,
      resource: { type: 'cloud_fs', id: mountId, action },
    });
  }

  private filterMountsForUser(
    mounts: CloudFsMountResponse[],
    user?: AuthUser,
  ): CloudFsMountResponse[] {
    const allowed = user?.scope?.cloud_fs?.allow_mount_ids;
    if (!user?.is_job_token || !user.scope || !allowed) return mounts;
    if (allowed.includes('*')) return mounts;
    const allowedSet = new Set(allowed);
    return mounts.filter((mount) => allowedSet.has(mount.id));
  }

  private async resolveReadableMountId(
    orgId: string,
    requestedMountId: string | undefined,
    user?: AuthUser,
  ): Promise<string | undefined> {
    if (requestedMountId) {
      await this.assertMountAccess(orgId, requestedMountId, 'cloud_fs:read', 'read', user);
      return requestedMountId;
    }
    const allowed = user?.scope?.cloud_fs?.allow_mount_ids;
    if (!user?.is_job_token || !user.scope || !allowed || allowed.includes('*')) {
      return undefined;
    }
    const mounts = this.filterMountsForUser(await this.cloudFsService.listMounts(orgId), user);
    const mount = mounts[0];
    if (!mount) {
      throw new NotFoundException('No cloud FS mount is available in this job token scope');
    }
    return mount.id;
  }
}

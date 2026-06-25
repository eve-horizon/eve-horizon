import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Redirect,
  Req,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgFsCreateLinkRequestSchema,
  OrgFsCreateLinkResponseSchema,
  OrgFsCreatePublicPathRequestSchema,
  OrgFsCreateShareRequestSchema,
  OrgFsDeleteLinkResponseSchema,
  OrgFsDownloadUrlResponseSchema,
  OrgFsEnrollDeviceRequestSchema,
  OrgFsEnrollDeviceResponseSchema,
  OrgFsEventListResponseSchema,
  OrgFsInternalHeartbeatRequestSchema,
  OrgFsInternalIngestEventRequestSchema,
  OrgFsInternalMetricsRequestSchema,
  OrgFsListConflictsResponseSchema,
  OrgFsListLinksResponseSchema,
  OrgFsLinkSchema,
  OrgFsObjectListResponseSchema,
  OrgFsPublicPathListResponseSchema,
  OrgFsPublicPathSchema,
  OrgFsResolveConflictRequestSchema,
  OrgFsResolveConflictResponseSchema,
  OrgFsEventSchema,
  OrgFsRotateLinkTokenResponseSchema,
  OrgFsShareListResponseSchema,
  OrgFsShareSchema,
  OrgFsStatusResponseSchema,
  OrgFsUpdateLinkRequestSchema,
  OrgFsUploadUrlResponseSchema,
  type OrgFsCreateLinkRequest,
  type OrgFsCreateLinkResponse,
  type OrgFsCreatePublicPathRequest,
  type OrgFsCreateShareRequest,
  type OrgFsDeleteLinkResponse,
  type OrgFsDownloadUrlResponse,
  type OrgFsEnrollDeviceRequest,
  type OrgFsEnrollDeviceResponse,
  type OrgFsEvent,
  type OrgFsEventListResponse,
  type OrgFsInternalHeartbeatRequest,
  type OrgFsInternalIngestEventRequest,
  type OrgFsInternalMetricsRequest,
  type OrgFsListConflictsResponse,
  type OrgFsListLinksResponse,
  type OrgFsObjectListResponse,
  type OrgFsPublicPath,
  type OrgFsPublicPathListResponse,
  type OrgFsResolveConflictRequest,
  type OrgFsResolveConflictResponse,
  type OrgFsRotateLinkTokenResponse,
  type OrgFsShare,
  type OrgFsShareListResponse,
  type OrgFsStatusResponse,
  type OrgFsUpdateLinkRequest,
  type OrgFsUploadUrlResponse,
} from '@eve/shared';
import type { Observable } from 'rxjs';
import { Public } from '../auth/auth.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ScopedAccessService } from '../auth/scoped-access.service.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ORG_FS_INTERNAL_TOKEN_HEADER, OrgFsSyncService } from './org-fs-sync.service.js';

function extractInternalToken(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  const direct = headers?.[ORG_FS_INTERNAL_TOKEN_HEADER];
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  if (Array.isArray(direct) && typeof direct[0] === 'string' && direct[0].trim()) {
    return direct[0].trim();
  }
  const authorization = headers?.authorization;
  const authHeader = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authHeader !== 'string') {
    return undefined;
  }
  const normalized = authHeader.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith('bearer ')) {
    return normalized.slice(7).trim() || undefined;
  }
  return normalized;
}

function normalizeScopedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function linkOwnerPrincipal(user?: AuthUser): { type: 'user' | 'service_principal' | 'system'; id: string | null } {
  if (user?.is_service_principal) {
    return { type: 'service_principal', id: user.user_id ?? null };
  }
  if (user?.user_id) {
    return { type: 'user', id: user.user_id };
  }
  return { type: 'system', id: null };
}

@ApiTags('org-fs-sync')
@ApiBearerAuth()
@Controller('orgs/:org_id/fs')
export class OrgFsSyncController {
  constructor(
    private readonly service: OrgFsSyncService,
    private readonly scopedAccess: ScopedAccessService,
  ) {}

  @RequirePermission('orgfs:write')
  @Post('devices/enroll')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Enroll a sync device for an org' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsEnrollDeviceRequestSchema, 'OrgFsEnrollDeviceRequest') })
  @ApiCreatedResponse({
    schema: zodSchemaToOpenApi(OrgFsEnrollDeviceResponseSchema, 'OrgFsEnrollDeviceResponse'),
  })
  async enrollDevice(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgFsEnrollDeviceRequestSchema)) body: OrgFsEnrollDeviceRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsEnrollDeviceResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:write',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.enrollDevice(orgId, body, request.user?.user_id, request.correlationId);
  }

  @RequirePermission('orgfs:write')
  @Post('links')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or upsert an org filesystem sync link' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsCreateLinkRequestSchema, 'OrgFsCreateLinkRequest') })
  @ApiCreatedResponse({
    schema: zodSchemaToOpenApi(OrgFsCreateLinkResponseSchema, 'OrgFsCreateLinkResponse'),
  })
  async createLink(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgFsCreateLinkRequestSchema)) body: OrgFsCreateLinkRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsCreateLinkResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:write',
      user: request.user,
      resource: {
        type: 'orgfs',
        id: normalizeScopedPath(body.remote_path),
        action: 'write',
      },
      request_id: request.correlationId,
    });
    return this.service.createLink(
      orgId,
      body,
      linkOwnerPrincipal(request.user),
      request.user?.user_id,
      request.correlationId,
    );
  }

  @RequirePermission('orgfs:read')
  @Get('links')
  @ApiOperation({ summary: 'List org filesystem sync links' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsListLinksResponseSchema, 'OrgFsListLinksResponse'),
  })
  async listLinks(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsListLinksResponse> {
    const links = await this.service.listLinks(orgId);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });

    const visible: OrgFsListLinksResponse['data'] = [];
    for (const link of links.data) {
      const allowed = await this.scopedAccess.can({
        org_id: orgId,
        permission: 'orgfs:read',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: link.remote_path,
          action: 'read',
        },
      });
      if (allowed) {
        visible.push(link);
      }
    }

    return { data: visible };
  }

  @RequirePermission('orgfs:write')
  @Patch('links/:link_id')
  @ApiOperation({ summary: 'Update sync link mode, status, or path policies' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'link_id', description: 'Link ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsUpdateLinkRequestSchema, 'OrgFsUpdateLinkRequest') })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsLinkSchema, 'OrgFsLink'),
  })
  async updateLink(
    @Param('org_id') orgId: string,
    @Param('link_id') linkId: string,
    @Body(new ZodValidationPipe(OrgFsUpdateLinkRequestSchema)) body: OrgFsUpdateLinkRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const linkPath = await this.service.getLinkRemotePath(orgId, linkId);
    if (linkPath) {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: linkPath,
          action: 'write',
        },
        request_id: request.correlationId,
      });
    } else {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        request_id: request.correlationId,
      });
    }
    return this.service.updateLink(orgId, linkId, body, request.correlationId);
  }

  @RequirePermission('orgfs:write')
  @Post('links/:link_id/token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate per-link internal gateway token' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'link_id', description: 'Link ID', type: String })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsRotateLinkTokenResponseSchema, 'OrgFsRotateLinkTokenResponse'),
  })
  async rotateLinkToken(
    @Param('org_id') orgId: string,
    @Param('link_id') linkId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsRotateLinkTokenResponse> {
    const linkPath = await this.service.getLinkRemotePath(orgId, linkId);
    if (linkPath) {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: linkPath,
          action: 'write',
        },
        request_id: request.correlationId,
      });
    } else {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        request_id: request.correlationId,
      });
    }
    return this.service.rotateLinkGatewayToken(orgId, linkId, request.correlationId);
  }

  @RequirePermission('orgfs:write')
  @Delete('links/:link_id')
  @ApiOperation({ summary: 'Delete sync link' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'link_id', description: 'Link ID', type: String })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsDeleteLinkResponseSchema, 'OrgFsDeleteLinkResponse'),
  })
  async deleteLink(
    @Param('org_id') orgId: string,
    @Param('link_id') linkId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsDeleteLinkResponse> {
    const linkPath = await this.service.getLinkRemotePath(orgId, linkId);
    if (linkPath) {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: linkPath,
          action: 'write',
        },
        request_id: request.correlationId,
      });
    } else {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        request_id: request.correlationId,
      });
    }
    return this.service.deleteLink(orgId, linkId, request.correlationId);
  }

  @RequirePermission('orgfs:read')
  @Get('status')
  @ApiOperation({ summary: 'Get org filesystem sync status' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsStatusResponseSchema, 'OrgFsStatusResponse'),
  })
  async status(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsStatusResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.getStatus(orgId);
  }

  @RequirePermission('orgfs:read')
  @Get('events')
  @ApiOperation({ summary: 'List org fs events' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'after_seq', required: false, description: 'Return events with seq greater than this value' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max events (default 100, max 500)' })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsEventListResponseSchema, 'OrgFsEventListResponse'),
  })
  async listEvents(
    @Param('org_id') orgId: string,
    @Query('after_seq', new DefaultValuePipe(0), ParseIntPipe) afterSeq: number,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsEventListResponse> {
    const events = await this.service.listEvents(orgId, afterSeq, limit);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });

    const visible: OrgFsEventListResponse['data'] = [];
    for (const event of events.data) {
      const allowed = await this.scopedAccess.can({
        org_id: orgId,
        permission: 'orgfs:read',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: event.path,
          action: 'read',
        },
      });
      if (allowed) {
        visible.push(event);
      }
    }

    return {
      data: visible,
      pagination: events.pagination,
    };
  }

  @RequirePermission('orgfs:read')
  @Get('events/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream org fs events (SSE)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'after_seq', required: false, description: 'Resume cursor' })
  @ApiOkResponse({ description: 'Server-Sent Events stream' })
  async streamEvents(
    @Param('org_id') orgId: string,
    @Query('after_seq', new DefaultValuePipe(0), ParseIntPipe) afterSeq: number,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<Observable<MessageEvent>> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.streamEvents(orgId, afterSeq);
  }

  @RequirePermission('orgfs:read')
  @Get('conflicts')
  @ApiOperation({ summary: 'List filesystem sync conflicts for org' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'open_only', required: false, description: 'When true, only open conflicts are returned' })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsListConflictsResponseSchema, 'OrgFsListConflictsResponse'),
  })
  async listConflicts(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
    @Query('open_only') openOnly?: string,
  ): Promise<OrgFsListConflictsResponse> {
    const conflicts = await this.service.listConflicts(
      orgId,
      ['true', '1', 'yes', 'y'].includes((openOnly ?? '').toLowerCase()),
    );
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });

    const visible: OrgFsListConflictsResponse['data'] = [];
    for (const conflict of conflicts.data) {
      const allowed = await this.scopedAccess.can({
        org_id: orgId,
        permission: 'orgfs:read',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: conflict.path,
          action: 'read',
        },
      });
      if (allowed) {
        visible.push(conflict);
      }
    }

    return { data: visible };
  }

  @RequirePermission('orgfs:write')
  @Post('conflicts/:conflict_id/resolve')
  @ApiOperation({ summary: 'Resolve filesystem sync conflict' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'conflict_id', description: 'Conflict ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsResolveConflictRequestSchema, 'OrgFsResolveConflictRequest') })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsResolveConflictResponseSchema, 'OrgFsResolveConflictResponse'),
  })
  async resolveConflict(
    @Param('org_id') orgId: string,
    @Param('conflict_id') conflictId: string,
    @Body(new ZodValidationPipe(OrgFsResolveConflictRequestSchema)) body: OrgFsResolveConflictRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsResolveConflictResponse> {
    const conflictPath = await this.service.getConflictPath(orgId, conflictId);
    if (conflictPath) {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        resource: {
          type: 'orgfs',
          id: conflictPath,
          action: 'write',
        },
        request_id: request.correlationId,
      });
    } else {
      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgfs:write',
        user: request.user,
        request_id: request.correlationId,
      });
    }
    return this.service.resolveConflict(orgId, conflictId, body, request.user?.user_id, request.correlationId);
  }

  // --- Presigned URL endpoints ---

  @Public()
  @Get('upload-url')
  @ApiOperation({ summary: 'Get a presigned PUT URL for uploading a file to org filesystem storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Org filesystem path (e.g. /docs/report.md)' })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsUploadUrlResponseSchema, 'OrgFsUploadUrlResponse'),
  })
  async getUploadUrl(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @Req() request: { headers?: Record<string, string | string[] | undefined>; correlationId?: string },
  ): Promise<OrgFsUploadUrlResponse> {
    if (!path) {
      throw new BadRequestException('path query parameter is required');
    }
    const token = extractInternalToken(request.headers);
    const authz = await this.service.authorizeInternalGatewayToken(orgId, token, request.correlationId);
    return this.service.getUploadUrl(orgId, path, authz, request.correlationId);
  }

  @RequirePermission('orgfs:read')
  @Get('download-url')
  @ApiOperation({ summary: 'Get a presigned GET URL for downloading a file from org filesystem storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Org filesystem path (e.g. /docs/report.md)' })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsDownloadUrlResponseSchema, 'OrgFsDownloadUrlResponse'),
  })
  async getDownloadUrl(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsDownloadUrlResponse> {
    if (!path) {
      throw new BadRequestException('path query parameter is required');
    }
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      resource: {
        type: 'orgfs',
        id: normalizeScopedPath(path),
        action: 'read',
      },
      request_id: request.correlationId,
    });
    return this.service.getDownloadUrl(orgId, path, request.correlationId);
  }

  @RequirePermission('orgfs:read')
  @Get('objects')
  @ApiOperation({ summary: 'List objects in org filesystem storage' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'prefix', required: false, description: 'Filter by path prefix' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max results (default 100, max 500)' })
  @ApiQuery({ name: 'after', required: false, description: 'Pagination cursor (last path from previous page)' })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(OrgFsObjectListResponseSchema, 'OrgFsObjectListResponse'),
  })
  async listObjects(
    @Param('org_id') orgId: string,
    @Query('prefix') prefix: string | undefined,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('after') after: string | undefined,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsObjectListResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.listObjects(orgId, { prefix, limit, after });
  }

  // --- Share tokens ---

  @RequirePermission('orgfs:read')
  @Post('share')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a share token for an org fs file' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsCreateShareRequestSchema, 'OrgFsCreateShareRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(OrgFsShareSchema, 'OrgFsShare') })
  async createShare(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgFsCreateShareRequestSchema)) body: OrgFsCreateShareRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsShare> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });
    const actorId = request.user?.user_id ?? 'system';
    return this.service.createShare(orgId, body, actorId, request.correlationId);
  }

  @RequirePermission('orgfs:admin')
  @Get('shares')
  @ApiOperation({ summary: 'List active share tokens for an org' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsShareListResponseSchema, 'OrgFsShareListResponse') })
  async listShares(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsShareListResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:admin',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.listShares(orgId);
  }

  @RequirePermission('orgfs:admin')
  @Delete('shares/:token')
  @ApiOperation({ summary: 'Revoke a share token' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'token', description: 'Share token ID', type: String })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsShareSchema, 'OrgFsShare') })
  async revokeShare(
    @Param('org_id') orgId: string,
    @Param('token') token: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsShare> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:admin',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.revokeShare(orgId, token, request.correlationId);
  }

  // --- Public paths ---

  @RequirePermission('orgfs:admin')
  @Post('public-paths')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish a path prefix for unauthenticated access' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsCreatePublicPathRequestSchema, 'OrgFsCreatePublicPathRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(OrgFsPublicPathSchema, 'OrgFsPublicPath') })
  async createPublicPath(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgFsCreatePublicPathRequestSchema)) body: OrgFsCreatePublicPathRequest,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsPublicPath> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:admin',
      user: request.user,
      request_id: request.correlationId,
    });
    const actorId = request.user?.user_id ?? 'system';
    return this.service.createPublicPath(orgId, body, actorId, request.correlationId);
  }

  @RequirePermission('orgfs:read')
  @Get('public-paths')
  @ApiOperation({ summary: 'List published public path prefixes' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsPublicPathListResponseSchema, 'OrgFsPublicPathListResponse') })
  async listPublicPaths(
    @Param('org_id') orgId: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<OrgFsPublicPathListResponse> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:read',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.listPublicPaths(orgId);
  }

  @RequirePermission('orgfs:admin')
  @Delete('public-paths/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unpublish a public path prefix' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'id', description: 'Public path ID', type: String })
  async deletePublicPath(
    @Param('org_id') orgId: string,
    @Param('id') id: string,
    @Req() request: { user?: AuthUser; correlationId?: string },
  ): Promise<void> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgfs:admin',
      user: request.user,
      request_id: request.correlationId,
    });
    return this.service.deletePublicPath(orgId, id, request.correlationId);
  }
}

@ApiTags('org-fs-public')
@Controller('orgs/:org_id/fs/public')
export class OrgFsPublicController {
  constructor(private readonly service: OrgFsSyncService) {}

  /**
   * Public resolver: no auth required.
   * Accepts ?token=<share_token> or resolves via public path prefix.
   * Redirects 302 to a short-lived presigned download URL.
   */
  @Public()
  @Get('*')
  @Redirect()
  @ApiOperation({ summary: 'Resolve a share token or public path and redirect to file' })
  @ApiParam({ name: 'org_id', description: 'Organization slug or ID', type: String })
  @ApiQuery({ name: 'token', required: false, description: 'Share token (omit for public-path access)' })
  async resolvePublic(
    @Param('org_id') orgId: string,
    @Query('token') token: string | undefined,
    @Req() request: { url?: string; correlationId?: string },
  ): Promise<{ url: string; statusCode: number }> {
    // Extract the path portion from the raw request URL, stripping query params
    const rawUrl = request.url ?? '';
    const withoutQuery = rawUrl.split('?')[0];
    // Remove the /orgs/:org_id/fs/public prefix to get just the file path
    const prefixMatch = withoutQuery.match(/\/orgs\/[^/]+\/fs\/public(\/.*)?$/);
    const path = prefixMatch?.[1] ?? '/';

    let downloadUrl: string;

    if (token) {
      downloadUrl = await this.service.resolveShare(orgId, path, token, request.correlationId);
    } else {
      downloadUrl = await this.service.resolvePublicPath(orgId, path, request.correlationId);
    }

    return { url: downloadUrl, statusCode: 302 };
  }
}

@ApiTags('internal')
@Controller('internal/orgs/:org_id/fs')
export class OrgFsSyncInternalController {
  constructor(private readonly service: OrgFsSyncService) {}

  @Public()
  @Post('events')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ingest normalized org fs event (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsInternalIngestEventRequestSchema, 'OrgFsInternalIngestEventRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsEventSchema, 'OrgFsEvent') })
  async ingestEvent(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgFsInternalIngestEventRequestSchema)) body: OrgFsInternalIngestEventRequest,
    @Req() request: { headers?: Record<string, string | string[] | undefined>; correlationId?: string },
  ): Promise<OrgFsEvent> {
    if (!body.link_id) {
      throw new BadRequestException('link_id is required for internal fs event ingestion');
    }
    const token = extractInternalToken(request.headers);
    const authz = await this.service.authorizeInternalGatewayTokenForLink(orgId, body.link_id, token, request.correlationId);
    return this.service.ingestInternalEvent(orgId, body, {
      allow_prefixes: authz.allow_prefixes,
      requestId: request.correlationId,
    });
  }

  @Public()
  @Post('links/:link_id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update sync link heartbeat (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsInternalHeartbeatRequestSchema, 'OrgFsInternalHeartbeatRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsLinkSchema, 'OrgFsLink') })
  async heartbeat(
    @Param('org_id') orgId: string,
    @Param('link_id') linkId: string,
    @Body(new ZodValidationPipe(OrgFsInternalHeartbeatRequestSchema)) body: OrgFsInternalHeartbeatRequest,
    @Req() request: { headers?: Record<string, string | string[] | undefined>; correlationId?: string },
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const token = extractInternalToken(request.headers);
    await this.service.authorizeInternalGatewayTokenForLink(orgId, linkId, token, request.correlationId);
    return this.service.updateInternalHeartbeat(orgId, linkId, body, request.correlationId);
  }

  @Public()
  @Post('links/:link_id/metrics')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update sync link runtime metrics (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgFsInternalMetricsRequestSchema, 'OrgFsInternalMetricsRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(OrgFsLinkSchema, 'OrgFsLink') })
  async metrics(
    @Param('org_id') orgId: string,
    @Param('link_id') linkId: string,
    @Body(new ZodValidationPipe(OrgFsInternalMetricsRequestSchema)) body: OrgFsInternalMetricsRequest,
    @Req() request: { headers?: Record<string, string | string[] | undefined>; correlationId?: string },
  ): Promise<OrgFsCreateLinkResponse['link']> {
    const token = extractInternalToken(request.headers);
    await this.service.authorizeInternalGatewayTokenForLink(orgId, linkId, token, request.correlationId);
    return this.service.updateInternalMetrics(orgId, linkId, body, request.correlationId);
  }
}

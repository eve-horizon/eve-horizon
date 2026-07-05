import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ScopedAccessService } from '../auth/scoped-access.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  CreateOrgDocumentRequestSchema,
  UpdateOrgDocumentRequestSchema,
  PatchOrgDocumentRequestSchema,
  OrgDocumentDetailResponseSchema,
  OrgDocumentListResponseSchema,
  OrgDocumentSearchResultSchema,
  OrgDocumentVersionListResponseSchema,
  OrgDocumentVersionDetailSchema,
  OrgDocumentQueryRequestSchema,
  OrgDocumentQueryResponseSchema,
  type CreateOrgDocumentRequest,
  type UpdateOrgDocumentRequest,
  type PatchOrgDocumentRequest,
  type OrgDocumentDetailResponse,
  type OrgDocumentListResponse,
  type OrgDocumentSearchResult,
  type OrgDocumentQueryRequest,
  type OrgDocumentQueryResponse,
  type OrgDocumentVersionListResponse,
  type OrgDocumentVersionDetail,
} from '@eve/shared';
import { OrgDocumentsService } from './org-documents.service.js';
import { buildApiError } from '../system/api-errors.js';
import { CorrelationId, CurrentUser } from '../common/request-decorators.js';

function normalizePathParam(pathParam: string, requestId?: string): string {
  try {
    const decoded = decodeURIComponent(pathParam);
    return decoded.startsWith('/') ? decoded : `/${decoded}`;
  } catch {
    throw buildApiError(400, 'resource_uri_invalid', 'Invalid path encoding', {
      requestId,
      details: { path: pathParam },
    });
  }
}

function normalizeScopedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseDurationSeconds(raw?: string): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const matched = trimmed.match(/^(\d+)([smhd])$/i);
  if (!matched) return undefined;
  const value = Number.parseInt(matched[1], 10);
  const unit = matched[2].toLowerCase();
  const factor = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return value * factor;
}

@ApiTags('org-documents')
@ApiBearerAuth()
@Controller('orgs/:org_id/docs')
export class OrgDocumentsController {
  constructor(
    private readonly service: OrgDocumentsService,
    private readonly scopedAccess: ScopedAccessService,
  ) {}

  // --------------------------------------------------------------------------
  // Create document
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an org document' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateOrgDocumentRequestSchema, 'CreateOrgDocumentRequest') })
  @ApiCreatedResponse({
    description: 'Document created',
    schema: zodSchemaToOpenApi(OrgDocumentDetailResponseSchema, 'OrgDocumentDetailResponse'),
  })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateOrgDocumentRequestSchema)) body: CreateOrgDocumentRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentDetailResponse> {
    const scopedPath = normalizeScopedPath(body.path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:write',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'write',
      },
      request_id: correlationId,
    });
    return this.service.create(orgId, { ...body, path: scopedPath }, caller?.user_id, correlationId);
  }

  // --------------------------------------------------------------------------
  // Full-text search
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:read')
  @Get('search')
  @ApiOperation({ summary: 'Full-text search org documents' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 20)' })
  @ApiQuery({ name: 'path_prefix', required: false, type: String, description: 'Restrict results to documents under this path prefix (e.g. /reports/)' })
  @ApiQuery({
    name: 'mode',
    required: false,
    enum: ['text', 'semantic', 'hybrid'],
    description: 'Search mode (semantic/hybrid currently fall back to text when embeddings are absent)',
  })
  @ApiOkResponse({
    description: 'Search results',
    schema: zodSchemaToOpenApi(OrgDocumentSearchResultSchema, 'OrgDocumentSearchResult'),
  })
  async search(
    @Param('org_id') orgId: string,
    @Query('q') query: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('path_prefix') pathPrefix: string | undefined,
    @Query('mode') mode: 'text' | 'semantic' | 'hybrid' | undefined,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentSearchResult> {
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      request_id: correlationId,
    });
    return this.service.search(orgId, query, limit, mode ?? 'text', pathPrefix);
  }

  @RequirePermission('orgdocs:read')
  @Get('stale')
  @ApiOperation({ summary: 'List stale org documents by review_due age' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'overdue_by', required: false, description: 'Duration (e.g. 7d, 12h)' })
  @ApiQuery({ name: 'prefix', required: false, description: 'Path prefix filter' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 100)' })
  @ApiOkResponse({
    description: 'Stale documents',
    schema: zodSchemaToOpenApi(OrgDocumentListResponseSchema, 'OrgDocumentListResponse'),
  })
  async stale(
    @Param('org_id') orgId: string,
    @Query('overdue_by') overdueBy: string | undefined,
    @Query('prefix') prefix: string | undefined,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentListResponse> {
    const scopedPrefix = prefix ? normalizeScopedPath(prefix) : undefined;
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: scopedPrefix
        ? {
            type: 'orgdocs',
            id: scopedPrefix,
            action: 'read',
          }
        : undefined,
      request_id: correlationId,
    });
    return this.service.listStale(orgId, {
      overdueBySeconds: parseDurationSeconds(overdueBy),
      prefix: scopedPrefix,
      limit,
    });
  }

  @RequirePermission('orgdocs:write')
  @Post('review')
  @ApiOperation({ summary: 'Mark an org document reviewed and set next review date' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Document path' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['next_review'],
      properties: {
        next_review: { type: 'string', description: 'ISO timestamp for next review_due' },
      },
    },
  })
  @ApiOkResponse({
    description: 'Document reviewed',
    schema: zodSchemaToOpenApi(OrgDocumentDetailResponseSchema, 'OrgDocumentDetailResponse'),
  })
  async review(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @Body() body: { next_review?: string },
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentDetailResponse> {
    if (!path) {
      throw buildApiError(400, 'resource_uri_invalid', 'path query parameter is required', {
        requestId: correlationId,
      });
    }
    if (!body?.next_review) {
      throw buildApiError(400, 'resource_uri_invalid', 'next_review is required', {
        requestId: correlationId,
      });
    }
    const scopedPath = normalizeScopedPath(path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:write',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'write',
      },
      request_id: correlationId,
    });
    return this.service.reviewDocument(
      orgId,
      scopedPath,
      body.next_review,
      caller?.user_id,
      correlationId,
    );
  }

  // --------------------------------------------------------------------------
  // List by path prefix
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:read')
  @Get()
  @ApiOperation({ summary: 'List org documents by path prefix (metadata only)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: false, description: 'Path prefix filter (e.g. /reports/)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 100)' })
  @ApiOkResponse({
    description: 'Document list (metadata only)',
    schema: zodSchemaToOpenApi(OrgDocumentListResponseSchema, 'OrgDocumentListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Query('path') path?: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit?: number,
  ): Promise<OrgDocumentListResponse> {
    const scopedPath = path ? normalizeScopedPath(path) : undefined;
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: scopedPath
        ? {
            type: 'orgdocs',
            id: scopedPath,
            action: 'read',
          }
        : undefined,
      request_id: correlationId,
    });
    return this.service.listByPrefix(orgId, scopedPath ?? '', limit);
  }

  // --------------------------------------------------------------------------
  // Read document by path (query param to support slashes)
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:read')
  @Get('by-path')
  @ApiOperation({ summary: 'Read an org document by path' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Document path (e.g. /reports/architecture.md)' })
  @ApiOkResponse({
    description: 'Document with content',
    schema: zodSchemaToOpenApi(OrgDocumentDetailResponseSchema, 'OrgDocumentDetailResponse'),
  })
  @ApiNotFoundResponse({ description: 'Document not found' })
  async getByPath(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentDetailResponse> {
    if (!path) {
      throw buildApiError(400, 'resource_uri_invalid', 'path query parameter is required', {
        requestId: correlationId,
      });
    }
    const scopedPath = normalizeScopedPath(path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'read',
      },
      request_id: correlationId,
    });
    return this.service.getByPath(orgId, scopedPath, correlationId);
  }

  // --------------------------------------------------------------------------
  // Full replace
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:write')
  @Put('by-path')
  @ApiOperation({ summary: 'Full replace of an org document' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Document path' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateOrgDocumentRequestSchema, 'UpdateOrgDocumentRequest') })
  @ApiOkResponse({
    description: 'Document updated',
    schema: zodSchemaToOpenApi(OrgDocumentDetailResponseSchema, 'OrgDocumentDetailResponse'),
  })
  @ApiNotFoundResponse({ description: 'Document not found' })
  async update(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @Body(new ZodValidationPipe(UpdateOrgDocumentRequestSchema)) body: UpdateOrgDocumentRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentDetailResponse> {
    if (!path) {
      throw buildApiError(400, 'resource_uri_invalid', 'path query parameter is required', {
        requestId: correlationId,
      });
    }
    const scopedPath = normalizeScopedPath(path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:write',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'write',
      },
      request_id: correlationId,
    });
    return this.service.update(orgId, scopedPath, body, caller?.user_id, correlationId);
  }

  // --------------------------------------------------------------------------
  // Patch (search/replace edit)
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:write')
  @Patch('by-path')
  @ApiOperation({ summary: 'Patch an org document with search/replace operations' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Document path' })
  @ApiBody({ schema: zodSchemaToOpenApi(PatchOrgDocumentRequestSchema, 'PatchOrgDocumentRequest') })
  @ApiOkResponse({
    description: 'Document patched',
    schema: zodSchemaToOpenApi(OrgDocumentDetailResponseSchema, 'OrgDocumentDetailResponse'),
  })
  @ApiNotFoundResponse({ description: 'Document not found' })
  async patch(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @Body(new ZodValidationPipe(PatchOrgDocumentRequestSchema)) body: PatchOrgDocumentRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentDetailResponse> {
    if (!path) {
      throw buildApiError(400, 'resource_uri_invalid', 'path query parameter is required', {
        requestId: correlationId,
      });
    }
    const scopedPath = normalizeScopedPath(path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:write',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'write',
      },
      request_id: correlationId,
    });
    return this.service.patch(orgId, scopedPath, body, caller?.user_id, correlationId);
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:write')
  @Delete('by-path')
  @ApiOperation({ summary: 'Delete an org document' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiQuery({ name: 'path', required: true, description: 'Document path' })
  @ApiOkResponse({ description: 'Document deleted' })
  @ApiNotFoundResponse({ description: 'Document not found' })
  async delete(
    @Param('org_id') orgId: string,
    @Query('path') path: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<{ success: boolean; message: string }> {
    if (!path) {
      throw buildApiError(400, 'resource_uri_invalid', 'path query parameter is required', {
        requestId: correlationId,
      });
    }
    const scopedPath = normalizeScopedPath(path);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:write',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: scopedPath,
        action: 'write',
      },
      request_id: correlationId,
    });
    return this.service.delete(orgId, scopedPath, caller?.user_id, correlationId);
  }

  // --------------------------------------------------------------------------
  // Structured query
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:read')
  @Post('query')
  @ApiOperation({ summary: 'Structured metadata query for org documents' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(OrgDocumentQueryRequestSchema, 'OrgDocumentQueryRequest') })
  @ApiOkResponse({
    description: 'Query results',
    schema: zodSchemaToOpenApi(OrgDocumentQueryResponseSchema, 'OrgDocumentQueryResponse'),
  })
  async query(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(OrgDocumentQueryRequestSchema)) body: OrgDocumentQueryRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentQueryResponse> {
    const scopedPath = body.path_prefix ? normalizeScopedPath(body.path_prefix) : undefined;
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: scopedPath
        ? {
            type: 'orgdocs',
            id: scopedPath,
            action: 'read',
          }
        : undefined,
      request_id: correlationId,
    });
    return this.service.query(orgId, body, correlationId);
  }

  // --------------------------------------------------------------------------
  // Version history (path param form)
  // --------------------------------------------------------------------------

  @RequirePermission('orgdocs:read')
  @Get(':path/versions')
  @ApiOperation({ summary: 'List org document versions' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'path', description: 'URL-encoded document path without leading slash', type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max results (default 20)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset (default 0)' })
  @ApiOkResponse({
    description: 'Version list',
    schema: zodSchemaToOpenApi(OrgDocumentVersionListResponseSchema, 'OrgDocumentVersionListResponse'),
  })
  async listVersions(
    @Param('org_id') orgId: string,
    @Param('path') pathParam: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentVersionListResponse> {
    const path = normalizePathParam(pathParam, correlationId);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: path,
        action: 'read',
      },
      request_id: correlationId,
    });
    return this.service.listVersions(orgId, path, limit, offset, correlationId);
  }

  @RequirePermission('orgdocs:read')
  @Get(':path/versions/:version')
  @ApiOperation({ summary: 'Read a specific org document version' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiParam({ name: 'path', description: 'URL-encoded document path without leading slash', type: String })
  @ApiParam({ name: 'version', description: 'Version number', type: Number })
  @ApiOkResponse({
    description: 'Version detail',
    schema: zodSchemaToOpenApi(OrgDocumentVersionDetailSchema, 'OrgDocumentVersionDetail'),
  })
  async getVersion(
    @Param('org_id') orgId: string,
    @Param('path') pathParam: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<OrgDocumentVersionDetail> {
    const path = normalizePathParam(pathParam, correlationId);
    await this.scopedAccess.assert({
      org_id: orgId,
      permission: 'orgdocs:read',
      user: caller,
      resource: {
        type: 'orgdocs',
        id: path,
        action: 'read',
      },
      request_id: correlationId,
    });
    return this.service.getVersion(orgId, path, version, correlationId);
  }
}

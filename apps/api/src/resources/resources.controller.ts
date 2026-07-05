import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  ResolveResourcesRequestSchema,
  ResolveResourcesListResponseSchema,
  parseResourceUri,
  type ResolveResourcesRequest,
  type ResolveResourcesListResponse,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ResourcesService } from './resources.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ScopedAccessService } from '../auth/scoped-access.service.js';
import { CorrelationId, CurrentUser } from '../common/request-decorators.js';

@ApiTags('resources')
@ApiBearerAuth()
@Controller('orgs/:org_id/resources')
export class ResourcesController {
  constructor(
    private readonly resources: ResourcesService,
    private readonly scopedAccess: ScopedAccessService,
  ) {}

  @RequirePermission('orgdocs:read', 'jobs:read')
  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve resource URIs into content snapshots' })
  @ApiParam({ name: 'org_id', description: 'Organization ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(ResolveResourcesRequestSchema, 'ResolveResourcesRequest') })
  @ApiOkResponse({
    description: 'Resolved resources',
    schema: zodSchemaToOpenApi(ResolveResourcesListResponseSchema, 'ResolveResourcesListResponse'),
  })
  async resolve(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(ResolveResourcesRequestSchema)) body: ResolveResourcesRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
  ): Promise<ResolveResourcesListResponse> {
    for (const uri of body.uris) {
      const parsed = parseResourceUri(uri);
      if (!parsed || parsed.scheme !== 'org_docs') {
        continue;
      }

      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'orgdocs:read',
        user: caller,
        resource: {
          type: 'orgdocs',
          id: parsed.path,
          action: 'read',
        },
        request_id: correlationId,
      });
    }

    for (const uri of body.uris) {
      const parsed = parseResourceUri(uri);
      if (!parsed || parsed.scheme !== 'job_attachments') {
        continue;
      }

      await this.scopedAccess.assert({
        org_id: orgId,
        permission: 'jobs:read',
        user: caller,
        request_id: correlationId,
      });
    }

    return this.resources.resolveResources(orgId, body, correlationId);
  }
}

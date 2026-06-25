import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  HarnessInfoResponseSchema,
  HarnessListResponseSchema,
  HarnessProfileValidateRequestSchema,
  HarnessProfileValidateResponseSchema,
  type HarnessInfoResponse,
  type HarnessListResponse,
  type HarnessProfileValidateRequest,
  type HarnessProfileValidateResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { Public } from '../auth/auth.decorator.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { RbacService } from '../auth/rbac.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Permission } from '../auth/permissions.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { HarnessesService } from './harnesses.service.js';

@ApiTags('harnesses')
@Controller()
export class HarnessesController {
  constructor(
    private readonly harnessesService: HarnessesService,
    private readonly rbac: RbacService,
  ) {}

  @Get('harnesses')
  @Public()
  @ApiOperation({ summary: 'List harnesses and auth status' })
  @ApiQuery({ name: 'org_id', required: false, description: 'Organization ID to resolve secrets from' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Project ID to resolve secrets from (takes precedence over org_id)' })
  @ApiOkResponse({
    description: 'Harness list',
    schema: zodSchemaToOpenApi(HarnessListResponseSchema, 'HarnessListResponse'),
  })
  async list(
    @Query('org_id') orgId?: string,
    @Query('project_id') projectId?: string,
  ): Promise<HarnessListResponse> {
    return this.harnessesService.list({ orgId, projectId });
  }

  @Get('harnesses/:name')
  @Public()
  @ApiOperation({ summary: 'Get harness details and auth status' })
  @ApiQuery({ name: 'org_id', required: false, description: 'Organization ID to resolve secrets from' })
  @ApiQuery({ name: 'project_id', required: false, description: 'Project ID to resolve secrets from (takes precedence over org_id)' })
  @ApiOkResponse({
    description: 'Harness details',
    schema: zodSchemaToOpenApi(HarnessInfoResponseSchema, 'HarnessInfoResponse'),
  })
  async get(
    @Param('name') name: string,
    @Query('org_id') orgId?: string,
    @Query('project_id') projectId?: string,
  ): Promise<HarnessInfoResponse> {
    return this.harnessesService.get(name, { orgId, projectId });
  }

  /**
   * Dry-run validate an inline harness profile override + env_overrides
   * against a project's secret catalog and harness auth state. Does not
   * create a job, does not spawn the harness, does not bill for inference.
   *
   * docs/plans/per-job-harness-override-plan.md §3.5 Phase 2 R4.
   */
  @RequirePermission('jobs:read')
  @Post('projects/:project_id/harness-profile/validate')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate an inline harness_profile_override + env_overrides for a project' })
  @ApiParam({ name: 'project_id', description: 'Project ID or slug', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(HarnessProfileValidateRequestSchema, 'HarnessProfileValidateRequest') })
  @ApiOkResponse({
    description: 'Validation report',
    schema: zodSchemaToOpenApi(HarnessProfileValidateResponseSchema, 'HarnessProfileValidateResponse'),
  })
  async validate(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(HarnessProfileValidateRequestSchema)) body: HarnessProfileValidateRequest,
    @Req() request: { user?: AuthUser },
  ): Promise<HarnessProfileValidateResponse> {
    // Gate override validation on the same permissions as job creation so a
    // caller without jobs:harness_override cannot probe for secret presence or
    // harness availability. docs/plans/per-job-harness-override-plan.md §3.7.
    if (request.user) {
      const needs: Permission[] = [];
      if (body.harness_profile_override || body.env_overrides) {
        needs.push('jobs:harness_override');
      }
      if (body.env_overrides) {
        const refsAnySecret = Object.values(body.env_overrides).some((v) =>
          /\$\{secret\.[A-Z_][A-Z0-9_]*\}/.test(v),
        );
        if (refsAnySecret) needs.push('secrets:read');
      }
      if (needs.length > 0) {
        await this.rbac.requirePermissions(request.user, projectId, needs);
      }
    }
    return this.harnessesService.validateInlineOverride({
      projectId,
      userId: request.user?.user_id,
      request: body,
    });
  }
}

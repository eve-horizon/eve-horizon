import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import {
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  WorkflowInvokeRequestSchema,
  WorkflowInvokeResponseSchema,
  WorkflowInvokeResultSchema,
  WorkflowRetryRequestSchema,
  WorkflowRetryResponseSchema,
  type WorkflowListResponse,
  type WorkflowResponse,
  type WorkflowInvokeRequest,
  type WorkflowInvokeResponse,
  type WorkflowInvokeResult,
  type WorkflowRetryRequest,
  type WorkflowRetryResponse,
  envOverridesReferenceSecrets,
} from '@eve/shared';
import { RbacService } from '../auth/rbac.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import type { Permission } from '../auth/permissions.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { WorkflowsService } from './workflows.service.js';

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('projects/:id/workflows')
export class WorkflowsController {
  constructor(
    private readonly workflowsService: WorkflowsService,
    private readonly rbac: RbacService,
  ) {}

  @RequirePermission('workflows:read')
  @Get()
  @ApiOperation({ summary: 'List workflows for a project (manifest-defined)' })
  @ApiOkResponse({
    description: 'Workflow list',
    schema: zodSchemaToOpenApi(WorkflowListResponseSchema, 'WorkflowListResponse'),
  })
  async list(@Param('id') projectId: string): Promise<WorkflowListResponse> {
    return this.workflowsService.list(projectId);
  }

  @RequirePermission('workflows:read')
  @Get(':name')
  @ApiOperation({ summary: 'Get workflow by name (manifest-defined)' })
  @ApiOkResponse({
    description: 'Workflow definition',
    schema: zodSchemaToOpenApi(WorkflowResponseSchema, 'WorkflowResponse'),
  })
  async findByName(
    @Param('id') projectId: string,
    @Param('name') name: string,
  ): Promise<WorkflowResponse> {
    return this.workflowsService.findByName(projectId, name);
  }

  @RequirePermission('workflows:write')
  @Post(':name/invoke')
  @ApiOperation({ summary: 'Invoke a workflow by creating a job' })
  @ApiQuery({
    name: 'wait',
    required: false,
    type: Boolean,
    description: 'If true, wait for job completion before returning (default: false, timeout: 60s)',
  })
  @ApiOkResponse({
    description: 'Workflow invocation response',
    schema: {
      oneOf: [
        zodSchemaToOpenApi(WorkflowInvokeResponseSchema, 'WorkflowInvokeResponse'),
        zodSchemaToOpenApi(WorkflowInvokeResultSchema, 'WorkflowInvokeResult'),
      ],
    },
  })
  async invoke(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(WorkflowInvokeRequestSchema)) body: WorkflowInvokeRequest,
    @Req() request: { user?: AuthUser },
    @Query('wait') wait?: string,
  ): Promise<WorkflowInvokeResponse | WorkflowInvokeResult> {
    if (request.user && body?.env_overrides) {
      const needs: Permission[] = ['jobs:harness_override'];
      if (envOverridesReferenceSecrets(body.env_overrides)) {
        needs.push('secrets:read');
      }
      await this.rbac.requirePermissions(request.user, projectId, needs);
    }
    if (request.user && body?.scope) {
      await this.rbac.requirePermissions(request.user, projectId, ['jobs:harness_override']);
    }

    const shouldWait = wait === 'true';
    return this.workflowsService.invoke(projectId, name, body, shouldWait, request.user?.user_id);
  }

  @RequirePermission('workflows:write')
  @Post('retry')
  @ApiOperation({ summary: 'Retry failed workflow steps without rerunning successful steps' })
  @ApiOkResponse({
    description: 'Workflow retry response',
    schema: zodSchemaToOpenApi(WorkflowRetryResponseSchema, 'WorkflowRetryResponse'),
  })
  async retry(
    @Param('id') projectId: string,
    @Body(new ZodValidationPipe(WorkflowRetryRequestSchema)) body: WorkflowRetryRequest,
    @Req() request: { user?: { user_id?: string } },
  ): Promise<WorkflowRetryResponse> {
    return this.workflowsService.retry(projectId, body, request.user?.user_id);
  }
}

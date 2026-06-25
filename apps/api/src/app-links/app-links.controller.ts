import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppLinksExplainRequestSchema,
  AppLinksExplainResponseSchema,
  AppLinksListResponseSchema,
  AppLinksPlanRequestSchema,
  AppLinksPlanResponseSchema,
  type AppLinksExplainRequest,
  type AppLinksExplainResponse,
  type AppLinksListResponse,
  type AppLinksPlanRequest,
  type AppLinksPlanResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { AppLinksService } from './app-links.service.js';

@ApiTags('app-links')
@ApiBearerAuth()
@Controller('projects/:id/app-links')
export class AppLinksController {
  constructor(private readonly service: AppLinksService) {}

  @RequirePermission('projects:read')
  @Get()
  @ApiOperation({ summary: 'List cross-project app link exports and subscriptions' })
  @ApiOkResponse({
    description: 'App link grants and subscriptions for the project',
    schema: zodSchemaToOpenApi(AppLinksListResponseSchema, 'AppLinksListResponse'),
  })
  async list(@Param('id') projectId: string): Promise<AppLinksListResponse> {
    return this.service.list(projectId);
  }

  @RequirePermission('projects:read')
  @Post('explain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explain why an app link is valid, missing, or revoked' })
  @ApiBody({ schema: zodSchemaToOpenApi(AppLinksExplainRequestSchema, 'AppLinksExplainRequest') })
  @ApiOkResponse({
    description: 'App link diagnostics',
    schema: zodSchemaToOpenApi(AppLinksExplainResponseSchema, 'AppLinksExplainResponse'),
  })
  async explain(
    @Param('id') projectId: string,
    @Body(new ZodValidationPipe(AppLinksExplainRequestSchema)) body: AppLinksExplainRequest,
  ): Promise<AppLinksExplainResponse> {
    return this.service.explain(projectId, body);
  }

  @RequirePermission('projects:read')
  @Post('plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dry-run app-link consumer manifest references against current grants' })
  @ApiBody({ schema: zodSchemaToOpenApi(AppLinksPlanRequestSchema, 'AppLinksPlanRequest') })
  @ApiOkResponse({
    description: 'App link plan diagnostics',
    schema: zodSchemaToOpenApi(AppLinksPlanResponseSchema, 'AppLinksPlanResponse'),
  })
  async plan(
    @Param('id') projectId: string,
    @Body(new ZodValidationPipe(AppLinksPlanRequestSchema)) body: AppLinksPlanRequest,
  ): Promise<AppLinksPlanResponse> {
    return this.service.plan(projectId, body);
  }
}

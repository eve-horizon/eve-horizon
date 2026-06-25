import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiSourceListResponseSchema,
  ApiSourceSchema,
  ApiSourceSpecResponseSchema,
  type ApiSource,
  type ApiSourceListResponse,
  type ApiSourceSpecResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ProjectApisService } from './project-apis.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';

@ApiTags('project-apis')
@ApiBearerAuth()
@Controller('projects/:id/apis')
export class ProjectApisController {
  constructor(private readonly projectApisService: ProjectApisService) {}

  @RequirePermission('projects:read')
  @Get()
  @ApiOperation({ summary: 'List API sources for a project' })
  @ApiQuery({ name: 'env', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'API sources list',
    schema: zodSchemaToOpenApi(ApiSourceListResponseSchema, 'ApiSourceListResponse'),
  })
  async list(
    @Param('id') projectId: string,
    @Query('env') env: string | undefined,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<ApiSourceListResponse> {
    return this.projectApisService.list(projectId, {
      env,
      limit,
      offset,
    });
  }

  @RequirePermission('projects:read')
  @Get(':name')
  @ApiOperation({ summary: 'Get API source by name' })
  @ApiQuery({ name: 'env', required: false })
  @ApiOkResponse({
    description: 'API source',
    schema: zodSchemaToOpenApi(ApiSourceSchema, 'ApiSource'),
  })
  async find(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Query('env') env?: string,
  ): Promise<ApiSource> {
    return this.projectApisService.find(projectId, name, env ?? null);
  }

  @RequirePermission('projects:read')
  @Get(':name/spec')
  @ApiOperation({ summary: 'Get cached API spec for a source' })
  @ApiQuery({ name: 'env', required: false })
  @ApiOkResponse({
    description: 'Cached API spec',
    schema: zodSchemaToOpenApi(ApiSourceSpecResponseSchema, 'ApiSourceSpecResponse'),
  })
  async spec(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Query('env') env?: string,
  ): Promise<ApiSourceSpecResponse> {
    const schema = await this.projectApisService.getSpec(projectId, name, env ?? null);
    return { schema };
  }

  @RequirePermission('projects:write')
  @Post(':name/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh cached API spec for a source' })
  @ApiQuery({ name: 'env', required: false })
  @ApiOkResponse({
    description: 'API source updated',
    schema: zodSchemaToOpenApi(ApiSourceSchema, 'ApiSource'),
  })
  async refresh(
    @Param('id') projectId: string,
    @Param('name') name: string,
    @Query('env') env?: string,
  ): Promise<ApiSource> {
    return this.projectApisService.refreshSpec(projectId, name, env ?? null);
  }
}

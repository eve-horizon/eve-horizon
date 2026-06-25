import { Controller, Delete, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import {
  PipelineListResponseSchema,
  PipelineResponseSchema,
  type PipelineListResponse,
  type PipelineResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { PipelinesService } from './pipelines.service.js';

@ApiTags('pipelines')
@ApiBearerAuth()
@Controller('projects/:id/pipelines')
export class PipelinesController {
  constructor(private readonly pipelinesService: PipelinesService) {}

  @RequirePermission('pipelines:read')
  @Get()
  @ApiOperation({ summary: 'List pipelines for a project (manifest-defined)' })
  @ApiOkResponse({
    description: 'Pipeline list',
    schema: zodSchemaToOpenApi(PipelineListResponseSchema, 'PipelineListResponse'),
  })
  async list(@Param('id') projectId: string): Promise<PipelineListResponse> {
    return this.pipelinesService.list(projectId);
  }

  @RequirePermission('pipelines:read')
  @Get(':name')
  @ApiOperation({ summary: 'Get pipeline by name (manifest-defined)' })
  @ApiOkResponse({
    description: 'Pipeline definition',
    schema: zodSchemaToOpenApi(PipelineResponseSchema, 'PipelineResponse'),
  })
  async findByName(
    @Param('id') projectId: string,
    @Param('name') name: string,
  ): Promise<PipelineResponse> {
    return this.pipelinesService.findByName(projectId, name);
  }

  @RequirePermission('pipelines:admin')
  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete all pipeline runs for a named pipeline' })
  @ApiNoContentResponse({ description: 'Pipeline runs deleted' })
  async delete(
    @Param('id') projectId: string,
    @Param('name') name: string,
  ): Promise<void> {
    return this.pipelinesService.delete(projectId, name);
  }
}

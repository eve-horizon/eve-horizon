import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import {
  PipelineExpanderService,
  type ExpandPipelineRequest,
  type PipelineRunWithJobsResponse,
} from './pipeline-expander.service.js';
import { ExpandPipelineRequestSchema, PipelineRunWithJobsResponseSchema } from './pipeline-expander.controller.js';

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class PipelineExpanderInternalController {
  constructor(private readonly pipelineExpanderService: PipelineExpanderService) {}

  @Public()
  @Post('projects/:id/pipelines/:name/runs')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a pipeline run (internal)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(ExpandPipelineRequestSchema, 'ExpandPipelineRequest'),
  })
  @ApiOkResponse({
    description: 'Pipeline run created with expanded job graph',
    schema: zodSchemaToOpenApi(
      PipelineRunWithJobsResponseSchema,
      'PipelineRunWithJobsResponse',
    ),
  })
  async createRun(
    @Param('id') projectId: string,
    @Param('name') pipelineName: string,
    @Body(new ZodValidationPipe(ExpandPipelineRequestSchema))
    body: { git_sha: string; env_name?: string; inputs?: Record<string, unknown>; only?: string; dedupe_key?: string },
  ): Promise<PipelineRunWithJobsResponse> {
    const request: ExpandPipelineRequest = {
      pipeline_name: pipelineName,
      git_sha: body.git_sha,
      env_name: body.env_name,
      inputs: body.inputs,
      only: body.only,
      dedupe_key: body.dedupe_key,
    };
    return this.pipelineExpanderService.expandPipeline(projectId, request, 'system');
  }
}

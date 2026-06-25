import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { loadConfig } from '@eve/shared';
import { Public } from '../auth/auth.decorator.js';
import {
  PipelineExpanderService,
  type ExpandPipelineRequest,
  type PipelineRunWithJobsResponse,
} from './pipeline-expander.service.js';
import { ExpandPipelineRequestSchema, PipelineRunWithJobsResponseSchema } from './pipeline-expander.controller.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

function validateInternalToken(token: string | undefined): void {
  const config = loadConfig();
  if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
    throw new UnauthorizedException('Invalid internal token');
  }
}

@ApiTags('internal')
@Controller('internal')
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
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body(new ZodValidationPipe(ExpandPipelineRequestSchema))
    body: { git_sha: string; env_name?: string; inputs?: Record<string, unknown>; only?: string; dedupe_key?: string },
  ): Promise<PipelineRunWithJobsResponse> {
    validateInternalToken(token);
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

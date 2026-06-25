import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  PipelineRunDetailResponseSchema,
  PipelineRunListResponseSchema,
  PipelineRunRequestSchema,
  type PipelineRunDetailResponse,
  type PipelineRunListResponse,
  type PipelineRunRequest,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { PipelineRunsService } from './pipeline-runs.service.js';
import type { FastifyReply } from 'fastify';
import type { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';

@ApiTags('pipeline-runs')
@ApiBearerAuth()
@Controller()
export class PipelineRunsController {
  constructor(private readonly pipelineRunsService: PipelineRunsService) {}

  @RequirePermission('pipelines:write')
  @Post('projects/:id/pipelines/:name/run')
  @ApiOperation({ summary: 'Create a pipeline run' })
  @ApiBody({ schema: zodSchemaToOpenApi(PipelineRunRequestSchema, 'PipelineRunRequest') })
  @ApiQuery({ name: 'wait', required: false, description: 'Wait for completion' })
  @ApiQuery({ name: 'timeout', required: false, description: 'Max wait time in seconds' })
  @ApiOkResponse({
    description: 'Pipeline run created',
    schema: zodSchemaToOpenApi(PipelineRunDetailResponseSchema, 'PipelineRunDetailResponse'),
  })
  @ApiAcceptedResponse({
    description: 'Pipeline still running after timeout',
    schema: zodSchemaToOpenApi(PipelineRunDetailResponseSchema, 'PipelineRunDetailResponse'),
  })
  async createRun(
    @Param('id') projectId: string,
    @Param('name') pipelineName: string,
    @Body(new ZodValidationPipe(PipelineRunRequestSchema)) body: PipelineRunRequest,
    @Query('wait', new DefaultValuePipe(false), ParseBoolPipe) wait: boolean,
    @Query('timeout') timeout?: string,
    @Res({ passthrough: true }) res?: FastifyReply,
  ): Promise<PipelineRunDetailResponse> {
    const runMode = wait ? 'wait' : 'async';
    const { detail, pipeline } = await this.pipelineRunsService.createRun(
      projectId,
      pipelineName,
      body,
      runMode,
    );

    if (!wait) {
      return detail;
    }

    const timeoutSeconds = this.pipelineRunsService.resolveWaitTimeout(
      pipeline,
      timeout ? parseInt(timeout, 10) : undefined,
    );

    const result = await this.pipelineRunsService.waitForRun(detail.run.id, timeoutSeconds);
    if (!result.completed && res) {
      res.status(HttpStatus.ACCEPTED);
    }
    return result.detail;
  }

  @RequirePermission('pipelines:read')
  @Get('projects/:id/pipelines/:name/runs')
  @ApiOperation({ summary: 'List pipeline runs for a pipeline' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Pipeline run list',
    schema: zodSchemaToOpenApi(PipelineRunListResponseSchema, 'PipelineRunListResponse'),
  })
  async listRuns(
    @Param('id') projectId: string,
    @Param('name') pipelineName: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<PipelineRunListResponse> {
    return this.pipelineRunsService.listRuns(projectId, pipelineName, { limit, offset });
  }

  @RequirePermission('pipelines:read')
  @Get('projects/:id/pipelines/:name/runs/:runId')
  @ApiOperation({ summary: 'Get pipeline run details' })
  @ApiOkResponse({
    description: 'Pipeline run detail',
    schema: zodSchemaToOpenApi(PipelineRunDetailResponseSchema, 'PipelineRunDetailResponse'),
  })
  async getRun(
    @Param('id') projectId: string,
    @Param('name') pipelineName: string,
    @Param('runId') runId: string,
  ): Promise<PipelineRunDetailResponse> {
    return this.pipelineRunsService.getRunDetail(projectId, pipelineName, runId);
  }

  @RequirePermission('pipelines:write')
  @Post('pipeline-runs/:runId/approve')
  @ApiOperation({ summary: 'Approve a pipeline run awaiting approval' })
  @ApiOkResponse({
    description: 'Pipeline run approved',
    schema: zodSchemaToOpenApi(PipelineRunDetailResponseSchema, 'PipelineRunDetailResponse'),
  })
  async approveRun(@Param('runId') runId: string): Promise<PipelineRunDetailResponse> {
    return this.pipelineRunsService.approveRun(runId);
  }

  @RequirePermission('pipelines:write')
  @Post('pipeline-runs/:runId/cancel')
  @ApiOperation({ summary: 'Cancel a pipeline run' })
  @ApiOkResponse({
    description: 'Pipeline run cancelled',
    schema: zodSchemaToOpenApi(PipelineRunDetailResponseSchema, 'PipelineRunDetailResponse'),
  })
  async cancelRun(
    @Param('runId') runId: string,
    @Body() body?: { reason?: string },
  ): Promise<PipelineRunDetailResponse> {
    return this.pipelineRunsService.cancelRun(runId, body?.reason);
  }

  @RequirePermission('pipelines:read')
  @Get('pipeline-runs/:runId/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream logs for all steps in a pipeline run (SSE)' })
  @ApiOkResponse({ description: 'Server-Sent Events stream of pipeline logs' })
  streamRunLogs(@Param('runId') runId: string): Observable<MessageEvent> {
    return this.pipelineRunsService.streamRunLogs(runId) as Observable<MessageEvent>;
  }

  @RequirePermission('pipelines:read')
  @Get('pipeline-runs/:runId/steps/:name/stream')
  @Sse()
  @ApiOperation({ summary: 'Stream logs for a single pipeline step (SSE)' })
  @ApiOkResponse({ description: 'Server-Sent Events stream of pipeline step logs' })
  streamStepLogs(
    @Param('runId') runId: string,
    @Param('name') stepName: string,
  ): Observable<MessageEvent> {
    return this.pipelineRunsService.streamStepLogs(runId, stepName);
  }

  @RequirePermission('pipelines:read')
  @Get('pipeline-runs/:runId/logs')
  @ApiOperation({ summary: 'Get logs for a pipeline run' })
  @ApiQuery({ name: 'step', required: false, description: 'Filter logs to a specific step name' })
  @ApiQuery({ name: 'after_seq', required: false, description: 'Only return logs after this sequence number' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of log entries to return' })
  async getRunLogs(
    @Param('runId') runId: string,
    @Query('step') step?: string,
    @Query('after_seq') afterSeq?: string,
    @Query('limit') limit?: string,
  ): Promise<{ logs: Array<{ step_name: string; seq: number; type: string; content: Record<string, unknown>; timestamp: string }> }> {
    return this.pipelineRunsService.getRunLogs(runId, {
      step,
      afterSeq: afterSeq ? parseInt(afterSeq, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}

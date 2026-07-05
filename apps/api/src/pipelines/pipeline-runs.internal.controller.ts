import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { PipelineRunsService } from './pipeline-runs.service.js';

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class PipelineRunsInternalController {
  constructor(private readonly pipelineRunsService: PipelineRunsService) {}

  @Public()
  @Patch('pipeline-runs/:runId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update pipeline run status (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        started_at: { type: 'string' },
        completed_at: { type: 'string' },
        error_message: { type: 'string' },
      },
    },
  })
  @ApiOkResponse({ description: 'Pipeline run updated' })
  async updateRun(
    @Param('runId') runId: string,
    @Body() body: { status?: string; started_at?: string; completed_at?: string; error_message?: string },
  ): Promise<{ success: true }> {
    await this.pipelineRunsService.updateRunInternal(runId, body);
    return { success: true };
  }

  @Public()
  @Patch('pipeline-runs/:runId/steps/:stepId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update pipeline step status (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        started_at: { type: 'string' },
        completed_at: { type: 'string' },
        error_message: { type: 'string' },
        result_text: { type: 'string' },
        result_json: { type: 'object' },
        exit_code: { type: 'number' },
        duration_ms: { type: 'number' },
        output_json: { type: 'object' },
      },
    },
  })
  @ApiOkResponse({ description: 'Pipeline step updated' })
  async updateStep(
    @Param('runId') runId: string,
    @Param('stepId') stepId: string,
    @Body()
    body: {
      status?: string;
      started_at?: string;
      completed_at?: string;
      error_message?: string;
      result_text?: string;
      result_json?: Record<string, unknown>;
      exit_code?: number;
      duration_ms?: number;
      output_json?: Record<string, unknown>;
    },
  ): Promise<{ success: true }> {
    await this.pipelineRunsService.updateStepInternal(runId, stepId, body);
    return { success: true };
  }

  @Public()
  @Post('pipeline-runs/:runId/steps/:stepId/logs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append pipeline step log (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        log_type: { type: 'string' },
        content: { type: 'object' },
      },
      required: ['log_type', 'content'],
    },
  })
  @ApiOkResponse({ description: 'Log appended successfully' })
  async appendLog(
    @Param('runId') runId: string,
    @Param('stepId') stepId: string,
    @Body() body: { log_type: string; content: Record<string, unknown> },
  ): Promise<{ success: true }> {
    await this.pipelineRunsService.appendStepLog(runId, stepId, body.log_type, body.content);
    return { success: true };
  }
}

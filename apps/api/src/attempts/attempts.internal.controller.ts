import {
  Controller,
  Post,
  Patch,
  Param,
  HttpCode,
  HttpStatus,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { AttemptsService } from './attempts.service.js';

/**
 * Internal API for worker operations.
 * These endpoints are used by workers to report execution state.
 * Also available for integration tests that need to simulate worker behavior.
 */
@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class AttemptsInternalController {
  constructor(private readonly attemptsService: AttemptsService) {}

  @Public()
  @Post('attempts/:attempt_id/logs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append execution log to attempt (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        log_type: { type: 'string', description: 'Type of log entry (e.g., status, error, lifecycle_workspace_start)' },
        content: { type: 'object', description: 'Log content as JSON object' },
      },
      required: ['log_type', 'content'],
    },
  })
  @ApiOkResponse({ description: 'Log appended successfully' })
  async appendLog(
    @Param('attempt_id') attemptId: string,
    @Body() body: { log_type: string; content: Record<string, unknown> },
  ): Promise<{ success: true }> {
    await this.attemptsService.appendLog(attemptId, body.log_type, body.content);
    return { success: true };
  }

  @Public()
  @Patch('attempts/:attempt_id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update attempt status and result (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed'] },
        result_json: { type: 'object', description: 'Attempt result as JSON' },
        result_summary: { type: 'string', description: 'Human-readable result summary' },
      },
    },
  })
  @ApiOkResponse({ description: 'Attempt updated successfully' })
  async updateAttempt(
    @Param('attempt_id') attemptId: string,
    @Body() body: { status?: string; result_json?: Record<string, unknown>; result_summary?: string },
  ): Promise<{ success: true }> {
    await this.attemptsService.updateAttemptInternal(attemptId, body);
    return { success: true };
  }

  @Public()
  @Post('jobs/:job_id/requeue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Requeue a job to ready phase (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent requesting the requeue' },
        reason: { type: 'string', description: 'Reason for requeue' },
      },
      required: ['agent_id'],
    },
  })
  @ApiOkResponse({ description: 'Job requeued successfully' })
  async requeueJob(
    @Param('job_id') jobId: string,
    @Body() body: { agent_id: string; reason?: string },
  ): Promise<{ success: true }> {
    await this.attemptsService.requeueJob(jobId, body.agent_id, body.reason);
    return { success: true };
  }
}

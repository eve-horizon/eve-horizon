import {
  Controller,
  Body,
  Param,
  Query,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
  NotFoundException,
} from '@nestjs/common';
import { parseBoolean } from '../common/query-params.js';
import {
  ApiNotFoundResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Endpoint } from '../common/endpoint.decorator.js';
import { AttemptsService } from './attempts.service.js';
import {
  ContinueAttemptRequestSchema,
  AttemptResponseSchema,
  AttemptListResponseSchema,
  LogsResponseSchema,
  type ContinueAttemptRequest,
  type AttemptResponse,
  type AttemptListResponse,
  type LogsResponse,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

/**
 * Attempts Controller - Adapted for the new Jobs schema
 *
 * NOTE: The new Jobs system uses string job IDs instead of integer job numbers.
 * Routes have been updated to use :job_id instead of :job_num.
 */
@ApiTags('attempts')
@ApiBearerAuth()
@Controller('projects/:project_id/jobs/:job_id/attempts')
export class AttemptsController {
  constructor(private readonly attemptsService: AttemptsService) {}

  @Endpoint({
    method: 'POST',
    permission: 'jobs:write',
    status: HttpStatus.CREATED,
    summary: 'Create a new attempt for a job',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
      ApiParam({ name: 'job_id', description: 'Job ID', type: String }),
    ],
    responseDescription: 'Attempt created',
    response: AttemptResponseSchema,
    responseName: 'AttemptResponse',
  })
  async create(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string
  ): Promise<AttemptResponse> {
    return this.attemptsService.create(projectId, jobId);
  }

  @Endpoint({
    method: 'GET',
    permission: 'jobs:read',
    summary: 'List attempts for a job',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
      ApiParam({ name: 'job_id', description: 'Job ID', type: String }),
      ApiQuery({ name: 'limit', required: false, schema: { type: 'number', default: 10 } }),
      ApiQuery({ name: 'offset', required: false, schema: { type: 'number', default: 0 } }),
      ApiQuery({ name: 'include_deleted', required: false }),
    ],
    responseDescription: 'Attempt list',
    response: AttemptListResponseSchema,
    responseName: 'AttemptListResponse',
  })
  async list(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('include_deleted') includeDeleted?: string,
  ): Promise<AttemptListResponse> {
    return this.attemptsService.list(projectId, jobId, {
      limit,
      offset,
      include_deleted: parseBoolean(includeDeleted),
    });
  }

  @Endpoint({
    method: 'GET',
    path: ':att_num',
    permission: 'jobs:read',
    summary: 'Get an attempt by number',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
      ApiParam({ name: 'job_id', description: 'Job ID', type: String }),
      ApiParam({ name: 'att_num', description: 'Attempt number', type: Number }),
      ApiQuery({ name: 'include_deleted', required: false }),
      ApiNotFoundResponse({ description: 'Attempt not found' }),
    ],
    responseDescription: 'Attempt details',
    response: AttemptResponseSchema,
    responseName: 'AttemptResponse',
  })
  async findByNumber(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string,
    @Param('att_num', ParseIntPipe) attNum: number,
    @Query('include_deleted') includeDeleted?: string,
  ): Promise<AttemptResponse> {
    const attempt = await this.attemptsService.findByNumber(
      projectId,
      jobId,
      attNum,
      parseBoolean(includeDeleted),
    );
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attNum} not found for job ${jobId}`);
    }
    return attempt;
  }

  @Endpoint({
    method: 'POST',
    path: ':att_num/continue',
    permission: 'jobs:write',
    summary: 'Continue an attempt with follow-up input',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
      ApiParam({ name: 'job_id', description: 'Job ID', type: String }),
      ApiParam({ name: 'att_num', description: 'Attempt number', type: Number }),
    ],
    body: ContinueAttemptRequestSchema,
    bodyName: 'ContinueAttemptRequest',
    responseDescription: 'Attempt continued',
    response: AttemptResponseSchema,
    responseName: 'AttemptResponse',
  })
  async continue(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string,
    @Param('att_num', ParseIntPipe) attNum: number,
    @Body(new ZodValidationPipe(ContinueAttemptRequestSchema)) body: ContinueAttemptRequest
  ): Promise<AttemptResponse> {
    return this.attemptsService.continue(projectId, jobId, attNum, body);
  }

  @Endpoint({
    method: 'GET',
    path: ':att_num/logs',
    permission: 'jobs:read',
    summary: 'Get attempt logs (optionally after a sequence)',
    extraDecorators: [
      ApiParam({ name: 'project_id', description: 'Project ID', type: String }),
      ApiParam({ name: 'job_id', description: 'Job ID', type: String }),
      ApiParam({ name: 'att_num', description: 'Attempt number', type: Number }),
      ApiQuery({ name: 'after', required: false, description: 'Return logs after this sequence number' }),
    ],
    responseDescription: 'Logs response',
    response: LogsResponseSchema,
    responseName: 'LogsResponse',
  })
  async getLogs(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string,
    @Param('att_num', ParseIntPipe) attNum: number,
    @Query('after') after?: string
  ): Promise<LogsResponse> {
    const afterSequence = after ? parseInt(after, 10) : undefined;
    return this.attemptsService.getLogs(projectId, jobId, attNum, afterSequence);
  }
}

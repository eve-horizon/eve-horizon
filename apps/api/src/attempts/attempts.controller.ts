import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  DefaultValuePipe,
  NotFoundException,
} from '@nestjs/common';
import { parseBoolean } from '../common/query-params.js';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiNotFoundResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
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
import { zodSchemaToOpenApi } from '../openapi.js';

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

  @RequirePermission('jobs:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new attempt for a job' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiCreatedResponse({
    description: 'Attempt created',
    schema: zodSchemaToOpenApi(AttemptResponseSchema, 'AttemptResponse'),
  })
  async create(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string
  ): Promise<AttemptResponse> {
    return this.attemptsService.create(projectId, jobId);
  }

  @RequirePermission('jobs:read')
  @Get()
  @ApiOperation({ summary: 'List attempts for a job' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'number', default: 10 } })
  @ApiQuery({ name: 'offset', required: false, schema: { type: 'number', default: 0 } })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiOkResponse({
    description: 'Attempt list',
    schema: zodSchemaToOpenApi(AttemptListResponseSchema, 'AttemptListResponse'),
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

  @RequirePermission('jobs:read')
  @Get(':att_num')
  @ApiOperation({ summary: 'Get an attempt by number' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'att_num', description: 'Attempt number', type: Number })
  @ApiQuery({ name: 'include_deleted', required: false })
  @ApiOkResponse({
    description: 'Attempt details',
    schema: zodSchemaToOpenApi(AttemptResponseSchema, 'AttemptResponse'),
  })
  @ApiNotFoundResponse({ description: 'Attempt not found' })
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

  @RequirePermission('jobs:write')
  @Post(':att_num/continue')
  @ApiOperation({ summary: 'Continue an attempt with follow-up input' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'att_num', description: 'Attempt number', type: Number })
  @ApiBody({ schema: zodSchemaToOpenApi(ContinueAttemptRequestSchema, 'ContinueAttemptRequest') })
  @ApiOkResponse({
    description: 'Attempt continued',
    schema: zodSchemaToOpenApi(AttemptResponseSchema, 'AttemptResponse'),
  })
  async continue(
    @Param('project_id') projectId: string,
    @Param('job_id') jobId: string,
    @Param('att_num', ParseIntPipe) attNum: number,
    @Body(new ZodValidationPipe(ContinueAttemptRequestSchema)) body: ContinueAttemptRequest
  ): Promise<AttemptResponse> {
    return this.attemptsService.continue(projectId, jobId, attNum, body);
  }

  @RequirePermission('jobs:read')
  @Get(':att_num/logs')
  @ApiOperation({ summary: 'Get attempt logs (optionally after a sequence)' })
  @ApiParam({ name: 'project_id', description: 'Project ID', type: String })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'att_num', description: 'Attempt number', type: Number })
  @ApiQuery({ name: 'after', required: false, description: 'Return logs after this sequence number' })
  @ApiOkResponse({
    description: 'Logs response',
    schema: zodSchemaToOpenApi(LogsResponseSchema, 'LogsResponse'),
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

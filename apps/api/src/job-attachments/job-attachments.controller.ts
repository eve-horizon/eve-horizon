import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import {
  CreateJobAttachmentRequestSchema,
  JobAttachmentDetailResponseSchema,
  JobAttachmentListResponseSchema,
  type CreateJobAttachmentRequest,
  type JobAttachmentDetailResponse,
  type JobAttachmentListResponse,
} from '@eve/shared';
import { JobAttachmentsService } from './job-attachments.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('job-attachments')
@ApiBearerAuth()
@Controller()
export class JobAttachmentsController {
  constructor(private readonly service: JobAttachmentsService) {}

  @RequirePermission('jobs:write')
  @Post('jobs/:job_id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a job attachment' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateJobAttachmentRequestSchema, 'CreateJobAttachmentRequest') })
  @ApiCreatedResponse({
    description: 'Attachment created',
    schema: zodSchemaToOpenApi(JobAttachmentDetailResponseSchema, 'JobAttachmentDetailResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async create(
    @Param('job_id') jobId: string,
    @Body() body: CreateJobAttachmentRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<JobAttachmentDetailResponse> {
    return this.service.create(jobId, body, caller?.user_id);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attachments')
  @ApiOperation({ summary: 'List job attachments (metadata only)' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiOkResponse({
    description: 'Attachment list',
    schema: zodSchemaToOpenApi(JobAttachmentListResponseSchema, 'JobAttachmentListResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async list(
    @Param('job_id') jobId: string,
  ): Promise<JobAttachmentListResponse> {
    return this.service.list(jobId);
  }

  @RequirePermission('jobs:read')
  @Get('jobs/:job_id/attachments/:att_id')
  @ApiOperation({ summary: 'Get a job attachment with content' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'att_id', description: 'Attachment UUID', type: String })
  @ApiOkResponse({
    description: 'Attachment with content',
    schema: zodSchemaToOpenApi(JobAttachmentDetailResponseSchema, 'JobAttachmentDetailResponse'),
  })
  @ApiNotFoundResponse({ description: 'Job or attachment not found' })
  async findById(
    @Param('job_id') jobId: string,
    @Param('att_id') attId: string,
  ): Promise<JobAttachmentDetailResponse> {
    return this.service.findById(jobId, attId);
  }

  @RequirePermission('jobs:write')
  @Delete('jobs/:job_id/attachments/:att_id')
  @ApiOperation({ summary: 'Delete a job attachment' })
  @ApiParam({ name: 'job_id', description: 'Job ID', type: String })
  @ApiParam({ name: 'att_id', description: 'Attachment UUID', type: String })
  @ApiOkResponse({ description: 'Attachment deleted' })
  @ApiNotFoundResponse({ description: 'Job or attachment not found' })
  async delete(
    @Param('job_id') jobId: string,
    @Param('att_id') attId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.service.delete(jobId, attId);
  }
}

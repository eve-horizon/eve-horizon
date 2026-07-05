import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  HttpCode,
  HttpStatus,
  Body,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import {
  CreateEventRequestSchema,
  EventResponseSchema,
  EventListResponseSchema,
  type CreateEventRequest,
  type EventResponse,
  type EventListResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { EventsService } from './events.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

@ApiTags('internal')
@Controller('internal/projects/:project_id/events')
@UseGuards(InternalTokenGuard)
export class EventsInternalController {
  constructor(private readonly eventsService: EventsService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an event for a project (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateEventRequestSchema, 'CreateEventRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(EventResponseSchema, 'EventResponse') })
  async create(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateEventRequestSchema)) body: CreateEventRequest,
  ): Promise<EventResponse> {
    return this.eventsService.create(projectId, body);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'List events for a project (internal only)' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by event type' })
  @ApiQuery({ name: 'source', required: false, description: 'Filter by event source' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by event status' })
  @ApiQuery({ name: 'attempt_id', required: false, description: 'Filter by payload attemptId' })
  @ApiQuery({ name: 'since', required: false, description: 'Filter events created at or after this ISO timestamp' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Event list',
    schema: zodSchemaToOpenApi(EventListResponseSchema, 'EventListResponse'),
  })
  async list(
    @Param('project_id') projectId: string,
    @Query('type') type?: string,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('attempt_id') attemptId?: string,
    @Query('since') since?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<EventListResponse> {
    return this.eventsService.list(projectId, {
      type,
      source,
      status,
      attemptId,
      since,
      limit,
      offset,
    });
  }

  @Public()
  @Patch(':event_id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Link a job to an event (internal only)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
  })
  @ApiOkResponse({ description: 'Event updated' })
  async linkJob(
    @Param('project_id') _projectId: string,
    @Param('event_id') eventId: string,
    @Body() body: { job_id: string },
  ): Promise<{ success: true }> {
    await this.eventsService.linkJobToEvent(eventId, body.job_id);
    return { success: true };
  }
}

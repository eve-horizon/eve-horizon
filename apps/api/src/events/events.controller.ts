import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { EventsService } from './events.service.js';
import {
  CreateEventRequestSchema,
  EventResponseSchema,
  EventListResponseSchema,
  type CreateEventRequest,
  type EventResponse,
  type EventListResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';

@ApiTags('events')
@ApiBearerAuth()
@Controller('projects/:id/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @RequirePermission('events:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an event for a project' })
  @ApiBody({
    schema: zodSchemaToOpenApi(CreateEventRequestSchema, 'CreateEventRequest'),
  })
  @ApiCreatedResponse({
    description: 'Event created',
    schema: zodSchemaToOpenApi(EventResponseSchema, 'EventResponse'),
  })
  async create(
    @Param('id') projectId: string,
    @Body(new ZodValidationPipe(CreateEventRequestSchema)) body: CreateEventRequest,
  ): Promise<EventResponse> {
    return this.eventsService.create(projectId, body);
  }

  @RequirePermission('events:read')
  @Get()
  @ApiOperation({ summary: 'List events for a project' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by event type' })
  @ApiQuery({ name: 'source', required: false, description: 'Filter by event source' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by event status' })
  @ApiQuery({ name: 'since', required: false, description: 'Filter events created at or after this ISO timestamp' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({
    description: 'Event list',
    schema: zodSchemaToOpenApi(EventListResponseSchema, 'EventListResponse'),
  })
  async list(
    @Param('id') projectId: string,
    @Query('type') type?: string,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ): Promise<EventListResponse> {
    return this.eventsService.list(projectId, {
      type,
      source,
      status,
      since,
      limit,
      offset,
    });
  }

  @RequirePermission('events:read')
  @Get(':eventId')
  @ApiOperation({ summary: 'Get event by ID' })
  @ApiOkResponse({
    description: 'Event details',
    schema: zodSchemaToOpenApi(EventResponseSchema, 'EventResponse'),
  })
  async findById(
    @Param('id') projectId: string,
    @Param('eventId') eventId: string,
  ): Promise<EventResponse> {
    const event = await this.eventsService.findById(projectId, eventId);
    if (!event) {
      throw new NotFoundException(
        `Event ${eventId} not found for project ${projectId}`,
      );
    }
    return event;
  }
}

import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { eventQueries, projectQueries } from '@eve/db';
import {
  generateEventId,
  type CreateEventRequest,
  type EventResponse,
  type EventListResponse,
} from '@eve/shared';

@Injectable()
export class EventsService {
  private events: ReturnType<typeof eventQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.events = eventQueries(db);
    this.projects = projectQueries(db);
  }

  async create(
    projectId: string,
    data: CreateEventRequest,
  ): Promise<EventResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const eventId = generateEventId();
    const event = await this.events.create({
      id: eventId,
      project_id: projectId,
      type: data.type,
      source: data.source,
      env_name: data.env_name ?? null,
      ref_sha: data.ref_sha ?? null,
      ref_branch: data.ref_branch ?? null,
      actor_type: data.actor_type ?? null,
      actor_id: data.actor_id ?? null,
      payload_json: data.payload_json ?? null,
      dedupe_key: data.dedupe_key ?? null,
    });

    return this.toEventResponse(event);
  }

  async list(
    projectId: string,
    options: {
      type?: string;
      source?: string;
      status?: string;
      attemptId?: string;
      since?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<EventListResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const events = await this.events.list(projectId, {
      type: options.type,
      source: options.source as any,
      status: options.status as any,
      attemptId: options.attemptId,
      since: options.since,
      limit,
      offset,
    });

    return {
      data: events.map((event) => this.toEventResponse(event)),
      pagination: {
        limit,
        offset,
        count: events.length,
      },
    };
  }

  async findById(
    projectId: string,
    eventId: string,
  ): Promise<EventResponse | null> {
    const event = await this.events.findById(eventId);
    if (!event) {
      return null;
    }

    // Verify event belongs to the project
    if (event.project_id !== projectId) {
      return null;
    }

    return this.toEventResponse(event);
  }

  async linkJobToEvent(eventId: string, jobId: string): Promise<void> {
    await this.events.linkJobToEvent(eventId, jobId);
  }

  private toEventResponse(
    event: Awaited<ReturnType<typeof this.events.findById>> & object,
  ): EventResponse {
    return {
      id: event.id,
      project_id: event.project_id,
      type: event.type,
      source: event.source as any,
      env_name: event.env_name,
      ref_sha: event.ref_sha,
      ref_branch: event.ref_branch,
      actor_type: event.actor_type as any,
      actor_id: event.actor_id,
      payload_json: event.payload_json,
      dedupe_key: event.dedupe_key,
      job_id: event.job_id ?? null,
      trigger_match_count: event.trigger_match_count ?? null,
      triggers_evaluated: event.triggers_evaluated ?? null,
      status: event.status,
      processed_at: event.processed_at?.toISOString() ?? null,
      created_at: event.created_at.toISOString(),
      updated_at: event.updated_at.toISOString(),
    };
  }
}

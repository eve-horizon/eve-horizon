import { Inject, Injectable, MessageEvent, NotFoundException } from '@nestjs/common';
import { Observable, concatMap, from, interval, map, merge, share, timer } from 'rxjs';
import type { ConversationEvent, Db } from '@eve/db';
import { conversationEventQueries, threadQueries } from '@eve/db';
import type {
  ConversationEventListResponse,
  ConversationEventResponse,
  CreateConversationEventRequest,
  ThreadResponse,
} from '@eve/shared';

export interface ConversationEventFilters {
  after?: string;
  kinds?: string[];
  jobId?: string;
  attemptId?: string;
  workflowStep?: string;
  source?: string;
  limit?: number;
}

@Injectable()
export class ConversationEventsService {
  private threads: ReturnType<typeof threadQueries>;
  private conversationEvents: ReturnType<typeof conversationEventQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.threads = threadQueries(db);
    this.conversationEvents = conversationEventQueries(db);
  }

  async listEvents(threadId: string, filters: ConversationEventFilters = {}): Promise<ConversationEventListResponse> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const afterSeq = await this.resolveAfterSeq(threadId, filters.after);
    const [events, total] = await Promise.all([
      this.conversationEvents.listByThread(threadId, {
        afterSeq,
        kinds: filters.kinds,
        jobId: filters.jobId,
        attemptId: filters.attemptId,
        workflowStep: filters.workflowStep,
        source: filters.source,
        limit: filters.limit,
      }),
      this.conversationEvents.countByThread(threadId, {
        kinds: filters.kinds,
        jobId: filters.jobId,
        attemptId: filters.attemptId,
        workflowStep: filters.workflowStep,
        source: filters.source,
      }),
    ]);

    return {
      events: events.map(event => this.toConversationEventResponse(event)),
      total,
    };
  }

  async createEvent(
    threadId: string,
    data: CreateConversationEventRequest,
  ): Promise<ConversationEventResponse> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const created = await this.conversationEvents.create({
      thread_id: thread.id,
      project_id: thread.project_id ?? null,
      org_id: thread.org_id ?? null,
      kind: data.kind,
      source: data.source ?? 'app',
      actor_type: data.actor_type ?? null,
      actor_id: data.actor_id ?? null,
      job_id: data.job_id ?? null,
      attempt_id: data.attempt_id ?? null,
      agent_id: data.agent_id ?? null,
      workflow_step: data.workflow_step ?? null,
      run_id: data.run_id ?? null,
      text: data.text ?? null,
      delivery_status: data.delivery_status ?? null,
      payload_json: data.payload ?? {},
    });

    return this.toConversationEventResponse(created);
  }

  streamEvents(
    threadId: string,
    filters: ConversationEventFilters = {},
    lastEventId?: string,
  ): Observable<MessageEvent> {
    let initialized = false;
    let lastSeenSeq: number | undefined;
    const resumeCursor = lastEventId ?? filters.after;

    const updates$ = timer(0, 1000).pipe(
      concatMap(() =>
        from((async () => {
          if (!initialized) {
            const thread = await this.threads.findById(threadId);
            if (!thread) {
              throw new NotFoundException(`Thread ${threadId} not found`);
            }

            const afterSeq = await this.resolveAfterSeq(threadId, resumeCursor);
            if (afterSeq !== undefined) {
              const replay = await this.conversationEvents.listByThread(threadId, {
                ...this.toQueryFilters(filters),
                afterSeq,
                limit: filters.limit ?? 100,
              });
              const last = replay[replay.length - 1];
              lastSeenSeq = last ? this.eventSeq(last) : afterSeq;
              initialized = true;
              return replay.map(event => this.toSseEvent(event));
            }

            const snapshotEvents = await this.conversationEvents.listByThread(threadId, {
              ...this.toQueryFilters(filters),
              limit: filters.limit ?? 100,
            });
            const last = snapshotEvents[snapshotEvents.length - 1];
            lastSeenSeq = last ? this.eventSeq(last) : 0;
            initialized = true;
            return [
              {
                id: last ? this.eventCursor(last) : undefined,
                type: 'snapshot',
                data: {
                  thread: this.toThreadResponse(thread),
                  events: snapshotEvents.map(event => this.toConversationEventResponse(event)),
                },
              } satisfies MessageEvent,
            ];
          }

          const next = await this.conversationEvents.listByThread(threadId, {
            ...this.toQueryFilters(filters),
            afterSeq: lastSeenSeq ?? 0,
            limit: 100,
          });
          const last = next[next.length - 1];
          if (last) lastSeenSeq = this.eventSeq(last);
          return next.map(event => this.toSseEvent(event));
        })()),
      ),
      concatMap(events => from(events)),
    );

    const heartbeat$ = interval(15000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: {},
      } satisfies MessageEvent)),
    );

    return merge(updates$, heartbeat$).pipe(share());
  }

  toConversationEventResponse(event: ConversationEvent): ConversationEventResponse {
    const seq = this.eventSeq(event);
    return {
      id: event.id,
      cursor: String(seq),
      seq,
      thread_id: event.thread_id,
      project_id: event.project_id ?? null,
      org_id: event.org_id ?? null,
      kind: event.kind,
      source: event.source,
      actor_type: event.actor_type ?? null,
      actor_id: event.actor_id ?? null,
      job_id: event.job_id ?? null,
      attempt_id: event.attempt_id ?? null,
      agent_id: event.agent_id ?? null,
      workflow_step: event.workflow_step ?? null,
      run_id: event.run_id ?? null,
      message_id: event.message_id ?? null,
      event_id: event.event_id ?? null,
      log_id: event.log_id ?? null,
      attachment_id: event.attachment_id ?? null,
      text: event.text ?? null,
      delivery_status: event.delivery_status ?? null,
      payload: event.payload_json ?? {},
      created_at: event.created_at.toISOString(),
    };
  }

  private async resolveAfterSeq(threadId: string, cursor?: string): Promise<number | undefined> {
    if (!cursor) return undefined;
    if (/^\d+$/.test(cursor)) return Number.parseInt(cursor, 10);
    const event = await this.conversationEvents.findByThreadAndCursor(threadId, cursor);
    return event ? this.eventSeq(event) : undefined;
  }

  private toQueryFilters(filters: ConversationEventFilters) {
    return {
      kinds: filters.kinds,
      jobId: filters.jobId,
      attemptId: filters.attemptId,
      workflowStep: filters.workflowStep,
      source: filters.source,
    };
  }

  private toSseEvent(event: ConversationEvent): MessageEvent {
    const data = this.toConversationEventResponse(event);
    return {
      id: data.cursor,
      type: data.kind,
      data,
    };
  }

  private eventSeq(event: ConversationEvent): number {
    return typeof event.seq === 'number' ? event.seq : Number.parseInt(event.seq, 10);
  }

  private eventCursor(event: ConversationEvent): string {
    return String(this.eventSeq(event));
  }

  private toThreadResponse(thread: {
    id: string;
    project_id: string | null;
    key: string;
    channel: string | null;
    peer: string | null;
    policy_json: Record<string, unknown> | null;
    summary: string | null;
    workspace_key: string | null;
    metadata_json?: Record<string, unknown> | null;
    org_id?: string | null;
    scope?: string;
    created_at: Date;
    updated_at: Date;
  }): ThreadResponse {
    return {
      id: thread.id,
      project_id: thread.project_id ?? null,
      org_id: thread.org_id ?? null,
      scope: thread.scope ?? 'project',
      key: thread.key,
      channel: thread.channel ?? null,
      peer: thread.peer ?? null,
      policy: thread.policy_json ?? null,
      summary: thread.summary ?? null,
      workspace_key: thread.workspace_key ?? null,
      metadata: thread.metadata_json ?? null,
      created_at: thread.created_at.toISOString(),
      updated_at: thread.updated_at.toISOString(),
    };
  }
}

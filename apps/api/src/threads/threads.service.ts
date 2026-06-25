import { Injectable, Inject, MessageEvent, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Observable, concatMap, from, interval, map, merge, share, timer } from 'rxjs';
import type { Db } from '@eve/db';
import { threadQueries, threadMessageQueries, eventQueries } from '@eve/db';
import {
  generateEventId,
  generateThreadId,
  type ThreadResponse,
  type ThreadMessageResponse,
  type ThreadMessageListResponse,
} from '@eve/shared';

@Injectable()
export class ThreadsService {
  private threads: ReturnType<typeof threadQueries>;
  private messages: ReturnType<typeof threadMessageQueries>;
  private events: ReturnType<typeof eventQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.threads = threadQueries(db);
    this.messages = threadMessageQueries(db);
    this.events = eventQueries(db);
  }

  async findById(threadId: string): Promise<ThreadResponse | null> {
    const thread = await this.threads.findById(threadId);
    if (!thread) return null;
    return this.toThreadResponse(thread);
  }

  async findByProjectAndKey(projectId: string, key: string): Promise<ThreadResponse | null> {
    const thread = await this.threads.findByProjectAndKey(projectId, key);
    if (!thread) return null;
    return this.toThreadResponse(thread);
  }

  async ensureThread(
    projectId: string,
    key: string,
    channel?: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<ThreadResponse> {
    let thread = await this.threads.findByProjectAndKey(projectId, key);
    if (thread) {
      if (metadata) {
        const merged = { ...((thread.metadata_json as Record<string, unknown> | null) ?? {}), ...metadata };
        thread = await this.threads.updateMetadata(thread.id, merged) ?? thread;
      }
      return this.toThreadResponse(thread);
    }

    try {
      thread = await this.threads.create({
        id: generateThreadId(),
        project_id: projectId,
        key,
        channel: channel ?? null,
        peer: null,
        policy_json: null,
        summary: null,
        workspace_key: null,
        metadata_json: metadata ?? null,
        org_id: null,
        scope: 'project',
      });
      return this.toThreadResponse(thread);
    } catch {
      // Race condition: thread was created between check and insert
      const existing = await this.threads.findByProjectAndKey(projectId, key);
      if (existing) return this.toThreadResponse(existing);
      throw new Error(`Failed to create thread with key ${key}`);
    }
  }

  async updateMetadata(threadId: string, metadata: Record<string, unknown>): Promise<ThreadResponse> {
    const thread = await this.threads.updateMetadata(threadId, metadata);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    return this.toThreadResponse(thread);
  }

  async listMessages(threadId: string, options?: {
    since?: Date;
    limit?: number;
    offset?: number;
  }): Promise<ThreadMessageListResponse> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const [messages, total] = await Promise.all([
      this.messages.listByThread(threadId, options),
      this.messages.countByThread(threadId, options?.since),
    ]);

    return {
      messages: messages.map(m => this.toThreadMessageResponse(m)),
      total,
    };
  }

  async createMessage(threadId: string, data: {
    direction: 'inbound' | 'outbound';
    kind?: 'message' | 'progress';
    actor_type?: string | null;
    actor_id?: string | null;
    body: string;
    job_id?: string | null;
  }): Promise<ThreadMessageResponse> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }

    const created = await this.messages.create({
      id: crypto.randomUUID(),
      thread_id: threadId,
      direction: data.direction,
      kind: data.kind ?? 'message',
      actor_type: data.actor_type ?? null,
      actor_id: data.actor_id ?? null,
      body: data.body,
      job_id: data.job_id ?? null,
    });

    await this.threads.touch(threadId);

    const eventId = generateEventId();
    if (!thread.project_id) {
      // Org-scoped threads don't emit project events yet
      return this.toThreadMessageResponse(created);
    }
    await this.events.create({
      id: eventId,
      project_id: thread.project_id,
      type: data.direction === 'outbound' ? 'chat.message.sent' : 'chat.message.received',
      source: 'chat',
      env_name: null,
      ref_sha: null,
      ref_branch: null,
      actor_type: data.actor_type ?? null,
      actor_id: data.actor_id ?? null,
      payload_json: {
        thread_id: thread.id,
        direction: data.direction,
        kind: data.kind ?? 'message',
        body: data.body,
        job_id: data.job_id ?? null,
      },
      dedupe_key: null,
    });

    return this.toThreadMessageResponse(created);
  }

  streamMessages(threadId: string, lastEventId?: string): Observable<MessageEvent> {
    let initialized = false;
    let lastSeenMessageId = lastEventId;

    const updates$ = timer(0, 1000).pipe(
      concatMap(() =>
        from((async () => {
          if (!initialized) {
            const thread = await this.findById(threadId);
            if (!thread) {
              throw new NotFoundException(`Thread ${threadId} not found`);
            }

            if (lastEventId) {
              const anchor = await this.messages.findByThreadAndId(threadId, lastEventId);
              if (anchor) {
                const replay = await this.messages.listAfterMessageId(threadId, lastEventId, { limit: 100 });
                const last = replay[replay.length - 1];
                if (last) lastSeenMessageId = last.id;
                initialized = true;
                return replay.map((message) => this.toSseMessageEvent(message));
              }
            }

            const snapshot = await this.listMessages(threadId, { limit: 50 });
            const last = snapshot.messages[snapshot.messages.length - 1];
            lastSeenMessageId = last?.id;
            initialized = true;
            return [
              {
                id: last?.id,
                type: 'snapshot',
                data: {
                  thread,
                  messages: snapshot.messages,
                },
              } satisfies MessageEvent,
            ];
          }

          const next = lastSeenMessageId
            ? await this.messages.listAfterMessageId(threadId, lastSeenMessageId, { limit: 100 })
            : await this.messages.listByThread(threadId, { limit: 100 });
          const last = next[next.length - 1];
          if (last) lastSeenMessageId = last.id;
          return next.map((message) => this.toSseMessageEvent(message));
        })()),
      ),
      concatMap((events) => from(events)),
    );

    const heartbeat$ = interval(15000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: {},
      } satisfies MessageEvent)),
    );

    return merge(updates$, heartbeat$).pipe(share());
  }

  async delete(threadId: string): Promise<void> {
    const thread = await this.threads.findById(threadId);
    if (!thread) {
      throw new NotFoundException(`Thread ${threadId} not found`);
    }
    await this.threads.hardDelete(threadId);
  }

  async findByOrgAndKey(orgId: string, key: string): Promise<ThreadResponse | null> {
    const canonicalKey = this.canonicalizeOrgKey(orgId, key);
    const thread = await this.threads.findByOrgAndKey(orgId, canonicalKey);
    if (!thread) return null;
    return this.toThreadResponse(thread);
  }

  async ensureOrgThread(orgId: string, key: string, channel?: string | null): Promise<ThreadResponse> {
    const canonicalKey = this.canonicalizeOrgKey(orgId, key);
    let thread = await this.threads.findByOrgAndKey(orgId, canonicalKey);
    if (thread) return this.toThreadResponse(thread);

    try {
      thread = await this.threads.createOrgThread({
        id: generateThreadId(),
        org_id: orgId,
        key: canonicalKey,
        scope: 'org',
        channel: channel ?? null,
        peer: null,
        policy_json: null,
        summary: null,
        workspace_key: null,
      });
      return this.toThreadResponse(thread);
    } catch {
      // Race condition: thread was created between check and insert
      const existing = await this.threads.findByOrgAndKey(orgId, canonicalKey);
      if (existing) return this.toThreadResponse(existing);
      throw new Error(`Failed to create org thread with key ${key}`);
    }
  }

  async listOrgThreads(orgId: string, options: { limit?: number; offset?: number; keyPrefix?: string; scope?: string }): Promise<{ threads: ThreadResponse[] }> {
    // Canonicalize the key prefix so callers can use short keys (e.g. "agents:test:")
    // and still match stored canonical keys like "org:{orgId}:agents:test:..."
    const canonicalOpts = options.keyPrefix
      ? { ...options, keyPrefix: this.canonicalizeOrgKey(orgId, options.keyPrefix) }
      : options;
    const threads = await this.threads.listByOrg(orgId, canonicalOpts);
    return { threads: threads.map(t => this.toThreadResponse(t)) };
  }

  /**
   * Canonicalize a client-supplied key into the stored form.
   * Client sends: "agents:pm-status:FEAT-123"
   * Stored as:    "org:{org_id}:agents:pm-status:FEAT-123"
   */
  private canonicalizeOrgKey(orgId: string, key: string): string {
    if (key.startsWith(`org:${orgId}:`)) return key;
    return `org:${orgId}:${key}`;
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

  private toThreadMessageResponse(message: {
    id: string;
    thread_id: string;
    direction: string;
    kind?: string | null;
    actor_type: string | null;
    actor_id: string | null;
    body: string;
    job_id: string | null;
    delivery_status?: string | null;
    delivery_error?: string | null;
    delivered_at?: Date | null;
    created_at: Date;
  }): ThreadMessageResponse {
    return {
      id: message.id,
      thread_id: message.thread_id,
      direction: message.direction === 'outbound' ? 'outbound' : 'inbound',
      kind: message.kind === 'progress' ? 'progress' : 'message',
      actor_type: message.actor_type ?? null,
      actor_id: message.actor_id ?? null,
      body: message.body,
      job_id: message.job_id ?? null,
      delivery_status: message.delivery_status ?? null,
      delivery_error: message.delivery_error ?? null,
      delivered_at: message.delivered_at?.toISOString() ?? null,
      created_at: message.created_at.toISOString(),
    };
  }

  private toSseMessageEvent(message: {
    id: string;
    thread_id: string;
    direction: string;
    kind?: string | null;
    actor_type: string | null;
    actor_id: string | null;
    body: string;
    job_id: string | null;
    delivery_status?: string | null;
    delivery_error?: string | null;
    delivered_at?: Date | null;
    created_at: Date;
  }): MessageEvent {
    const data = this.toThreadMessageResponse(message);
    return {
      id: data.id,
      type: data.kind === 'progress' ? 'progress' : 'message',
      data,
    };
  }
}

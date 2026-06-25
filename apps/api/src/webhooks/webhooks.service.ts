import {
  Injectable,
  Inject,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Db } from '@eve/db';
import {
  webhookQueries,
  eventQueries,
  projectQueries,
  type WebhookSubscription,
  type WebhookDelivery,
} from '@eve/db';
import type {
  CreateWebhookRequest,
  WebhookResponse,
  WebhookListResponse,
  WebhookDeliveryResponse,
  WebhookDeliveryListResponse,
  CloudEventPayload,
  WebhookReplayRequest,
  WebhookReplayDryRunResponse,
  WebhookReplayResponse,
  WebhookReplayStatusResponse,
} from '@eve/shared';
import { buildApiError } from '../system/api-errors.js';

// ============================================================================
// Retry schedule: exponential backoff intervals in milliseconds
// ============================================================================

const RETRY_DELAYS_MS = [
  1 * 60_000,       // 1 minute
  5 * 60_000,       // 5 minutes
  30 * 60_000,      // 30 minutes
  2 * 60 * 60_000,  // 2 hours
  12 * 60 * 60_000, // 12 hours
];

const MAX_ATTEMPTS = 5;
const AUTO_DISABLE_THRESHOLD = 10;

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private queries: ReturnType<typeof webhookQueries>;
  private events: ReturnType<typeof eventQueries>;
  private projects: ReturnType<typeof projectQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.queries = webhookQueries(db);
    this.events = eventQueries(db);
    this.projects = projectQueries(db);
  }

  // ── Subscription CRUD ──────────────────────────────────────────────

  async createSubscription(
    orgId: string,
    data: CreateWebhookRequest,
    projectId?: string,
    createdBy?: string,
  ): Promise<WebhookResponse> {
    const sub = await this.queries.createSubscription({
      org_id: orgId,
      project_id: projectId ?? null,
      url: data.url,
      events: data.events,
      filter: data.filter,
      secret: data.secret, // TODO: encrypt at rest
      created_by: createdBy ?? null,
    });
    return this.toResponse(sub);
  }

  async getSubscription(orgId: string, webhookId: string): Promise<WebhookResponse> {
    const sub = await this.requireSubscription(orgId, webhookId);
    return this.toResponse(sub);
  }

  async listSubscriptions(orgId: string, projectId?: string): Promise<WebhookListResponse> {
    const subs = await this.queries.listSubscriptions(orgId, projectId);
    return { data: subs.map((s) => this.toResponse(s)) };
  }

  async deleteSubscription(orgId: string, webhookId: string): Promise<{ success: boolean; message: string }> {
    await this.requireSubscription(orgId, webhookId);
    const deleted = await this.queries.deleteSubscription(webhookId);
    if (!deleted) {
      throw new NotFoundException(`Webhook subscription not found: ${webhookId}`);
    }
    return { success: true, message: `Webhook ${webhookId} deleted` };
  }

  async enableSubscription(orgId: string, webhookId: string): Promise<WebhookResponse> {
    await this.requireSubscription(orgId, webhookId);
    await this.queries.enableSubscription(webhookId);
    const sub = await this.queries.findSubscriptionById(webhookId);
    return this.toResponse(sub!);
  }

  // ── Delivery log ───────────────────────────────────────────────────

  async listDeliveries(
    orgId: string,
    webhookId: string,
    limit?: number,
  ): Promise<WebhookDeliveryListResponse> {
    await this.requireSubscription(orgId, webhookId);
    const deliveries = await this.queries.listDeliveries(webhookId, limit);
    return { data: deliveries.map((d) => this.toDeliveryResponse(d)) };
  }

  // ── Replay + Backfill ─────────────────────────────────────────────

  async createReplay(
    orgId: string,
    webhookId: string,
    data: WebhookReplayRequest,
    requestId?: string,
    createdBy?: string,
  ): Promise<WebhookReplayResponse | WebhookReplayDryRunResponse> {
    const sub = await this.requireSubscription(orgId, webhookId);

    if (!sub.active) {
      throw buildApiError(409, 'resource_conflict', 'Webhook subscription is disabled', {
        requestId,
        details: { webhook_id: webhookId },
      });
    }

    const maxEvents = data.max_events ?? 5000;
    if (!Number.isFinite(maxEvents) || maxEvents <= 0 || maxEvents > 10000) {
      throw buildApiError(400, 'webhook_replay_window_invalid', 'max_events must be between 1 and 10000', {
        requestId,
        details: { max_events: maxEvents },
      });
    }

    const toTime = data.to?.time ? new Date(data.to.time) : new Date();
    if (Number.isNaN(toTime.getTime())) {
      throw buildApiError(400, 'webhook_replay_window_invalid', 'Invalid to.time value', {
        requestId,
        details: { to: data.to?.time },
      });
    }

    let fromTime = new Date(toTime.getTime() - 24 * 60 * 60 * 1000);
    let fromEventId: string | null = null;

    if (data.from?.event_id) {
      fromEventId = data.from.event_id;
      const event = await this.events.findById(fromEventId);
      if (!event) {
        throw buildApiError(404, 'resource_not_found', 'Event not found', {
          requestId,
          details: { event_id: fromEventId },
        });
      }
      const project = await this.projects.findById(event.project_id);
      if (!project || project.org_id !== orgId) {
        throw buildApiError(404, 'resource_not_found', 'Event not found in org', {
          requestId,
          details: { event_id: fromEventId },
        });
      }
      fromTime = event.created_at instanceof Date
        ? event.created_at
        : new Date(event.created_at);
    }

    if (fromTime > toTime) {
      throw buildApiError(400, 'webhook_replay_window_invalid', 'from time must be before to time', {
        requestId,
        details: { from: fromTime.toISOString(), to: toTime.toISOString() },
      });
    }

    const activeReplays = await this.queries.countActiveReplays(sub.id);
    if (activeReplays >= 3) {
      throw buildApiError(409, 'resource_conflict', 'Replay already in progress', {
        requestId,
        details: { webhook_id: webhookId },
      });
    }

    const events = await this.events.listForReplay({
      orgId,
      projectId: sub.project_id,
      fromTime,
      toTime,
      eventPatterns: sub.events,
      limit: maxEvents,
    });

    const eventIds = events.map((event) => event.id);
    const existing = new Set(
      await this.queries.listDeliveryEventIds(sub.id, eventIds),
    );
    const wouldDeduplicate = eventIds.filter((id) => existing.has(id)).length;

    if (data.dry_run) {
      return {
        event_count: events.length,
        earliest: events[0]?.created_at
          ? (events[0].created_at instanceof Date
            ? events[0].created_at.toISOString()
            : String(events[0].created_at))
          : null,
        latest: events.length > 0
          ? (events[events.length - 1].created_at instanceof Date
            ? events[events.length - 1].created_at.toISOString()
            : String(events[events.length - 1].created_at))
          : null,
        would_deduplicate: wouldDeduplicate,
      };
    }

    const replay = await this.queries.createReplay({
      subscription_id: sub.id,
      org_id: orgId,
      project_id: sub.project_id,
      status: 'running',
      requested: events.length,
      processed: 0,
      replayed: 0,
      deduplicated: wouldDeduplicate,
      failed: 0,
      from_event_id: fromEventId,
      from_time: fromTime,
      to_time: toTime,
      max_events: maxEvents,
      dry_run: false,
      created_by: createdBy ?? null,
      started_at: new Date(),
    });

    let replayed = 0;
    let deduplicated = 0;
    let failed = 0;

    for (const event of events) {
      if (existing.has(event.id)) {
        deduplicated += 1;
        continue;
      }

      const cloudEvent: CloudEventPayload = {
        specversion: '1.0',
        type: event.type,
        source: `eve://orgs/${orgId}/projects/${event.project_id}`,
        id: event.id,
        time: event.created_at instanceof Date
          ? event.created_at.toISOString()
          : String(event.created_at),
        data: event.payload_json ?? {},
      };

      try {
        await this.queries.createDelivery({
          subscription_id: sub.id,
          event_id: event.id,
          event_type: event.type,
          payload: cloudEvent as unknown as Record<string, unknown>,
        });
        replayed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'delivery_conflict') {
          deduplicated += 1;
        } else {
          failed += 1;
        }
      }
    }

    const completed = await this.queries.updateReplay(replay.id, {
      status: 'completed',
      processed: events.length,
      replayed,
      deduplicated,
      failed,
      completed_at: new Date(),
    });

    return {
      replay_id: replay.id,
      status: completed?.status ?? 'completed',
      requested: events.length,
      deduplicated,
      enqueued_at: replay.created_at instanceof Date
        ? replay.created_at.toISOString()
        : String(replay.created_at),
    };
  }

  async getReplayStatus(
    orgId: string,
    webhookId: string,
    replayId: string,
  ): Promise<WebhookReplayStatusResponse> {
    const sub = await this.requireSubscription(orgId, webhookId);
    const replay = await this.queries.findReplayById(replayId);
    if (!replay || replay.subscription_id !== sub.id) {
      throw buildApiError(404, 'resource_not_found', 'Replay not found', {
        details: { replay_id: replayId },
      });
    }
    return this.toReplayStatusResponse(replay);
  }

  // ── Test event ─────────────────────────────────────────────────────

  async sendTestEvent(orgId: string, webhookId: string): Promise<WebhookDeliveryResponse> {
    const sub = await this.requireSubscription(orgId, webhookId);
    const testPayload: CloudEventPayload = {
      specversion: '1.0',
      type: 'webhook.test',
      source: `eve://orgs/${orgId}`,
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      data: {
        message: 'This is a test webhook delivery from Eve Horizon.',
        subscription_id: webhookId,
      },
    };
    const delivery = await this.queries.createDelivery({
      subscription_id: sub.id,
      event_id: testPayload.id,
      event_type: 'webhook.test',
      payload: testPayload as unknown as Record<string, unknown>,
    });
    return this.toDeliveryResponse(delivery);
  }

  // ── Enqueue event ──────────────────────────────────────────────────

  /**
   * Enqueue deliveries for all subscriptions matching a given event.
   * Called by other services when events occur.
   */
  async enqueueEvent(
    orgId: string,
    projectId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const subs = await this.queries.findMatchingSubscriptions(orgId, projectId, eventType);
    const cloudEvent: CloudEventPayload = {
      specversion: '1.0',
      type: eventType,
      source: `eve://orgs/${orgId}/projects/${projectId}`,
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      data,
    };
    for (const sub of subs) {
      await this.queries.createDelivery({
        subscription_id: sub.id,
        event_id: cloudEvent.id,
        event_type: eventType,
        payload: cloudEvent as unknown as Record<string, unknown>,
      });
    }
  }

  // ── Delivery worker ────────────────────────────────────────────────

  /**
   * Process pending webhook deliveries.
   * Call this method from a cron job or polling interval.
   */
  async processDeliveries(batchSize = 50): Promise<{ processed: number; succeeded: number; failed: number }> {
    const pending = await this.queries.findPendingDeliveries(batchSize);
    let succeeded = 0;
    let failed = 0;

    for (const delivery of pending) {
      const sub = await this.queries.findSubscriptionById(delivery.subscription_id);
      if (!sub || !sub.active) {
        // Subscription gone or disabled — mark delivery as failed
        await this.queries.updateDelivery(delivery.id, {
          status: 'failed',
          attempts: delivery.attempts + 1,
          last_attempt_at: new Date(),
          next_retry_at: null,
          response_body: sub ? 'Subscription disabled' : 'Subscription deleted',
        });
        failed++;
        continue;
      }

      try {
        const payloadBody = JSON.stringify(delivery.payload);
        const signature = this.computeHmac(sub.secret, payloadBody);

        const response = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Eve-Signature-256': `sha256=${signature}`,
            'X-Eve-Delivery': delivery.id,
          },
          body: payloadBody,
          signal: AbortSignal.timeout(30_000), // 30s timeout
        });

        const responseBody = await response.text().catch(() => '');
        const newAttempts = delivery.attempts + 1;

        if (response.ok) {
          await this.queries.updateDelivery(delivery.id, {
            status: 'delivered',
            attempts: newAttempts,
            last_attempt_at: new Date(),
            next_retry_at: null,
            response_status: response.status,
            response_body: responseBody.slice(0, 4096),
          });
          succeeded++;
        } else {
          await this.handleFailedAttempt(delivery, sub, newAttempts, response.status, responseBody);
          failed++;
        }
      } catch (err) {
        const newAttempts = delivery.attempts + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.handleFailedAttempt(delivery, sub, newAttempts, null, errorMessage);
        failed++;
      }
    }

    return { processed: pending.length, succeeded, failed };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async handleFailedAttempt(
    delivery: WebhookDelivery,
    sub: WebhookSubscription,
    attempts: number,
    responseStatus: number | null,
    responseBody: string,
  ): Promise<void> {
    if (attempts >= MAX_ATTEMPTS) {
      // Terminal failure
      await this.queries.updateDelivery(delivery.id, {
        status: 'failed',
        attempts,
        last_attempt_at: new Date(),
        next_retry_at: null,
        response_status: responseStatus,
        response_body: responseBody.slice(0, 4096),
      });
    } else {
      // Schedule retry with exponential backoff
      const delayMs = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      const nextRetry = new Date(Date.now() + delayMs);
      await this.queries.updateDelivery(delivery.id, {
        status: 'retrying',
        attempts,
        last_attempt_at: new Date(),
        next_retry_at: nextRetry,
        response_status: responseStatus,
        response_body: responseBody.slice(0, 4096),
      });
    }

    // Check consecutive failures — auto-disable if threshold exceeded
    const consecutiveFailures = await this.queries.countConsecutiveFailures(sub.id);
    if (consecutiveFailures >= AUTO_DISABLE_THRESHOLD) {
      this.logger.warn(
        `Auto-disabling webhook ${sub.id} after ${consecutiveFailures} consecutive failures`,
      );
      await this.queries.disableSubscription(sub.id);
    }
  }

  private computeHmac(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  private async requireSubscription(orgId: string, webhookId: string): Promise<WebhookSubscription> {
    const sub = await this.queries.findSubscriptionById(webhookId);
    if (!sub || sub.org_id !== orgId) {
      throw new NotFoundException(`Webhook subscription not found: ${webhookId}`);
    }
    return sub;
  }

  private toResponse(sub: WebhookSubscription): WebhookResponse {
    return {
      id: sub.id,
      org_id: sub.org_id,
      project_id: sub.project_id,
      url: sub.url,
      events: sub.events,
      filter: sub.filter,
      active: sub.active,
      created_by: sub.created_by,
      created_at: sub.created_at instanceof Date ? sub.created_at.toISOString() : String(sub.created_at),
      updated_at: sub.updated_at instanceof Date ? sub.updated_at.toISOString() : String(sub.updated_at),
    };
  }

  private toDeliveryResponse(d: WebhookDelivery): WebhookDeliveryResponse {
    return {
      id: d.id,
      subscription_id: d.subscription_id,
      event_id: d.event_id ?? null,
      event_type: d.event_type,
      status: d.status,
      attempts: d.attempts,
      last_attempt_at: d.last_attempt_at instanceof Date
        ? d.last_attempt_at.toISOString()
        : d.last_attempt_at ? String(d.last_attempt_at) : null,
      response_status: d.response_status,
      created_at: d.created_at instanceof Date ? d.created_at.toISOString() : String(d.created_at),
    };
  }

  private toReplayStatusResponse(replay: {
    id: string;
    subscription_id: string;
    status: string;
    requested: number;
    processed: number;
    replayed: number;
    deduplicated: number;
    failed: number;
    started_at: Date | null;
    updated_at: Date;
  }): WebhookReplayStatusResponse {
    return {
      replay_id: replay.id,
      subscription_id: replay.subscription_id,
      status: replay.status,
      requested: replay.requested,
      processed: replay.processed,
      replayed: replay.replayed,
      deduplicated: replay.deduplicated,
      failed: replay.failed,
      started_at: replay.started_at ? replay.started_at.toISOString() : null,
      updated_at: replay.updated_at ? replay.updated_at.toISOString() : null,
    };
  }
}

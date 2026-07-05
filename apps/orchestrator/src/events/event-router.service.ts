import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import {
  appLinkEventDeliveryQueries,
  appLinkSubscriptionQueries,
  eventQueries,
  type AppLinkEventDelivery,
  type Db,
  type Event,
  type TriggerEvaluationEntry,
} from '@eve/db';
import { generateAppLinkEventDeliveryId, generateEventId, loadConfig } from '@eve/shared';
import { TriggerMatcherService, type TriggerMatch } from './trigger-matcher.service';

/**
 * Event router polling loop.
 *
 * Polls for pending events every 5 seconds, matches them against pipeline/workflow
 * triggers, and creates runs via the internal API. Includes stale event recovery
 * and a tick concurrency guard for reliability.
 */
@Injectable()
export class EventRouterService implements OnModuleInit {
  private readonly logger = new Logger(EventRouterService.name);
  private intervalId?: NodeJS.Timeout;
  private tickCount = 0;
  private eventsProcessed = 0;
  private eventsFailed = 0;
  private eventsRecovered = 0;
  private tickInProgress = false;
  private readonly claimLimit = Math.max(
    1,
    parseInt(process.env.EVE_EVENT_ROUTER_CLAIM_LIMIT || '25', 10),
  );
  private readonly staleAfterSeconds = Math.max(
    10,
    parseInt(process.env.EVE_EVENT_STALE_SECONDS || '60', 10),
  );
  private readonly config = loadConfig();

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly triggerMatcher: TriggerMatcherService,
  ) {}

  async onModuleInit() {
    this.logger.log(
      `Starting event router polling loop (5s interval, claim_limit=${this.claimLimit}, stale_after=${this.staleAfterSeconds}s)`,
    );
    this.startLoop();
  }

  private startLoop() {
    // Run immediately on startup
    this.tick().catch((err) => {
      this.logger.error('Error in initial event router tick:', err instanceof Error ? err.stack : String(err));
    });

    // Then poll every 5 seconds
    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error('Error in event router tick:', err instanceof Error ? err.stack : String(err));
      });
    }, 5000);
  }

  private async tick() {
    // Concurrency guard — skip if previous tick is still running
    if (this.tickInProgress) {
      return;
    }
    this.tickInProgress = true;

    try {
      this.tickCount++;

      const events = eventQueries(this.db);

      // Recover stale events every 6 ticks (30s at 5s intervals)
      if (this.tickCount % 6 === 0) {
        await this.recoverStaleEvents(events);
      }
      await this.processDueAppLinkDeliveries(events);

      // Log heartbeat every 12 ticks (1 minute at 5s intervals)
      if (this.tickCount % 12 === 0) {
        this.logger.log(
          `Event router heartbeat: ${this.tickCount} ticks, ${this.eventsProcessed} processed, ${this.eventsFailed} failed, ${this.eventsRecovered} recovered`,
        );
      }

      // Claim pending events
      const claimedEvents = await events.claimPendingEvents(this.claimLimit);

      if (claimedEvents.length === 0) {
        return;
      }

      this.logger.log(`Claimed ${claimedEvents.length} event(s) for processing`);

      // Process each claimed event
      for (const event of claimedEvents) {
        await this.processEvent(event, events);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private async recoverStaleEvents(
    events: ReturnType<typeof eventQueries>,
  ): Promise<void> {
    try {
      const recovered = await events.recoverStaleEvents(this.staleAfterSeconds);
      if (recovered > 0) {
        this.eventsRecovered += recovered;
        this.logger.warn(
          `Recovered ${recovered} stale event(s) stuck in 'processing' for >${this.staleAfterSeconds}s`,
        );
      }
    } catch (error) {
      this.logger.error('Failed to recover stale events:', error instanceof Error ? error.stack : String(error));
    }
  }

  private async processEvent(
    event: Event,
    events: ReturnType<typeof eventQueries>,
  ): Promise<void> {
    try {
      this.logger.log(
        `Processing event ${event.id} (type: ${event.type}, source: ${event.source}, project: ${event.project_id}, branch: ${event.ref_branch ?? 'n/a'})`,
      );

      // Match triggers for this event
      const { matches, evaluations } = await this.triggerMatcher.matchTriggersForEvent(event);
      const appLinkEvaluations = await this.fanOutAppLinkEvent(event, events);
      const allEvaluations = [...evaluations, ...appLinkEvaluations];

      // Persist trigger evaluation metadata for observability
      try {
        await events.updateTriggerMetadata(event.id, {
          trigger_match_count: matches.length + appLinkEvaluations.filter((entry) => entry.matched).length,
          triggers_evaluated: allEvaluations,
        });
      } catch (metaError) {
        this.logger.warn(`Event ${event.id} → failed to save trigger metadata: ${metaError instanceof Error ? metaError.message : metaError}`);
      }

      if (matches.length > 0) {
        this.logger.log(
          `Event ${event.id} matched ${matches.length} trigger(s): ${matches.map((m) => `${m.type}:${m.name}`).join(', ')}`,
        );
        for (const match of matches) {
          try {
            await this.triggerMatch(match, event);
            this.logger.log(
              `Event ${event.id} → ${match.type} "${match.name}" triggered successfully`,
            );
          } catch (triggerError) {
            // Log trigger-level failure but continue processing other matches
            this.logger.error(`Event ${event.id} → ${match.type} "${match.name}" trigger FAILED: ${triggerError instanceof Error ? triggerError.message : triggerError}`);
            throw triggerError;
          }
        }
      } else {
        this.logger.log(
          `Event ${event.id} did not match any triggers (type: ${event.type}, branch: ${event.ref_branch ?? 'n/a'})`,
        );
      }

      // Mark event as completed
      await events.updateStatus(event.id, 'completed');
      this.eventsProcessed++;
    } catch (error) {
      this.eventsFailed++;
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error processing event ${event.id} (type: ${event.type}, project: ${event.project_id}): ${errMsg}`,
      );

      try {
        await events.updateStatus(event.id, 'failed');
      } catch (updateError) {
        this.logger.error(`Failed to mark event ${event.id} as failed:`, updateError instanceof Error ? updateError.stack : String(updateError));
      }
    }
  }

  private async fanOutAppLinkEvent(
    event: Event,
    events: ReturnType<typeof eventQueries>,
  ): Promise<TriggerEvaluationEntry[]> {
    if (event.source === 'app_link') {
      return [];
    }

    const subscriptions = appLinkSubscriptionQueries(this.db);
    const deliveries = appLinkEventDeliveryQueries(this.db);
    const rows = await subscriptions.listEventSubscriptionsForProducer(event.project_id);
    const evaluations: TriggerEvaluationEntry[] = [];

    for (const row of rows) {
      const effectiveTypes = row.event_types.length > 0 ? row.event_types : row.grant_event_types;
      if (!effectiveTypes.includes(event.type)) {
        evaluations.push({
          type: 'app_link',
          name: row.local_alias,
          matched: false,
          reason: 'type_mismatch',
          subscription_id: row.subscription_id,
        });
        continue;
      }

      const delivery = await deliveries.queue({
        id: generateAppLinkEventDeliveryId(),
        subscription_id: row.subscription_id,
        source_event_id: event.id,
      });
      if (!delivery) {
        evaluations.push({
          type: 'app_link',
          name: row.local_alias,
          matched: false,
          reason: 'duplicate_delivery',
          subscription_id: row.subscription_id,
        });
        continue;
      }

      try {
        const consumerEvent = await this.createConsumerAppLinkEvent(event, row, events);
        await deliveries.markSuccess(delivery.id, consumerEvent.id);
        evaluations.push({
          type: 'app_link',
          name: row.local_alias,
          matched: true,
          subscription_id: row.subscription_id,
          delivery_id: delivery.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.scheduleDeliveryRetry(delivery, message, deliveries);
        evaluations.push({
          type: 'app_link',
          name: row.local_alias,
          matched: false,
          reason: message,
          subscription_id: row.subscription_id,
          delivery_id: delivery.id,
        });
      }
    }

    return evaluations;
  }

  private async createConsumerAppLinkEvent(
    sourceEvent: Event,
    subscription: {
      subscription_id: string;
      consumer_project_id: string;
      local_alias: string;
      producer_project_id: string;
      export_name: string;
    },
    events: ReturnType<typeof eventQueries>,
  ): Promise<Event> {
    return events.create({
      id: generateEventId(),
      project_id: subscription.consumer_project_id,
      type: sourceEvent.type,
      source: 'app_link',
      env_name: sourceEvent.env_name,
      ref_sha: sourceEvent.ref_sha,
      ref_branch: sourceEvent.ref_branch,
      actor_type: sourceEvent.actor_type,
      actor_id: sourceEvent.actor_id,
      payload_json: {
        producer_event_id: sourceEvent.id,
        producer_project_id: subscription.producer_project_id,
        producer_env_name: sourceEvent.env_name,
        producer_export_name: subscription.export_name,
        link_alias: subscription.local_alias,
        original: sourceEvent.payload_json ?? {},
      },
      dedupe_key: `app_link:${subscription.subscription_id}:${sourceEvent.id}`,
    });
  }

  private async scheduleDeliveryRetry(
    delivery: AppLinkEventDelivery,
    message: string,
    deliveries: ReturnType<typeof appLinkEventDeliveryQueries>,
  ): Promise<void> {
    const nextAttempt = delivery.attempts + 1;
    if (nextAttempt >= 5) {
      await deliveries.markFailed(delivery.id, message);
      return;
    }
    const delaySeconds = Math.min(300, 2 ** nextAttempt * 5);
    await deliveries.markRetry(
      delivery.id,
      message,
      new Date(Date.now() + delaySeconds * 1000),
    );
  }

  private async processDueAppLinkDeliveries(
    events: ReturnType<typeof eventQueries>,
  ): Promise<void> {
    const deliveries = appLinkEventDeliveryQueries(this.db);
    const subscriptions = appLinkSubscriptionQueries(this.db);
    const due = await deliveries.claimDue(25);
    for (const delivery of due) {
      const sourceEvent = await events.findById(delivery.source_event_id);
      const subscription = await subscriptions.findWithGrantsById(delivery.subscription_id);
      if (!sourceEvent || !subscription?.event_grant || subscription.event_grant.revoked_at) {
        await deliveries.markFailed(delivery.id, 'Source event or active event grant not found');
        continue;
      }
      try {
        const consumerEvent = await this.createConsumerAppLinkEvent(
          sourceEvent,
          {
            subscription_id: subscription.id,
            consumer_project_id: subscription.consumer_project_id,
            local_alias: subscription.local_alias,
            producer_project_id: subscription.event_grant.producer_project_id,
            export_name: subscription.event_grant.export_name,
          },
          events,
        );
        await deliveries.markSuccess(delivery.id, consumerEvent.id);
      } catch (error) {
        await this.scheduleDeliveryRetry(
          delivery,
          error instanceof Error ? error.message : String(error),
          deliveries,
        );
      }
    }
  }

  private async triggerMatch(
    match: TriggerMatch,
    event: Event,
  ): Promise<void> {
    if (!this.config.EVE_INTERNAL_API_KEY) {
      throw new Error('EVE_INTERNAL_API_KEY is required for trigger execution');
    }

    if (!this.config.EVE_API_URL) {
      throw new Error('EVE_API_URL is required for trigger execution');
    }

    const inputs = this.buildTriggerInputs(event);

    if (match.type === 'pipeline') {
      if (!event.ref_sha) {
        this.logger.warn(
          `Skipping pipeline trigger ${match.name}: missing ref_sha`,
        );
        return;
      }

      // Use env_name from trigger match (environment-linked), PR metadata, or event
      const envName =
        match.envName ??
        (inputs.env_name as string | undefined) ??
        event.env_name ??
        undefined;

      // Generate dedupe key for PR events to prevent duplicate pipeline runs
      const dedupeKey = this.generateDedupeKey(event, inputs);

      this.logger.log(
        `Creating pipeline run: pipeline=${match.name}, sha=${event.ref_sha.slice(0, 8)}, env=${envName ?? 'none'}, dedupe=${dedupeKey ?? 'none'}`,
      );

      const result = await this.callInternalApi(
        `/internal/projects/${match.projectId}/pipelines/${match.name}/runs`,
        {
          git_sha: event.ref_sha,
          env_name: envName,
          inputs,
          dedupe_key: dedupeKey,
        },
      );

      // Link the pipeline run's job back to the event
      await this.linkJobToEvent(event, result);
      return;
    }

    if (match.type === 'workflow') {
      this.logger.log(`Invoking workflow: ${match.name}`);
      const result = await this.callInternalApi(
        `/internal/projects/${match.projectId}/workflows/${match.name}/invoke`,
        {
          input: inputs,
        },
      );

      // Link the workflow's root job back to the event
      await this.linkJobToEvent(event, result);
    }
  }

  /**
   * Link the job_id from a trigger response back to the event record.
   * Best-effort: logs a warning if it fails but does not throw.
   */
  private async linkJobToEvent(
    event: Event,
    triggerResult: Record<string, unknown>,
  ): Promise<void> {
    const jobId = triggerResult.job_id as string | undefined;
    if (!jobId) {
      return;
    }

    try {
      const events = eventQueries(this.db);
      await events.linkJobToEvent(event.id, jobId);
      this.logger.log(`Event ${event.id} → linked job_id=${jobId}`);
    } catch (error) {
      this.logger.warn(`Event ${event.id} → failed to link job_id=${jobId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildTriggerInputs(event: Event): Record<string, unknown> {
    const baseInputs: Record<string, unknown> = {
      event_id: event.id,
      event_type: event.type,
      source: event.source,
      ref_sha: event.ref_sha,
      ref_branch: event.ref_branch,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      payload: event.payload_json,
    };

    // Extract full PR metadata for github.pull_request events
    if (event.type === 'github.pull_request' && event.payload_json) {
      const prMetadata = this.extractPullRequestMetadata(event.payload_json);
      return { ...baseInputs, ...prMetadata };
    }

    return baseInputs;
  }

  /**
   * Extract PR metadata from github.pull_request event payload.
   * These fields become available as ${inputs.pr_number}, ${inputs.env_name}, etc.
   */
  private extractPullRequestMetadata(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const pullRequest = payload.pull_request as
      | Record<string, unknown>
      | undefined;
    const repository = payload.repository as
      | Record<string, unknown>
      | undefined;

    if (!pullRequest) {
      return {};
    }

    const head = pullRequest.head as Record<string, unknown> | undefined;
    const base = pullRequest.base as Record<string, unknown> | undefined;

    const prNumber = pullRequest.number as number | undefined;
    const prBranch = head?.ref as string | undefined;
    const prSha = head?.sha as string | undefined;
    const prUrl = pullRequest.html_url as string | undefined;
    const prAction = payload.action as string | undefined;
    const baseBranch = base?.ref as string | undefined;
    const repo = repository?.full_name as string | undefined;

    // Compute environment name for PR preview environments
    const envName = prNumber !== undefined ? `pr-${prNumber}` : undefined;

    return {
      pr_number: prNumber,
      pr_branch: prBranch,
      pr_sha: prSha,
      pr_url: prUrl,
      pr_action: prAction,
      base_branch: baseBranch,
      repo: repo,
      env_name: envName,
    };
  }

  /**
   * Generate dedupe key for pipeline runs.
   * For PR events, use pattern: pr:{repo}:{pr_number}
   * Returns undefined for non-PR events (no deduplication).
   */
  private generateDedupeKey(
    event: Event,
    inputs: Record<string, unknown>,
  ): string | undefined {
    if (event.type === 'github.pull_request') {
      const repo = inputs.repo as string | undefined;
      const prNumber = inputs.pr_number as number | undefined;

      if (repo && prNumber !== undefined) {
        return `pr:${repo}:${prNumber}`;
      }
    }

    // No dedupe key for non-PR events
    return undefined;
  }

  private async callInternalApi(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = this.config.EVE_INTERNAL_API_KEY;
    if (!token) {
      throw new Error(
        'EVE_INTERNAL_API_KEY is required for trigger execution',
      );
    }

    const url = `${this.config.EVE_API_URL}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': token,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Trigger API failed: POST ${path} → ${response.status}: ${text}`,
      );
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.logger.log('Stopped event router polling loop');
    }
  }
}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { loadConfig } from '@eve/shared';
import type { Db } from '@eve/db';
import { agentPlacementQueries, agentRuntimePodQueries } from '@eve/db';

@Injectable()
export class RuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeService.name);
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pods: ReturnType<typeof agentRuntimePodQueries>;
  private placements: ReturnType<typeof agentPlacementQueries>;
  private readonly trackedOrgIds = new Set<string>();
  private lastOrgDiscoveryAt = 0;

  constructor(@Inject('DB') private readonly db: Db) {
    this.pods = agentRuntimePodQueries(db);
    this.placements = agentPlacementQueries(db);
  }

  async onModuleInit() {
    await this.seedTrackedOrgIds();
    await this.startHeartbeatLoop();
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await this.drainRunningAttempts();
  }

  /**
   * On shutdown, mark all running attempts owned by this pod as failed
   * so the orchestrator's stale recovery can handle job-level cleanup.
   * Also set pod status to 'draining' to prevent new job routing.
   */
  private async drainRunningAttempts() {
    const podName = this.resolvePodName();

    try {
      // Mark pod as draining for every tracked org so new jobs aren't routed here
      const orgIds = [...this.trackedOrgIds];
      for (const orgId of orgIds) {
        try {
          await this.pods.upsert({
            org_id: orgId,
            pod_name: podName,
            status: 'draining',
            capacity: 0,
            last_heartbeat_at: new Date(),
          });
        } catch (err) {
          this.logger.warn(`Failed to set draining status for pod ${podName} org ${orgId}: ${err}`);
        }
      }

      // Find and fail all running attempts on this pod
      const runningAttempts = await this.db<{ id: string; job_id: string }[]>`
        SELECT id, job_id FROM job_attempts
        WHERE status = 'running'
          AND runtime_meta->>'pod_name' = ${podName}
      `;

      if (runningAttempts.length === 0) {
        this.logger.log(`Graceful shutdown: no running attempts on pod ${podName}`);
        return;
      }

      this.logger.warn(
        `Graceful shutdown: failing ${runningAttempts.length} running attempt(s) on pod ${podName}`,
      );

      for (const attempt of runningAttempts) {
        try {
          await this.db`
            UPDATE job_attempts
            SET status = 'failed',
                ended_at = NOW(),
                error_message = '[pod_terminated] Agent runtime pod terminated during execution'
            WHERE id = ${attempt.id}::uuid
              AND status = 'running'
          `;
          this.logger.log(`Marked attempt ${attempt.id} (job ${attempt.job_id}) as failed (pod_terminated)`);
        } catch (err) {
          this.logger.error(`Failed to mark attempt ${attempt.id} as failed: ${err}`);
        }
      }
    } catch (err) {
      this.logger.error(`Graceful shutdown drain failed: ${err}`);
    }
  }

  registerOrg(orgId: string | null | undefined): void {
    const normalized = orgId?.trim();
    if (!normalized) return;
    this.trackedOrgIds.add(normalized);
  }

  async resolvePlacement(agentId?: string | null, orgId?: string | null): Promise<{
    accepted: boolean;
    targetPod?: string;
    reason?: string;
  }> {
    if (!agentId) return { accepted: true };

    const resolvedOrgId = this.resolvePlacementOrgId(orgId);
    if (!resolvedOrgId) {
      this.logger.warn('AGENT_RUNTIME_ORG_ID/EVE_ORG_ID not set; placement disabled');
      return { accepted: true };
    }
    this.registerOrg(resolvedOrgId);

    const podName = this.resolvePodName();
    await this.pods.upsert({
      org_id: resolvedOrgId,
      pod_name: podName,
      status: process.env.AGENT_RUNTIME_STATUS ?? 'healthy',
      capacity: this.resolveRuntimeCapacity(),
      last_heartbeat_at: new Date(),
    });

    const pods = await this.pods.listByOrg(resolvedOrgId);
    const healthyPods = this.filterHealthyPods(pods);

    if (healthyPods.length === 0) {
      await this.placements.upsert({ org_id: resolvedOrgId, agent_id: agentId, pod_name: podName, shard_key: null });
      return { accepted: true };
    }

    const targetPod = this.selectShardPod(healthyPods.map((pod) => pod.pod_name), agentId);
    if (targetPod === podName) {
      await this.placements.upsert({ org_id: resolvedOrgId, agent_id: agentId, pod_name: podName, shard_key: agentId });
      return { accepted: true };
    }

    const existing = await this.placements.findByOrgAndAgent(resolvedOrgId, agentId);
    if (existing && existing.pod_name === podName) {
      return { accepted: true };
    }

    if (existing && !this.isPodHealthy(existing.pod_name, pods)) {
      await this.placements.upsert({ org_id: resolvedOrgId, agent_id: agentId, pod_name: podName, shard_key: agentId });
      return { accepted: true };
    }

    return { accepted: false, targetPod, reason: 'agent-runtime-wrong-shard' };
  }

  private async startHeartbeatLoop() {
    const config = loadConfig();
    const podName = this.resolvePodName();
    const capacity = parseInt(process.env.AGENT_RUNTIME_CAPACITY ?? '0', 10);
    const status = process.env.AGENT_RUNTIME_STATUS ?? 'healthy';
    if (!config.EVE_API_URL || !config.EVE_INTERNAL_API_KEY) {
      this.logger.warn('EVE_API_URL or EVE_INTERNAL_API_KEY not set; heartbeat disabled');
      return;
    }

    let warnedMissingOrgs = false;

    const ORG_REDISCOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    const sendHeartbeat = async () => {
      // Re-discover orgs periodically when none are tracked, or every 5 minutes
      // to pick up orgs created after startup
      const now = Date.now();
      if (this.trackedOrgIds.size === 0 || now - this.lastOrgDiscoveryAt > ORG_REDISCOVERY_INTERVAL_MS) {
        this.lastOrgDiscoveryAt = now;
        await this.discoverOrgsFromApi();
      }

      const orgIds = this.listHeartbeatOrgIds();
      if (orgIds.length === 0) {
        if (!warnedMissingOrgs) {
          warnedMissingOrgs = true;
          this.logger.warn('No tracked org IDs for agent runtime heartbeat; waiting for first invocation or org creation');
        }
        return;
      }
      warnedMissingOrgs = false;

      await Promise.all(
        orgIds.map(async (orgId) => {
          try {
            const response = await fetch(`${config.EVE_API_URL}/internal/orgs/${orgId}/agent-runtime/heartbeat`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-eve-internal-token': config.EVE_INTERNAL_API_KEY!,
              },
              body: JSON.stringify({
                pod_name: podName,
                status,
                capacity,
              }),
            });

            if (!response.ok) {
              const body = await response.text().catch(() => 'unknown');
              this.logger.warn(`Heartbeat failed for org ${orgId}: ${response.status} ${response.statusText} (${body})`);
              return;
            }

            this.logger.debug(`Heartbeat ok for ${podName} (org=${orgId})`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Heartbeat error for org ${orgId}: ${message}`);
          }
        }),
      );
    };

    await sendHeartbeat();
    const intervalMs = parseInt(process.env.AGENT_RUNTIME_HEARTBEAT_MS ?? '15000', 10);
    this.heartbeatTimer = setInterval(sendHeartbeat, intervalMs);
  }

  private resolveOrgIdFromEnv(): string | null {
    return process.env.EVE_ORG_ID ?? process.env.AGENT_RUNTIME_ORG_ID ?? null;
  }

  private resolvePlacementOrgId(invocationOrgId?: string | null): string | null {
    if (invocationOrgId?.trim()) return invocationOrgId.trim();
    return this.resolveOrgIdFromEnv();
  }

  private async seedTrackedOrgIds(): Promise<void> {
    // Explicit multi-org list always wins
    const configured = process.env.AGENT_RUNTIME_ORG_IDS
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
    for (const orgId of configured) {
      this.registerOrg(orgId);
    }

    const envOrg = this.resolveOrgIdFromEnv();

    // If explicit org is set and it's not the placeholder default, use it
    if (envOrg && envOrg !== 'org_default') {
      this.registerOrg(envOrg);
      return;
    }

    // Auto-discover orgs from the database
    if (configured.length === 0) {
      await this.discoverOrgsFromApi();
    }
  }

  /**
   * Discover orgs by calling the API's internal org-list endpoint.
   * Falls back to direct DB query if the API is unavailable (e.g. during startup race).
   */
  private async discoverOrgsFromApi(): Promise<void> {
    const config = loadConfig();

    // Try the API first (preferred — keeps the runtime as a pure API client)
    if (config.EVE_API_URL && config.EVE_INTERNAL_API_KEY) {
      try {
        const response = await fetch(`${config.EVE_API_URL}/internal/agent-runtime/orgs`, {
          headers: {
            'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
          },
        });
        if (response.ok) {
          const data = (await response.json()) as { org_ids: string[] };
          for (const orgId of data.org_ids) {
            this.registerOrg(orgId);
          }
          if (data.org_ids.length > 0) {
            this.logger.log(`Auto-discovered ${data.org_ids.length} org(s) from API: ${data.org_ids.join(', ')}`);
          } else {
            this.logger.warn('No orgs found via API — heartbeat will wait for first invocation');
          }
          return;
        }
        this.logger.warn(`Org discovery API returned ${response.status}; falling back to DB`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Org discovery API unavailable (${message}); falling back to DB`);
      }
    }

    // Fallback: direct DB query (agent-runtime has DB access)
    try {
      const orgs = await this.db<{ id: string }[]>`
        SELECT id FROM orgs WHERE deleted_at IS NULL ORDER BY created_at LIMIT 50
      `;
      for (const org of orgs) {
        this.registerOrg(org.id);
      }
      if (orgs.length > 0) {
        this.logger.log(`Auto-discovered ${orgs.length} org(s) from DB: ${orgs.map((o) => o.id).join(', ')}`);
      } else {
        this.logger.warn('No orgs in database — heartbeat will wait for first invocation');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Org discovery from DB failed: ${message}`);
    }
  }

  private listHeartbeatOrgIds(): string[] {
    if (this.isMultiOrgMode()) {
      return [...this.trackedOrgIds].sort();
    }

    const envOrg = this.resolveOrgIdFromEnv();
    // If env org is set and not the broken default, use it exclusively
    if (envOrg && envOrg !== 'org_default') {
      return [envOrg];
    }

    // Otherwise use whatever orgs we've discovered
    return [...this.trackedOrgIds].sort();
  }

  private isMultiOrgMode(): boolean {
    const mode = (process.env.AGENT_RUNTIME_MULTI_ORG ?? '').trim().toLowerCase();
    return mode === '1' || mode === 'true' || mode === 'yes' || mode === 'on';
  }

  private resolvePodName(): string {
    return process.env.AGENT_RUNTIME_POD_NAME ?? process.env.HOSTNAME ?? 'agent-runtime';
  }

  private filterHealthyPods(pods: Array<{ pod_name: string; last_heartbeat_at: Date }>) {
    return pods.filter((pod) => this.isPodHealthy(pod.pod_name, pods));
  }

  private isPodHealthy(podName: string, pods: Array<{ pod_name: string; last_heartbeat_at: Date }>): boolean {
    const pod = pods.find((item) => item.pod_name === podName);
    if (!pod) return false;
    const ttlMs = parseInt(process.env.AGENT_RUNTIME_HEARTBEAT_TTL_MS ?? '45000', 10);
    return Date.now() - pod.last_heartbeat_at.getTime() <= ttlMs;
  }

  private selectShardPod(pods: string[], agentId: string): string {
    const sorted = [...pods].sort();
    const hash = createHash('sha1').update(agentId).digest('hex');
    const value = parseInt(hash.slice(0, 8), 16);
    const index = value % sorted.length;
    return sorted[index];
  }

  private resolveRuntimeCapacity(): number {
    const parsedCapacity = parseInt(process.env.AGENT_RUNTIME_CAPACITY ?? '0', 10);
    return Number.isNaN(parsedCapacity) ? 0 : parsedCapacity;
  }
}

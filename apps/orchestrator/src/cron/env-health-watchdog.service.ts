import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CronJob } from 'cron';
import * as k8s from '@kubernetes/client-node';
import crypto from 'node:crypto';
import {
  environmentQueries,
  environmentHealthQueries,
  cloudCostSnapshotQueries,
  environmentCostSnapshotQueries,
  type Db,
  type EnvironmentCostSnapshot,
  type HealthIssue,
  type HealthAction,
  type HealthStatus,
} from '@eve/db';

// ---------------------------------------------------------------------------
// Config from env vars (with sensible defaults)
// ---------------------------------------------------------------------------

const INTERVAL_MS = parseInt(process.env.EVE_ENV_HEALTH_INTERVAL_MS ?? '120000', 10);
const CIRCUIT_BREAK_ENABLED = process.env.EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED !== 'false';
const CIRCUIT_BREAK_AFTER_RESTARTS = parseInt(process.env.EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_RESTARTS ?? '50', 10);
const CIRCUIT_BREAK_AFTER_MS = parseInt(process.env.EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_MS ?? '1800000', 10);
const STABLE_TICKS = parseInt(process.env.EVE_ENV_HEALTH_STABLE_TICKS ?? '2', 10);
const BOOT_DELAY_MS = 10_000;
const CONCURRENCY_LIMIT = 10;
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_COST_TOP_N = 5;
const DEFAULT_COST_STALE_AFTER_HOURS = 26;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvRow {
  id: string;
  project_id: string;
  name: string;
  status: string;
  namespace: string;
  deploy_status: string;
  project_slug: string;
  org_slug: string;
  org_id: string;
}

interface DiagnoseResult {
  status: HealthStatus;
  issues: HealthIssue[];
  podCount: number;
  healthyPodCount: number;
}

/** Parse JSONB fields that may come back as strings from postgres */
function parseJsonField<T>(val: T | string | null | undefined): T | null {
  if (val == null) return null;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val as T;
}

/**
 * Environment Health Watchdog (Platform Sentinel)
 *
 * Periodically probes K8s namespaces for active environments, classifies pod
 * health issues (ImagePullBackOff, CrashLoopBackOff, high restarts, stuck
 * pending), persists health state, notifies on transitions, and optionally
 * circuit-breaks runaway deployments by scaling them to zero.
 *
 * Disabled by default; enable with `EVE_ENV_HEALTH_ENABLED=true`.
 *
 * Env vars:
 * - EVE_ENV_HEALTH_ENABLED            — kill switch (default: false)
 * - EVE_ENV_HEALTH_INTERVAL_MS        — tick interval (default: 120000)
 * - EVE_ENV_HEALTH_CIRCUIT_BREAK_ENABLED — gate scale-to-zero (default: true)
 * - EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_RESTARTS — CrashLoop threshold (default: 50)
 * - EVE_ENV_HEALTH_CIRCUIT_BREAK_AFTER_MS — time in failure state (default: 1800000)
 * - EVE_ENV_HEALTH_STABLE_TICKS       — consecutive degraded ticks before action (default: 2)
 */
@Injectable()
export class EnvHealthWatchdogService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private dailySummaryJob: CronJob | null = null;
  private running = false;

  private k8sAvailable = false;
  private coreApi: k8s.CoreV1Api | null = null;
  private appsApi: k8s.AppsV1Api | null = null;

  private environments: ReturnType<typeof environmentQueries>;
  private healthChecks: ReturnType<typeof environmentHealthQueries>;
  private costSnapshots: ReturnType<typeof environmentCostSnapshotQueries>;
  private cloudCostSnapshots: ReturnType<typeof cloudCostSnapshotQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.environments = environmentQueries(db);
    this.healthChecks = environmentHealthQueries(db);
    this.costSnapshots = environmentCostSnapshotQueries(db);
    this.cloudCostSnapshots = cloudCostSnapshotQueries(db);

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
      this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
      this.k8sAvailable = true;
    } catch (err) {
      console.warn('[sentinel] K8s API unavailable — health checks will be skipped');
    }
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_ENV_HEALTH_ENABLED !== 'true') {
      console.log('[sentinel] Env health watchdog disabled (set EVE_ENV_HEALTH_ENABLED=true to enable)');
      return;
    }

    // Delay the first tick to let the system boot.
    this.bootTimer = setTimeout(() => {
      this.tick().catch((err) => {
        console.error('[sentinel] Initial tick failed:', err instanceof Error ? err.message : String(err));
      });

      this.timer = setInterval(() => {
        this.tick().catch((err) => {
          console.error('[sentinel] Tick failed:', err instanceof Error ? err.message : String(err));
        });
      }, INTERVAL_MS);
    }, BOOT_DELAY_MS);

    console.log(`[sentinel] Env health watchdog enabled (interval=${INTERVAL_MS}ms, boot_delay=${BOOT_DELAY_MS}ms)`);

    // Daily summary at 08:00 UTC
    try {
      this.dailySummaryJob = new CronJob(
        '0 8 * * *',
        () => { this.sendDailySummary().catch(err => console.error('[sentinel] Daily summary failed:', err instanceof Error ? err.message : String(err))); },
        null,
        true,
        'UTC',
      );
      console.log('[sentinel] Daily summary scheduled (08:00 UTC)');
    } catch {
      console.warn('[sentinel] Failed to schedule daily summary cron');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.dailySummaryJob) {
      this.dailySummaryJob.stop();
      this.dailySummaryJob = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Main tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.k8sAvailable || this.running) return;
    this.running = true;

    const start = Date.now();
    let degradedCount = 0;
    let criticalCount = 0;

    try {
      const envs = await this.fetchActiveEnvironments();

      // Process in bounded-concurrency chunks.
      for (let i = 0; i < envs.length; i += CONCURRENCY_LIMIT) {
        const chunk = envs.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.allSettled(
          chunk.map((env) => this.processEnvironment(env)),
        );

        for (const result of results) {
          if (result.status === 'rejected') {
            console.error('[sentinel] Env check failed:', result.reason instanceof Error ? result.reason.message : String(result.reason));
          } else if (result.value === 'degraded') {
            degradedCount++;
          } else if (result.value === 'critical') {
            criticalCount++;
          }
        }
      }

      const elapsed = Date.now() - start;
      console.log(
        `[sentinel] Health tick: ${envs.length} envs, ${degradedCount} degraded, ${criticalCount} critical (${elapsed}ms)`,
      );
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // DB: fetch active environments with namespace
  // ---------------------------------------------------------------------------

  private async fetchActiveEnvironments(): Promise<EnvRow[]> {
    return this.db<EnvRow[]>`
      SELECT e.id, e.project_id, e.name, e.status, e.namespace, e.deploy_status,
             p.slug as project_slug, o.slug as org_slug, o.id as org_id
      FROM environments e
      JOIN projects p ON e.project_id = p.id
      JOIN orgs o ON p.org_id = o.id
      WHERE e.status = 'active' AND e.namespace IS NOT NULL
    `;
  }

  // ---------------------------------------------------------------------------
  // Per-environment processing
  // ---------------------------------------------------------------------------

  private async processEnvironment(env: EnvRow): Promise<HealthStatus> {
    try {
      // 1. Diagnose K8s health
      const diagnosis = await this.diagnoseEnvironment(env);

      // 2. Build issue signature
      const issueSignature = diagnosis.issues.length > 0
        ? crypto.createHash('md5')
            .update(diagnosis.issues.map((i) => `${i.type}:${i.pod}`).sort().join(','))
            .digest('hex')
        : '';

      // 3. Fetch previous health check
      const prev = await this.healthChecks.findByEnvironmentId(env.id);

      // 4. Determine new status
      const newStatus = diagnosis.status;

      // 5. Calculate consecutive degraded ticks
      const consecutiveDegradedTicks = newStatus !== 'healthy'
        ? (prev?.consecutive_degraded_ticks ?? 0) + 1
        : 0;

      // 6. Calculate degraded_since
      let degradedSince: Date | null;
      if (newStatus === 'healthy') {
        degradedSince = null;
      } else if (!prev || prev.status === 'healthy') {
        // Newly degraded
        degradedSince = new Date();
      } else {
        // Still degraded — keep the original timestamp
        degradedSince = prev.degraded_since;
      }

      // 7. Determine actions
      const actionsTaken: HealthAction[] = [];

      // Circuit-breaker: scale down runaway deployments
      if (
        CIRCUIT_BREAK_ENABLED &&
        consecutiveDegradedTicks >= STABLE_TICKS &&
        env.status !== 'suspended' &&
        newStatus === 'critical'
      ) {
        const cbActions = await this.applyCircuitBreaker(env, diagnosis);
        actionsTaken.push(...cbActions);
      }

      // 8. Upsert health check (without notified_at — let the upsert COALESCE preserve it)
      await this.healthChecks.upsert({
        environment_id: env.id,
        project_id: env.project_id,
        org_id: env.org_id,
        environment_slug: `${env.org_slug}/${env.project_slug}/${env.name}`,
        status: newStatus,
        issue_signature: issueSignature,
        issues_json: diagnosis.issues.length > 0 ? diagnosis.issues : null,
        pod_count: diagnosis.podCount,
        healthy_pod_count: diagnosis.healthyPodCount,
        degraded_since: degradedSince,
        consecutive_degraded_ticks: consecutiveDegradedTicks,
        actions_taken_json: actionsTaken.length > 0 ? actionsTaken : null,
      });

      // 9. Handle notifications
      await this.handleNotification(env, prev, newStatus, issueSignature, diagnosis, actionsTaken);

      return newStatus;
    } catch (err) {
      console.error(
        `[sentinel] Failed processing env ${env.org_slug}/${env.project_slug}/${env.name}:`,
        err instanceof Error ? err.message : String(err),
      );
      return 'healthy'; // Don't count errors as degraded
    }
  }

  // ---------------------------------------------------------------------------
  // K8s diagnosis
  // ---------------------------------------------------------------------------

  private async diagnoseEnvironment(env: EnvRow): Promise<DiagnoseResult> {
    const issues: HealthIssue[] = [];

    // List pods with a 5-second timeout
    let pods: k8s.V1Pod[];
    try {
      const response = await Promise.race([
        this.coreApi!.listNamespacedPod({ namespace: env.namespace }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('K8s API timeout (5s)')), 5000)),
      ]);
      pods = response.items ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sentinel] Failed to list pods in ${env.namespace}: ${msg}`);
      return { status: 'healthy', issues: [], podCount: 0, healthyPodCount: 0 };
    }

    let healthyPodCount = 0;
    const now = Date.now();

    for (const pod of pods) {
      const podName = pod.metadata?.name ?? 'unknown';
      const podCreation = pod.metadata?.creationTimestamp
        ? new Date(pod.metadata.creationTimestamp).getTime()
        : now;
      const podAgeMs = now - podCreation;

      const allContainerStatuses = [
        ...(pod.status?.containerStatuses ?? []),
        ...(pod.status?.initContainerStatuses ?? []),
      ];

      let podHealthy = true;

      for (const cs of allContainerStatuses) {
        const waitingReason = cs.state?.waiting?.reason;

        if (waitingReason === 'ImagePullBackOff' || waitingReason === 'ErrImagePull') {
          podHealthy = false;
          issues.push({
            type: 'image_pull_backoff',
            pod: podName,
            container: cs.name,
            reason: waitingReason,
            image: cs.image,
          });
        }

        if (waitingReason === 'CrashLoopBackOff' && (cs.restartCount ?? 0) > 20) {
          podHealthy = false;
          issues.push({
            type: 'crash_loop_backoff',
            pod: podName,
            container: cs.name,
            restarts: cs.restartCount ?? 0,
            reason: waitingReason,
          });
        }

        if ((cs.restartCount ?? 0) > 5 && podAgeMs < 60 * 60 * 1000) {
          podHealthy = false;
          issues.push({
            type: 'high_restarts',
            pod: podName,
            container: cs.name,
            restarts: cs.restartCount ?? 0,
            since: pod.metadata?.creationTimestamp
              ? new Date(pod.metadata.creationTimestamp).toISOString()
              : undefined,
          });
        }
      }

      // Pending too long
      if (pod.status?.phase === 'Pending' && podAgeMs > 10 * 60 * 1000) {
        podHealthy = false;
        issues.push({
          type: 'pending_too_long',
          pod: podName,
          reason: 'Pod pending for >10 minutes',
          since: pod.metadata?.creationTimestamp
            ? new Date(pod.metadata.creationTimestamp).toISOString()
            : undefined,
        });
      }

      if (podHealthy) healthyPodCount++;
    }

    // Classify overall status
    let status: HealthStatus = 'healthy';
    if (issues.length > 0) {
      const hasCritical = issues.some(
        (i) => i.type === 'image_pull_backoff' || i.type === 'crash_loop_backoff',
      );
      status = hasCritical ? 'critical' : 'degraded';
    }

    return { status, issues, podCount: pods.length, healthyPodCount };
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  private async handleNotification(
    env: EnvRow,
    prev: Awaited<ReturnType<typeof this.healthChecks.findByEnvironmentId>>,
    newStatus: HealthStatus,
    issueSignature: string,
    diagnosis: DiagnoseResult,
    actionsTaken: HealthAction[],
  ): Promise<void> {
    const prevStatus = prev?.status ?? 'healthy';
    let notificationType: string | null = null;

    // Detect state transitions
    if (prevStatus === 'healthy' && newStatus === 'degraded') {
      notificationType = 'env.health.degraded';
    } else if (prevStatus === 'healthy' && newStatus === 'critical') {
      notificationType = 'env.health.critical';
    } else if (prevStatus !== 'healthy' && newStatus === 'healthy') {
      notificationType = 'env.health.recovered';
    } else if (prevStatus === 'degraded' && newStatus === 'critical') {
      notificationType = 'env.health.critical';
    } else if (newStatus !== 'healthy' && prev && prev.issue_signature !== issueSignature) {
      // Same severity but different issues — re-notify
      notificationType = newStatus === 'critical' ? 'env.health.critical' : 'env.health.degraded';
    }

    if (!notificationType) return;

    // Dedup: skip if we notified recently with the same signature
    // Recovery and circuit-breaker notifications always bypass dedup
    const isRecovery = notificationType === 'env.health.recovered';
    const hasCircuitBreakerAction = actionsTaken.length > 0;

    if (!isRecovery && !hasCircuitBreakerAction && prev?.notified_at) {
      const msSinceLastNotify = Date.now() - new Date(prev.notified_at).getTime();
      if (msSinceLastNotify < DEDUP_WINDOW_MS && prev.issue_signature === issueSignature) {
        return;
      }
    }

    // Mark as notified
    await this.healthChecks.markNotified(env.id);

    // Fire notification (fire-and-forget)
    const apiUrl = process.env.EVE_API_URL;
    const token = process.env.EVE_INTERNAL_API_KEY;
    if (!apiUrl || !token) return;

    const severity = newStatus === 'critical' ? 'critical' : newStatus === 'degraded' ? 'warning' : 'info';

    fetch(`${apiUrl}/internal/platform-notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': token,
      },
      body: JSON.stringify({
        severity,
        type: notificationType,
        environment: {
          org_slug: env.org_slug,
          project_slug: env.project_slug,
          env_name: env.name,
        },
        issues: diagnosis.issues,
        actions_taken: actionsTaken,
      }),
    }).catch((err) => {
      console.error(
        `[sentinel] Failed to send notification for ${env.org_slug}/${env.project_slug}/${env.name}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker: scale-to-zero for runaway deployments
  // ---------------------------------------------------------------------------

  private async applyCircuitBreaker(env: EnvRow, diagnosis: DiagnoseResult): Promise<HealthAction[]> {
    const actions: HealthAction[] = [];

    // Only act on critical issues that warrant scale-to-zero
    const criticalIssues = diagnosis.issues.filter(
      (i) => i.type === 'image_pull_backoff' || i.type === 'crash_loop_backoff',
    );
    if (criticalIssues.length === 0) return actions;

    // Check time-in-failure gate
    const prev = await this.healthChecks.findByEnvironmentId(env.id);
    if (prev?.degraded_since) {
      const failureDurationMs = Date.now() - new Date(prev.degraded_since).getTime();
      if (failureDurationMs < CIRCUIT_BREAK_AFTER_MS) return actions;
    }

    // Check restart threshold for CrashLoop issues
    const maxRestarts = Math.max(
      0,
      ...criticalIssues
        .filter((i) => i.type === 'crash_loop_backoff')
        .map((i) => i.restarts ?? 0),
    );
    const hasImagePull = criticalIssues.some((i) => i.type === 'image_pull_backoff');

    if (!hasImagePull && maxRestarts < CIRCUIT_BREAK_AFTER_RESTARTS) return actions;

    try {
      // List pods to find owner deployments
      const podResponse = await this.coreApi!.listNamespacedPod({ namespace: env.namespace });
      const pods = podResponse.items ?? [];

      // Collect failing pod names
      const failingPodNames = new Set(criticalIssues.map((i) => i.pod));

      // Find ReplicaSet owners of failing pods
      const replicaSetNames = new Set<string>();
      for (const pod of pods) {
        if (!failingPodNames.has(pod.metadata?.name ?? '')) continue;
        for (const ref of pod.metadata?.ownerReferences ?? []) {
          if (ref.kind === 'ReplicaSet') {
            replicaSetNames.add(ref.name);
          }
        }
      }

      // List deployments to match ReplicaSets to Deployments
      const deployResponse = await this.appsApi!.listNamespacedDeployment({ namespace: env.namespace });
      const deployments = deployResponse.items ?? [];

      // List ReplicaSets to map RS -> Deployment
      const rsResponse = await this.appsApi!.listNamespacedReplicaSet({ namespace: env.namespace });
      const replicaSets = rsResponse.items ?? [];

      // Build RS name -> deployment name map
      const rsToDeployment = new Map<string, string>();
      for (const rs of replicaSets) {
        const rsName = rs.metadata?.name ?? '';
        for (const ref of rs.metadata?.ownerReferences ?? []) {
          if (ref.kind === 'Deployment') {
            rsToDeployment.set(rsName, ref.name);
          }
        }
      }

      // Find unique deployment names to scale
      const deploymentsToScale = new Set<string>();
      for (const rsName of replicaSetNames) {
        const deployName = rsToDeployment.get(rsName);
        if (deployName) deploymentsToScale.add(deployName);
      }

      // Scale each failing deployment to 0
      for (const deployName of deploymentsToScale) {
        try {
          await this.appsApi!.patchNamespacedDeploymentScale({
            name: deployName,
            namespace: env.namespace,
            body: { spec: { replicas: 0 } },
          });

          actions.push({
            type: 'scale_to_zero',
            deployment: deployName,
            at: new Date().toISOString(),
          });

          console.log(`[sentinel] Circuit breaker: scaled ${deployName} to 0 in ${env.namespace}`);
        } catch (err) {
          console.error(
            `[sentinel] Failed to scale ${deployName} in ${env.namespace}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Update env deploy_status to 'failed' if we took any action
      if (actions.length > 0) {
        await this.environments.update(env.id, { deploy_status: 'failed' });
      }
    } catch (err) {
      console.error(
        `[sentinel] Circuit breaker error for ${env.namespace}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    return actions;
  }

  // ---------------------------------------------------------------------------
  // Daily summary (08:00 UTC)
  // ---------------------------------------------------------------------------

  private async sendDailySummary(): Promise<void> {
    const summary = await this.healthChecks.summary();
    const degraded = await this.healthChecks.listAll({ status: 'degraded' });
    const critical = await this.healthChecks.listAll({ status: 'critical' });

    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const lines: string[] = [
      `**Daily Health Summary** — ${now}`,
      '',
      `Environments: ${summary.total} monitored`,
      `  ✅ ${summary.healthy} healthy`,
      `  🟡 ${summary.degraded} degraded`,
      `  🔴 ${summary.critical} critical`,
    ];

    const allIssues = [...critical, ...degraded];
    if (allIssues.length > 0) {
      lines.push('', '**Issues:**');
      for (const env of allIssues.slice(0, 10)) {
        const icon = env.status === 'critical' ? '🔴' : '🟡';
        lines.push(`  ${icon} ${env.environment_slug} — ${env.status}`);
        const issues = parseJsonField<HealthIssue[]>(env.issues_json);
        if (issues) {
          for (const issue of issues.slice(0, 3)) {
            lines.push(`     ${issue.type}: ${issue.pod}${issue.restarts ? ` (${issue.restarts} restarts)` : ''}`);
          }
        }
      }
    }

    if (summary.total === 0) {
      lines.push('', 'No environments monitored yet.');
    }

    await this.appendCostSummary(lines, new Date());

    const apiUrl = process.env.EVE_API_URL;
    const token = process.env.EVE_INTERNAL_API_KEY;
    if (apiUrl && token) {
      await fetch(`${apiUrl}/internal/platform-notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-eve-internal-token': token },
        body: JSON.stringify({
          severity: 'info',
          type: 'sentinel.report',
          environment: { org_slug: 'system', project_slug: 'platform', env_name: 'all' },
          issues: [],
          actions_taken: [],
          message: lines.join('\n'),
        }),
      }).catch(err => console.error('[sentinel] Failed to send daily summary:', err instanceof Error ? err.message : String(err)));
    }

    console.log(`[sentinel] Daily summary sent: ${summary.total} envs, ${summary.degraded} degraded, ${summary.critical} critical`);
  }

  private async appendCostSummary(lines: string[], now: Date): Promise<void> {
    const source = 'opencost';
    const monthStart = utcMonthStart(now);
    const topN = parsePositiveInt(process.env.EVE_SENTINEL_COST_TOP_N, DEFAULT_COST_TOP_N);
    const staleAfterHours = parsePositiveInt(
      process.env.EVE_SENTINEL_COST_STALE_AFTER_HOURS,
      DEFAULT_COST_STALE_AFTER_HOURS,
    );

    try {
      const renderedCloud = await this.appendCloudCostSummary(lines, monthStart, now, staleAfterHours, topN);
      if (renderedCloud) {
        return;
      }
    } catch (err) {
      console.warn('[sentinel] Cloud cost summary unavailable:', err instanceof Error ? err.message : String(err));
    }

    try {
      const [totals, rows, freshness] = await Promise.all([
        this.costSnapshots.totalForMonth(monthStart, source),
        this.costSnapshots.latestForMonth(monthStart, source),
        this.costSnapshots.freshnessForMonth(monthStart, source),
      ]);

      if (rows.length === 0 || freshness.observed_at == null) {
        lines.push('', 'Monthly cost: unavailable (collector not reporting)');
        return;
      }

      const observedAt = freshness.observed_at;
      const isStale = now.getTime() - observedAt.getTime() > staleAfterHours * 60 * 60 * 1000;
      const estimateLabel = isStale ? 'stale estimate' : 'fresh estimate';
      const envRows = rows
        .filter((row) => row.scope === 'environment')
        .slice(0, topN);

      lines.push('', `Monthly cost (${estimateLabel}) — ${formatUsd(totals.total_usd)} total`);
      if (envRows.length > 0) {
        lines.push('  Top environments:');
        for (const row of envRows) {
          const displayName = [
            row.org_id ?? '-',
            row.project_id ?? '-',
            row.environment_slug ?? row.environment_id ?? '-',
          ].join(' / ');
          lines.push(`    ${formatUsd(row.amount_usd)}  ${displayName}`);
        }
      }

      lines.push(`  Shared platform overhead: ${formatUsd(totals.shared_usd)} (unallocated)`);
      const lastObserved = isStale ? ` · last observed ${observedAt.toISOString()}` : '';
      lines.push(`  Source: ${source} · window=month-to-date · ${estimateLabel}${lastObserved}`);
      lines.push('  Full breakdown: eve system env-cost --all');
    } catch (err) {
      console.warn('[sentinel] Cost summary unavailable:', err instanceof Error ? err.message : String(err));
      lines.push('', 'Monthly cost: unavailable (snapshot read failed)');
    }
  }

  private async appendCloudCostSummary(
    lines: string[],
    monthStart: Date,
    now: Date,
    staleAfterHours: number,
    topN: number,
  ): Promise<boolean> {
    const scopeKey = process.env.EVE_CLOUD_COST_SCOPE_KEY ?? 'eve-cluster';
    const provider = optionalIdentifier(process.env.EVE_CLOUD_COST_PROVIDER);
    const source = optionalIdentifier(process.env.EVE_CLOUD_COST_SOURCE);
    const row = await this.cloudCostSnapshots.latestForScope({
      provider,
      source,
      scopeType: 'cluster',
      scopeKey,
      windowStart: monthStart,
    });
    if (!row) {
      return false;
    }

    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) {
      return false;
    }

    const observedAt = row.observed_at;
    const isStale = now.getTime() - observedAt.getTime() > staleAfterHours * 60 * 60 * 1000;
    const staleLabel = isStale ? ' (stale)' : '';
    const projected = row.projected_amount ? `${formatCurrency(row.projected_amount, row.currency)} projected / ` : '';
    const lastObserved = isStale ? ` · last observed ${observedAt.toISOString()}` : '';

    lines.push('', `Monthly ${row.scope_label} cloud cost${staleLabel} — ${projected}${formatCurrency(row.amount, row.currency)} MTD`);
    await this.appendTopAppCostSummary(lines, monthStart, topN);
    if (isStale) {
      lines.push(`Note: stale snapshot${lastObserved}`);
    }
    return true;
  }

  private async appendTopAppCostSummary(lines: string[], monthStart: Date, topN: number): Promise<void> {
    let rows: EnvironmentCostSnapshot[];
    try {
      rows = await this.costSnapshots.latestForMonth(monthStart, 'opencost');
    } catch (err) {
      console.warn('[sentinel] App cost summary unavailable:', err instanceof Error ? err.message : String(err));
      lines.push('Top apps: unavailable');
      lines.push('Full app list: eve system env-cost --all');
      return;
    }

    const allAppRows = rows.filter((entry) => entry.scope === 'environment');
    const appRows = allAppRows.slice(0, topN);

    if (appRows.length === 0) {
      lines.push('Top apps: unavailable (app pods need resource requests)');
      lines.push('Full app list: eve system env-cost --all');
      return;
    }

    const assignedTotal = allAppRows.reduce((sum, row) => sum + Number(row.amount_usd), 0);
    lines.push(`Top apps (OpenCost assigned: ${formatUsd(String(assignedTotal))} across ${allAppRows.length} app${allAppRows.length === 1 ? '' : 's'}):`);
    for (const row of appRows) {
      lines.push(` - ${formatAppCostLabel(row)}: ${formatAppUsd(row.amount_usd)}`);
    }
    lines.push('Full app list: eve system env-cost --all');
  }
}

function utcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `$${value}`;
  return `$${parsed.toFixed(2)}`;
}

function formatAppUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `$${value}`;
  if (parsed > 0 && parsed < 0.01) return '<$0.01';
  return `$${parsed.toFixed(2)}`;
}

function optionalIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return /^[a-z0-9_-]+$/i.test(normalized) ? normalized : undefined;
}

function formatCurrency(value: string, currency: string): string {
  if (currency === 'USD') return formatUsd(value);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `${value} ${currency}`;
  return `${parsed.toFixed(2)} ${currency}`;
}

function formatAppCostLabel(row: EnvironmentCostSnapshot): string {
  if (row.environment_slug && row.environment_slug.includes('/')) {
    return row.environment_slug;
  }
  const parts = [
    row.project_id,
    row.environment_slug ?? row.environment_id,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return parts.length > 0 ? parts.join(' / ') : 'unknown app';
}

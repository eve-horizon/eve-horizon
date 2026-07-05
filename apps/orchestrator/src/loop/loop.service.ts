import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  loadConfig,
  type ProjectId,
  type JobId,
  type AttemptId,
  type HarnessName,
  type HarnessResult,
  type JobGitConfig,
  type JobWorkspaceConfig,
  generateEventId,
  resolveHarnessName,
  selectAvailableHarness,
  SecretResolveResponseSchema,
  type SecretResolveItem,
  type ResourceRef,
  DEFAULT_BILLING_DEFAULTS_V1,
  DEFAULT_RATE_CARD_EFFECTIVE_AT,
  DEFAULT_RATE_CARD_NAME,
  DEFAULT_RATE_CARD_V1,
  DEFAULT_RATE_CARD_VERSION,
  DEFAULT_RESOURCE_CLASS_NAME,
  DEFAULT_RESOURCE_CLASSES_V1,
  AccessBindingScopeSchema,
  parseResourceClassesV1,
  resolveResourceClassName,
  getResourceClassSpec,
  parseBillingDefaultsV1,
  resolveBillingConfigV1,
  assembleAttemptReceiptV2,
  generateBalanceTransactionId,
  type RateCardV1,
  type HarnessProfileSource,
  type AccessBindingScope,
  readPositiveTimeoutSeconds,
  parseWorkerUrlMapping,
} from '@eve/shared';
import {
  accessRoleQueries,
  eventQueries,
  gateQueries,
  ingestRecordQueries,
  jobQueries,
  pipelineRunQueries,
  projectManifestQueries,
  projectQueries,
  orgQueries,
  executionLogQueries,
  pricingRateCardQueries,
  exchangeRateQueries,
  systemSettingsQueries,
  threadMessageQueries,
  spendQueries,
  balanceLedgerQueries,
  type Db,
  type Job,
  type JobAttempt,
  type PipelineRun,
  type Project,
} from '@eve/db';
import { WorkerService } from '../worker/worker.service';
import * as yaml from 'yaml';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { ConcurrencyTuner, TunerConfig } from './concurrency-tuner';
import { resolveRequiredJobGates } from './job-gates';
import { readPositiveInt, RecoveryService } from './recovery.service';

export {
  evaluateAttemptInitHealth,
  evaluateAttemptStartupHealth,
  evaluateRunningAttemptHealth,
} from './recovery.service';

export const WAITING_BACKOFF_MS = 15000;

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function resolveWorkerPollTimeoutMs(job: Job, executionType: string): number {
  const hintTimeoutSeconds = readPositiveTimeoutSeconds(job.hints?.timeout_seconds);

  if (executionType === 'script') {
    const scriptTimeoutSeconds =
      readPositiveTimeoutSeconds(job.script_timeout_seconds) ??
      hintTimeoutSeconds ??
      1800;
    return scriptTimeoutSeconds * 1000 + 60_000;
  }

  if (executionType === 'action' && job.action_type === 'run') {
    const actionInput = job.action_input ?? {};
    const actionTimeoutSeconds =
      readPositiveTimeoutSeconds(actionInput.timeout_seconds) ??
      readPositiveTimeoutSeconds(actionInput.timeout) ??
      hintTimeoutSeconds ??
      1800;
    return actionTimeoutSeconds * 1000 + 60_000;
  }

  return (hintTimeoutSeconds ?? 1800) * 1000;
}

export function ticksForIntervalMs(loopIntervalMs: number, targetIntervalMs: number): number {
  const safeLoopMs = Math.max(100, loopIntervalMs);
  const safeTargetMs = Math.max(safeLoopMs, targetIntervalMs);
  return Math.max(1, Math.round(safeTargetMs / safeLoopMs));
}

type AdmissionBudgetBlock = { blocked: true; reason: string } | { blocked: false };

type EveControlStatus = 'waiting' | 'success' | 'failed' | 'prepared';

export function extractEveControl(
  resultJson: Record<string, unknown> | null | undefined,
): { status?: EveControlStatus; summary?: string; wakeOn?: string[] } {
  if (!resultJson || typeof resultJson !== 'object') {
    return {};
  }

  const eve = (resultJson as Record<string, unknown>).eve;
  if (!eve || typeof eve !== 'object') {
    return {};
  }

  const statusRaw = (eve as Record<string, unknown>).status;
  const summaryRaw = (eve as Record<string, unknown>).summary;
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : undefined;
  const summary = typeof summaryRaw === 'string' ? summaryRaw : undefined;

  // Extract wake_on from eve.wait.wake_on
  let wakeOn: string[] | undefined;
  const wait = (eve as Record<string, unknown>).wait;
  if (wait && typeof wait === 'object') {
    const wakeOnRaw = (wait as Record<string, unknown>).wake_on;
    if (Array.isArray(wakeOnRaw)) {
      wakeOn = wakeOnRaw.filter((v): v is string => typeof v === 'string');
    }
  }

  if (status === 'waiting' || status === 'success' || status === 'failed' || status === 'prepared') {
    return { status, summary, wakeOn };
  }

  return { summary };
}

export function resolveOrchestrationOutcome(
  result: HarnessResult,
  status?: EveControlStatus,
): EveControlStatus {
  if (status === 'waiting' || status === 'success' || status === 'failed' || status === 'prepared') {
    return status;
  }

  return result.success ? 'success' : 'failed';
}

export function computeWaitingDeferUntil(
  blocked: boolean,
  now: Date = new Date(),
): Date | null {
  if (blocked) {
    return null;
  }

  return new Date(now.getTime() + WAITING_BACKOFF_MS);
}

export function parseHarnessSpec(
  spec?: string,
): { harness?: HarnessName; variant?: string } {
  if (!spec) {
    return {};
  }

  const trimmed = spec.trim();
  if (!trimmed) {
    return {};
  }

  const colonIndex = trimmed.indexOf(':');
  const harnessName = colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
  const variantRaw = colonIndex === -1 ? undefined : trimmed.slice(colonIndex + 1);
  const variant = variantRaw && variantRaw.length > 0 ? variantRaw : undefined;
  const harness = resolveHarnessName(harnessName);

  return { harness, variant };
}

type OrgFsMountMode = 'none' | 'read' | 'write';

type OrgFsMountContext = {
  mode: OrgFsMountMode;
  allow_prefixes: string[];
  read_only_prefixes: string[];
};

const NO_ORG_FS_MOUNT: OrgFsMountContext = {
  mode: 'none',
  allow_prefixes: [],
  read_only_prefixes: [],
};

function normalizeScopedPrefix(prefix: string): string | null {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return null;
  }

  const wildcard = trimmed.endsWith('/**');
  const rawBase = wildcard ? trimmed.slice(0, -3) : trimmed;
  const normalizedBase = path.posix.normalize(rawBase.startsWith('/') ? rawBase : `/${rawBase}`);

  if (normalizedBase.split('/').some((segment) => segment === '..')) {
    return null;
  }

  if (wildcard) {
    return normalizedBase === '/' ? '/**' : `${normalizedBase.replace(/\/+$/, '')}/**`;
  }

  return normalizedBase || '/';
}

function scopePrefixBasePath(prefix: string): string {
  if (prefix === '/**') {
    return '/';
  }
  if (prefix.endsWith('/**')) {
    const base = prefix.slice(0, -3).replace(/\/+$/, '');
    return base || '/';
  }
  return prefix;
}

function matchesScopedPrefix(pathValue: string, prefix: string): boolean {
  if (prefix === '/**') {
    return true;
  }
  const base = scopePrefixBasePath(prefix);
  return pathValue === base || pathValue.startsWith(`${base}/`);
}

function normalizeScopedPrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') {
      continue;
    }
    const prefix = normalizeScopedPrefix(value);
    if (prefix) {
      normalized.add(prefix);
    }
  }
  return [...normalized].sort();
}

function scopeHasOrgFsPermissions(permissions: string[]): { read: boolean; write: boolean } {
  const write = permissions.includes('orgfs:write') || permissions.includes('orgfs:admin');
  const read = write || permissions.includes('orgfs:read');
  return { read, write };
}

export function deriveOrgFsMountContext(
  bindings: Array<{ role_permissions: string[]; scope_json?: unknown }>,
): OrgFsMountContext {
  const readable = new Set<string>();
  const writable = new Set<string>();
  const explicitReadOnly = new Set<string>();

  for (const binding of bindings) {
    const perms = scopeHasOrgFsPermissions(binding.role_permissions ?? []);
    if (!perms.read) {
      continue;
    }

    const scope = (binding.scope_json && typeof binding.scope_json === 'object')
      ? binding.scope_json as { orgfs?: { allow_prefixes?: unknown; read_only_prefixes?: unknown } }
      : undefined;
    const orgfsScope = scope?.orgfs;
    if (!orgfsScope) {
      continue;
    }

    const allowPrefixes = normalizeScopedPrefixes(orgfsScope.allow_prefixes);
    if (allowPrefixes.length === 0) {
      continue;
    }

    for (const prefix of allowPrefixes) {
      readable.add(prefix);
      if (perms.write) {
        writable.add(prefix);
      }
    }

    if (!perms.write) {
      for (const prefix of allowPrefixes) {
        explicitReadOnly.add(prefix);
      }
    }

    for (const prefix of normalizeScopedPrefixes(orgfsScope.read_only_prefixes)) {
      if (allowPrefixes.some((allow) =>
        matchesScopedPrefix(scopePrefixBasePath(prefix), allow) ||
        matchesScopedPrefix(scopePrefixBasePath(allow), prefix))) {
        explicitReadOnly.add(prefix);
      }
    }
  }

  if (readable.size === 0) {
    return NO_ORG_FS_MOUNT;
  }

  const allowPrefixes = [...readable].sort();
  const readOnlyPrefixes = new Set<string>(explicitReadOnly);
  for (const prefix of readable) {
    if (!writable.has(prefix)) {
      readOnlyPrefixes.add(prefix);
    }
  }

  return {
    mode: writable.size > 0 ? 'write' : 'read',
    allow_prefixes: allowPrefixes,
    read_only_prefixes: [...readOnlyPrefixes].sort(),
  };
}

function deriveOrgFsMountContextFromTokenScope(scope: AccessBindingScope | null | undefined): OrgFsMountContext {
  const orgfsScope = scope?.orgfs;
  if (!orgfsScope) {
    return NO_ORG_FS_MOUNT;
  }

  const allowPrefixes = normalizeScopedPrefixes(orgfsScope.allow_prefixes);
  const readOnlyPrefixes = normalizeScopedPrefixes(orgfsScope.read_only_prefixes);
  if (allowPrefixes.length === 0 && readOnlyPrefixes.length === 0) {
    return NO_ORG_FS_MOUNT;
  }

  return {
    mode: allowPrefixes.length > 0 ? 'write' : 'read',
    allow_prefixes: [...new Set([...allowPrefixes, ...readOnlyPrefixes])].sort(),
    read_only_prefixes: readOnlyPrefixes,
  };
}

/**
 * Orchestrator polling loop.
 *
 * This service polls for ready jobs every 5 seconds and orchestrates
 * their execution through the worker. It handles:
 * - Claiming the next available job or pipeline run
 * - Creating workspace directories
 * - Creating and managing job attempts
 * - Invoking the worker service
 * - Updating job and attempt status based on results
 *
 * Supports concurrent dispatch up to the configured ORCH_CONCURRENCY limit.
 * Each tick dispatches as many items as there is capacity for, with each
 * dispatch running as a background promise (fire-and-forget from tick's
 * perspective).
 */
/**
 * Result of dispatching a claimed job and completing its attempt.
 *
 * 'completed' — the attempt was completed by this orchestrator; the caller
 * finalizes the job from the worker result.
 * 'externally_finalized' — the attempt was finalized by another path (e.g.
 * pod shutdown drain); the job phase has already been recovered and the
 * caller must stop processing with the recorded attempt outcome.
 */
type JobDispatchOutcome =
  | {
      kind: 'completed';
      result: HarnessResult;
      eveControl: ReturnType<typeof extractEveControl>;
      outcome: EveControlStatus;
      completedAttempt: JobAttempt;
    }
  | {
      kind: 'externally_finalized';
      attemptSucceeded: boolean;
      lastErrorMessage: string | null;
    };

@Injectable()
export class LoopService implements OnModuleInit, OnModuleDestroy {
  private readonly config = loadConfig();
  private readonly limiter: ConcurrencyLimiter;
  private readonly tuner: ConcurrencyTuner;
  private readonly recovery: RecoveryService;
  private readonly loopIntervalMs: number;
  private readonly heartbeatIntervalTicks: number;
  private readonly pipelineReconcileIntervalTicks: number;
  private readonly wakeOnIntervalTicks: number;
  private readonly inFlightJobs = new Map<string, number>(); // jobId -> dispatch start timestamp
  private intervalId?: NodeJS.Timeout;
  private tickCount = 0;
  private jobsProcessed = 0;
  private _stopping = false;
  private _capacityLoggedOnce = false;
  private tickInProgress = false;
  private tickRerunRequested = false;
  private lastConcurrencyChange: Date;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly workerService: WorkerService,
  ) {
    this.limiter = new ConcurrencyLimiter(this.config.ORCH_CONCURRENCY);
    this.loopIntervalMs = Math.max(100, this.config.ORCH_LOOP_INTERVAL_MS);
    this.heartbeatIntervalTicks = ticksForIntervalMs(this.loopIntervalMs, 60_000);
    this.pipelineReconcileIntervalTicks = readPositiveInt(
      process.env.EVE_ORCH_PIPELINE_RECONCILE_INTERVAL_TICKS,
      ticksForIntervalMs(this.loopIntervalMs, 30_000),
    );
    this.wakeOnIntervalTicks = readPositiveInt(
      process.env.EVE_ORCH_WAKE_ON_INTERVAL_TICKS,
      ticksForIntervalMs(this.loopIntervalMs, 15_000),
    );
    this.lastConcurrencyChange = new Date();

    // Initialize concurrency auto-tuner
    this.tuner = new ConcurrencyTuner(this.limiter, {
      enabled: this.config.ORCH_TUNER_ENABLED,
      min: this.config.ORCH_CONCURRENCY_MIN,
      max: this.config.ORCH_CONCURRENCY_MAX,
      intervalMs: this.config.ORCH_TUNER_INTERVAL_MS,
      cpuThreshold: this.config.ORCH_TUNER_CPU_THRESHOLD,
      memoryThreshold: this.config.ORCH_TUNER_MEMORY_THRESHOLD,
    });

    // Watchdog/recovery sweeps live in RecoveryService; it shares this
    // service's db handle, in-flight dispatch map, and concurrency limiter.
    this.recovery = new RecoveryService(
      this.db,
      this.inFlightJobs,
      this.limiter,
      (job, attempt, details) => this.emitJobFailureEvent(job, attempt, details),
      (parentId) => this.tryCloseWorkflowRoot(parentId),
      (job, succeeded, errorMessage) => this.syncIngestRecordStatus(job, succeeded, errorMessage),
    );
  }

  async onModuleInit() {
    // Recover any orphaned jobs from a previous orchestrator instance
    await this.recovery.recoverOrphanedJobs();
    await this.recoverCompletedAttempts();

    console.log(
      `Starting orchestrator polling loop (${this.loopIntervalMs}ms interval, concurrency: ${this.limiter.limit})`,
    );
    this.startLoop();

    // Start concurrency auto-tuner if enabled
    this.tuner.start();
  }

  private async recoverCompletedAttempts() {
    const jobs = jobQueries(this.db);
    const gates = gateQueries(this.db);

    const completedAttempts = await this.db<{
      attempt_id: string;
      job_id: string;
      exit_code: number | null;
      duration_ms: number | null;
      result_json: Record<string, unknown> | null;
      result_text: string | null;
    }[]>`
      SELECT
        a.id AS attempt_id,
        a.job_id AS job_id,
        (el.content->>'exitCode')::int AS exit_code,
        (el.content->>'durationMs')::int AS duration_ms,
        (el.content->>'resultJson')::jsonb AS result_json,
        (el.content->>'resultText') AS result_text
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      JOIN LATERAL (
        SELECT content
        FROM execution_logs
        WHERE attempt_id = a.id
          AND type = 'system'
          AND content->>'event' = 'completed'
        ORDER BY seq DESC
        LIMIT 1
      ) el ON true
      WHERE a.status = 'running'
        AND j.phase = 'active'
    `;

    if (completedAttempts.length === 0) {
      return;
    }

    console.log(
      `Found ${completedAttempts.length} running attempt(s) with completion logs, recovering...`,
    );

    for (const attempt of completedAttempts) {
      try {
        // Skip jobs with a recent active dispatch — let the dispatch finalize them.
        // But if the dispatch has been stuck for >30 seconds, force-recover.
        const dispatchStart = this.inFlightJobs.get(attempt.job_id);
        if (dispatchStart !== undefined) {
          const elapsedMs = Date.now() - dispatchStart;
          const graceMs = 30 * 1000; // 30 seconds
          if (elapsedMs < graceMs) {
            console.log(
              `Skipping recovery for job ${attempt.job_id}; active dispatch will handle finalization`,
            );
            continue;
          }
          console.log(
            `Force-recovering job ${attempt.job_id}; dispatch stuck for ${Math.round(elapsedMs / 1000)}s`,
          );
          this.inFlightJobs.delete(attempt.job_id);
          this.limiter.release();
        }

        const exitCode = Number.isFinite(attempt.exit_code ?? NaN)
          ? (attempt.exit_code as number)
          : 1;
        const durationMs = Number.isFinite(attempt.duration_ms ?? NaN)
          ? (attempt.duration_ms as number)
          : undefined;

        // Build a minimal HarnessResult for resolveOrchestrationOutcome
        const recoveryResult: HarnessResult = {
          attemptId: attempt.attempt_id as AttemptId,
          success: exitCode === 0,
          exitCode,
          resultJson: attempt.result_json ?? undefined,
          resultText: attempt.result_text ?? undefined,
        };
        const eveControl = extractEveControl(recoveryResult.resultJson);
        const outcome = resolveOrchestrationOutcome(recoveryResult, eveControl?.status);

        const attemptStatus = outcome === 'failed' ? 'failed' : 'succeeded';
        const errorMessage =
          outcome === 'failed'
            ? `Recovered attempt ${attempt.attempt_id} with exit code ${exitCode}`
            : undefined;

        const completed = await jobs.completeAttempt(attempt.attempt_id, attemptStatus, {
          exitCode,
          durationMs,
          errorMessage,
        });
        if (!completed) {
          console.log(`Attempt ${attempt.attempt_id} already finalized; skipping completed-attempt recovery`);
          continue;
        }
        const job = await jobs.findById(attempt.job_id);
        if (job) {
          await this.tryPersistAttemptReceipt(job, completed);
          await this.tryChargeForReceipt(job, completed);
        }

        if (outcome === 'success') {
          await jobs.markJobDone(attempt.job_id);
          console.log(`Recovered completed job ${attempt.job_id}`);
        } else if (outcome === 'waiting') {
          // Don't mark done or failed; the next tick will handle re-execution
          console.log(`Recovered waiting job ${attempt.job_id}; will re-process on next tick`);
        } else {
          await jobs.markJobFailed(attempt.job_id, errorMessage ?? 'Recovered failed attempt');
          console.log(`Recovered failed job ${attempt.job_id}`);
        }

        const released = await gates.releaseGates(attempt.job_id);
        if (released > 0) {
          console.log(`Released ${released} gate(s) for recovered job ${attempt.job_id}`);
        }

        // Close workflow root when all children reach terminal state
        if (job?.parent_id && outcome !== 'waiting') {
          await this.tryCloseWorkflowRoot(job.parent_id);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to recover completed attempt ${attempt.attempt_id}: ${errMsg}`);
      }
    }
  }

  private async tryPersistAttemptReceipt(job: Job, attempt: JobAttempt): Promise<void> {
    try {
      // Idempotent: don't overwrite receipts (admin recompute comes later).
      if (attempt.receipt_json) return;
      if (!attempt.ended_at) return;

      const projects = projectQueries(this.db);
      const project = await projects.findById(job.project_id);
      if (!project) {
        console.warn(`[receipt] Skipping receipt for attempt ${attempt.id}: missing project ${job.project_id}`);
        return;
      }

      const org = await orgQueries(this.db).findById(project.org_id);

      // Resolve billing defaults + org overrides.
      const settings = systemSettingsQueries(this.db);
      const billingDefaultsSetting = await settings.get('billing.defaults');
      let systemDefaults = DEFAULT_BILLING_DEFAULTS_V1;
      if (billingDefaultsSetting?.value) {
        try {
          systemDefaults = parseBillingDefaultsV1(billingDefaultsSetting.value);
        } catch (err) {
          console.warn(
            `[receipt] Invalid system billing.defaults; falling back to defaults: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const billing = resolveBillingConfigV1({
        system_defaults: systemDefaults,
        org_billing_config: org?.billing_config,
      });

      // Resolve the effective rate card at attempt end time.
      const rateCards = pricingRateCardQueries(this.db);
      const at = attempt.ended_at ?? new Date();
      const cardRow = await rateCards.findLatestEffective(billing.rate_card_name, at);

      const rateCard = cardRow
        ? {
          name: cardRow.name,
          version: cardRow.version,
          effective_at: cardRow.effective_at.toISOString(),
          rates: cardRow.rates_json as unknown as RateCardV1,
        }
        : {
          name: DEFAULT_RATE_CARD_NAME,
          version: DEFAULT_RATE_CARD_VERSION,
          effective_at: DEFAULT_RATE_CARD_EFFECTIVE_AT,
          rates: DEFAULT_RATE_CARD_V1,
        };

      const billingCurrency = (billing.billing_currency ?? 'usd').toLowerCase();

      // Resolve FX snapshot (USD -> billing currency).
      let fx: { rate: string; fetched_at: string; source: string } | null = null;
      if (billingCurrency !== 'usd') {
        const fxRow = await exchangeRateQueries(this.db).findLatest('usd', billingCurrency);
        if (fxRow) {
          fx = {
            rate: fxRow.rate,
            fetched_at: fxRow.fetched_at.toISOString(),
            source: fxRow.source,
          };
        } else {
          console.warn(`[receipt] Missing FX rate usd->${billingCurrency}; billed totals will use rate=1`);
        }
      }

      // Resolve resource class sizing for compute accounting (Phase 5).
      const manifestDefaults = await this.getManifestDefaults(job.project_id);
      const resourceClassesSetting = await settings.get('resource_classes');
      const resourceClasses = parseResourceClassesV1(resourceClassesSetting?.value) ?? DEFAULT_RESOURCE_CLASSES_V1;
      const resourceClassName = resolveResourceClassName({
        job_hints: (job.hints ?? null) as Record<string, unknown> | null,
        manifest_defaults: manifestDefaults,
        fallback: DEFAULT_RESOURCE_CLASS_NAME,
      });
      const resourceSpec = getResourceClassSpec(resourceClasses, resourceClassName);

      const logs = await executionLogQueries(this.db).listLogs(attempt.id);

      const { receipt, materialized } = assembleAttemptReceiptV2({
        job: {
          id: job.id,
          project_id: job.project_id,
          created_at: job.created_at,
          ready_at: job.ready_at,
          defer_until: job.defer_until,
          phase: job.phase,
          hints: (job.hints ?? null) as Record<string, unknown> | null,
        },
        attempt: {
          id: attempt.id,
          job_id: attempt.job_id,
          started_at: attempt.started_at,
          execution_started_at: attempt.execution_started_at,
          ended_at: attempt.ended_at,
          duration_ms: attempt.duration_ms,
          runtime_meta: (attempt.runtime_meta ?? null) as Record<string, unknown> | null,
        },
        org_id: project.org_id,
        logs: logs.map((l) => ({ type: l.type, content: l.content })),
        resource_class: {
          name: resourceClassName,
          requested_vcpu: resourceSpec?.vcpu ?? null,
          requested_memory_gib: resourceSpec?.memory_gib ?? null,
        },
        pricing: {
          rate_card: rateCard,
          markup_pct: billing.markup_pct,
          billing_currency: billingCurrency,
          fx,
        },
      });

      await jobQueries(this.db).updateAttemptReceipt(attempt.id, receipt as unknown as Record<string, unknown>, {
        baseTotalUsd: materialized.base_total_usd,
        billedTotal: materialized.billed_total,
        billedCurrency: materialized.billed_currency,
      });
    } catch (err) {
      console.error(
        `[receipt] Failed to persist receipt for attempt ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Charge the org balance for a completed attempt's billed cost.
   * This is called after receipt persistence succeeds.
   * Failures are logged but never fail the attempt finalization.
   */
  private async tryChargeForReceipt(job: Job, attempt: JobAttempt): Promise<void> {
    try {
      // Only charge if we have a persisted receipt with billed cost.
      if (!attempt.receipt_json) return;

      const billedTotal = attempt.receipt_billed_total;
      const billedCurrency = attempt.receipt_billed_currency;

      // No cost to charge.
      if (!billedTotal || parseFloat(String(billedTotal)) <= 0) return;
      if (!billedCurrency) return;

      const project = await projectQueries(this.db).findById(job.project_id);
      if (!project) {
        console.warn(`[charge] Skipping charge for attempt ${attempt.id}: missing project ${job.project_id}`);
        return;
      }

      const ledger = balanceLedgerQueries(this.db);

      // Ensure the org has a balance row (idempotent).
      await ledger.ensureBalance(project.org_id, billedCurrency);

      // Create the charge transaction (idempotent via UNIQUE on source_type + source_id).
      await ledger.createTransaction({
        id: generateBalanceTransactionId(),
        org_id: project.org_id,
        type: 'charge',
        amount: String(billedTotal),
        currency: billedCurrency,
        description: `Job ${job.id} attempt ${attempt.id} charge`,
        source_type: 'receipt',
        source_id: attempt.id,
      });

      console.log(`[charge] Charged org ${project.org_id} ${billedTotal} ${billedCurrency} for attempt ${attempt.id}`);
    } catch (err) {
      // Charging failures must NOT fail the attempt finalization.
      console.warn(
        `[charge] Failed to charge for attempt ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private startLoop() {
    // Run immediately on startup
    this.requestTick();

    // Then poll on configured interval
    this.intervalId = setInterval(() => {
      this.requestTick();
    }, this.loopIntervalMs);
  }

  private requestTick(): void {
    if (this._stopping) {
      return;
    }

    if (this.tickInProgress) {
      this.tickRerunRequested = true;
      return;
    }

    this.tickInProgress = true;
    void this.runScheduledTicks();
  }

  private async runScheduledTicks(): Promise<void> {
    try {
      do {
        this.tickRerunRequested = false;
        await this.tick();
      } while (this.tickRerunRequested && !this._stopping);
    } catch (err) {
      console.error('Error in orchestrator tick:', err);
    } finally {
      this.tickInProgress = false;
    }
  }

  private async claimNextPipelineRun(): Promise<PipelineRun | null> {
    const [run] = await this.db<PipelineRun[]>`
      UPDATE pipeline_runs
      SET status = 'running',
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
      WHERE id = (
        SELECT id FROM pipeline_runs
        WHERE status = 'pending'
          AND (run_mode IS NULL OR run_mode != 'jobs')
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    return run ?? null;
  }

  private async claimNextJobWithBudgetCheck(
    jobs: ReturnType<typeof jobQueries>,
  ): Promise<{ job: Job; attempt: JobAttempt } | null> {
    const candidates = await jobs.getReadyJobs('', { limit: 20 });
    if (candidates.length === 0) return null;

    for (const job of candidates) {
      // Evaluate step condition before claiming — skip the job if condition is false
      const conditionResult = await this.evaluateStepCondition(jobs, job);
      if (conditionResult && !conditionResult.shouldRun) {
        await this.skipConditionalJob(jobs, job, conditionResult.reason!);
        continue;
      }

      const budget = await this.checkJobAdmissionBudget(job);
      if (budget.blocked) {
        await this.annotateBudgetBlocked(job.id, budget.reason);
        continue;
      }

      await this.clearBudgetBlocked(job.id);

      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = job.harness ?? hintHarness ?? undefined;
      const result = await jobs.claim(job.id, 'orchestrator', effectiveHarness);
      if (!result.success || !result.attempt) {
        continue;
      }

      const updatedJob = await jobs.findById(job.id);
      if (!updatedJob) {
        continue;
      }

      return { job: updatedJob, attempt: result.attempt };
    }

    return null;
  }

  private async claimNextAssignedJobWithBudgetCheck(
    jobs: ReturnType<typeof jobQueries>,
  ): Promise<{ job: Job; attempt: JobAttempt } | null> {
    const candidates = await jobs.getReadyAssignedJobs('', { limit: 20 });
    if (candidates.length === 0) return null;

    for (const job of candidates) {
      // Evaluate step condition before claiming — skip the job if condition is false
      const conditionResult = await this.evaluateStepCondition(jobs, job);
      if (conditionResult && !conditionResult.shouldRun) {
        await this.skipConditionalJob(jobs, job, conditionResult.reason!);
        continue;
      }

      const budget = await this.checkJobAdmissionBudget(job);
      if (budget.blocked) {
        await this.annotateBudgetBlocked(job.id, budget.reason);
        continue;
      }

      await this.clearBudgetBlocked(job.id);

      const agentId = job.assignee ?? 'orchestrator';
      const hintHarness = typeof job.hints?.harness === 'string' ? job.hints.harness : undefined;
      const effectiveHarness = job.harness ?? hintHarness ?? undefined;
      const result = await jobs.claim(job.id, agentId, effectiveHarness);
      if (!result.success || !result.attempt) {
        continue;
      }

      const updatedJob = await jobs.findById(job.id);
      if (!updatedJob) {
        continue;
      }

      return { job: updatedJob, attempt: result.attempt };
    }

    return null;
  }

  private async checkJobAdmissionBudget(job: Job): Promise<AdmissionBudgetBlock> {
    try {
      // Org billing config lives on orgs.billing_config; we resolve currency via system defaults + org overrides.
      const project = await projectQueries(this.db).findById(job.project_id);
      if (!project) return { blocked: false };

      const org = await orgQueries(this.db).findById(project.org_id);
      const billingConfig = (org?.billing_config ?? {}) as Record<string, unknown>;

      const hardCap = readPositiveNumber(billingConfig.hard_cap_amount);
      const dailyMax = readPositiveNumber(billingConfig.daily_max_amount);

      // No caps configured.
      if (hardCap === null && dailyMax === null) {
        return { blocked: false };
      }

      // Resolve billing currency using same logic as receipts.
      const settings = systemSettingsQueries(this.db);
      const billingDefaultsSetting = await settings.get('billing.defaults');
      let systemDefaults = DEFAULT_BILLING_DEFAULTS_V1;
      if (billingDefaultsSetting?.value) {
        try {
          systemDefaults = parseBillingDefaultsV1(billingDefaultsSetting.value);
        } catch (err) {
          console.warn(
            `[budget] Invalid system billing.defaults; falling back: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const billing = resolveBillingConfigV1({
        system_defaults: systemDefaults,
        org_billing_config: org?.billing_config,
      });
      const billingCurrency = (billing.billing_currency ?? 'usd').toLowerCase();

      const spend = spendQueries(this.db);

      if (hardCap !== null) {
        const total = await spend.sumOrgSpend(project.org_id, { billed_currency: billingCurrency });
        const current = Number(total.billed_total);
        if (Number.isFinite(current) && current >= hardCap) {
          return { blocked: true, reason: 'org hard cap exceeded' };
        }
      }

      if (dailyMax !== null) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const total = await spend.sumOrgSpend(project.org_id, { since, billed_currency: billingCurrency });
        const current = Number(total.billed_total);
        if (Number.isFinite(current) && current >= dailyMax) {
          return { blocked: true, reason: 'org daily max exceeded' };
        }
      }

      return { blocked: false };
    } catch (err) {
      // Budget checks should never crash the scheduler; fail open.
      console.warn(`[budget] Admission check failed for job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { blocked: false };
    }
  }

  private async annotateBudgetBlocked(jobId: string, reason: string): Promise<void> {
    try {
      await this.db`
        UPDATE jobs
        SET
          hints = COALESCE(hints, '{}'::jsonb) || ${this.db.json({
            budget_blocked: true,
            budget_blocked_reason: reason,
          } as never)}::jsonb,
          updated_at = NOW()
        WHERE id = ${jobId}
          AND (
            COALESCE((hints->>'budget_blocked')::boolean, false) IS DISTINCT FROM true
            OR COALESCE(hints->>'budget_blocked_reason', '') IS DISTINCT FROM ${reason}
          )
      `;
    } catch (err) {
      console.warn(`[budget] Failed to annotate budget block for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async clearBudgetBlocked(jobId: string): Promise<void> {
    try {
      await this.db`
        UPDATE jobs
        SET
          hints = (COALESCE(hints, '{}'::jsonb) - 'budget_blocked' - 'budget_blocked_reason'),
          updated_at = NOW()
        WHERE id = ${jobId}
          AND (hints ? 'budget_blocked' OR hints ? 'budget_blocked_reason')
      `;
    } catch (err) {
      console.warn(`[budget] Failed to clear budget block for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============================================================================
  // Conditional step execution
  // ============================================================================

  /**
   * Evaluate a workflow step's condition (if any) against the referenced step's result.
   * Returns null if the job has no condition (i.e., unconditional execution).
   * Returns { shouldRun: true } if the condition evaluates to true.
   * Returns { shouldRun: false, reason } if the condition evaluates to false.
   */
  private async evaluateStepCondition(
    jobs: ReturnType<typeof jobQueries>,
    job: Job,
  ): Promise<{ shouldRun: boolean; reason?: string } | null> {
    const condition = (job.hints as Record<string, unknown> | null)?.condition;
    if (typeof condition !== 'string') return null;

    // Only workflow step jobs (with a parent) can have conditions
    if (!job.parent_id) {
      console.warn(`[workflow] Job ${job.id} has condition but no parent_id — ignoring condition`);
      return null;
    }

    // Parse the condition: step_name.status == 'value' or step_name.status != 'value'
    const match = condition.match(
      /^(\w[\w-]*)\s*\.\s*status\s*(==|!=)\s*['"]([^'"]*)['"]\s*$/,
    );
    if (!match) {
      console.warn(`[workflow] Job ${job.id} has unparseable condition "${condition}" — running unconditionally`);
      return null;
    }

    const [, refStepName, operator, expectedValue] = match;

    // Prefer the concrete dependency edge for this generation. Workflow retry
    // creates replacement jobs with the same step_name, so sibling lookup alone
    // can accidentally read a superseded earlier attempt.
    const dependencies = await jobs.getDependencies(job.id);
    const siblingJob =
      dependencies.find((dep) => dep.step_name === refStepName || dep.hints?.step_name === refStepName)
      ?? await jobs.findSiblingByStepName(job.parent_id, refStepName);
    if (!siblingJob) {
      console.warn(`[workflow] Job ${job.id} condition references step "${refStepName}" but sibling not found — running unconditionally`);
      return null;
    }

    // The referenced step must be done for us to evaluate the condition
    if (siblingJob.phase !== 'done' && siblingJob.phase !== 'cancelled') {
      // Dependency not yet complete — this shouldn't happen since depends_on
      // gates readiness, but guard against it
      console.warn(`[workflow] Job ${job.id} condition step "${refStepName}" is still in phase "${siblingJob.phase}" — deferring`);
      return null;
    }

    // Extract the status from the referenced step's latest attempt result_json.eve.status
    let actualStatus: string | undefined;
    const latestAttempt = await jobs.getLatestAttempt(siblingJob.id);
    if (latestAttempt?.result_json) {
      // result_json may be a parsed object OR a JSON string — handle both
      let parsed = latestAttempt.result_json as Record<string, unknown>;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { /* leave as-is */ }
      }
      const eve = parsed?.eve;
      if (eve && typeof eve === 'object') {
        const statusRaw = (eve as Record<string, unknown>).status;
        if (typeof statusRaw === 'string') {
          actualStatus = statusRaw;
        }
      }
    }

    // Evaluate the condition
    let shouldRun: boolean;
    if (operator === '==') {
      shouldRun = actualStatus === expectedValue;
    } else {
      shouldRun = actualStatus !== expectedValue;
    }

    const statusDisplay = actualStatus !== undefined ? `"${actualStatus}"` : 'undefined';
    if (shouldRun) {
      console.log(`[workflow] Step "${job.step_name}" (${job.id}): condition "${condition}" passed (actual: ${statusDisplay})`);
    } else {
      console.log(`[workflow] Step "${job.step_name}" (${job.id}): condition "${condition}" not met (actual: ${statusDisplay}) — skipping`);
    }

    return {
      shouldRun,
      reason: shouldRun ? undefined : `Condition "${condition}" not met (actual status: ${statusDisplay})`,
    };
  }

  /**
   * Skip a conditional workflow step by marking it as done with close_reason 'condition_not_met'.
   * Skipped steps count as done for dependency resolution, so downstream steps still become eligible.
   */
  private async skipConditionalJob(
    jobs: ReturnType<typeof jobQueries>,
    job: Job,
    reason: string,
  ): Promise<void> {
    try {
      await this.db`
        UPDATE jobs
        SET
          phase = 'done',
          close_reason = 'condition_not_met',
          closed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${job.id}
          AND phase NOT IN ('done', 'cancelled')
      `;
      console.log(`[workflow] Skipped step "${job.step_name}" (${job.id}): ${reason}`);
    } catch (err) {
      console.error(`[workflow] Failed to skip conditional job ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async processPipelineRun(
    run: PipelineRun,
    pipelineRuns: ReturnType<typeof pipelineRunQueries>,
  ): Promise<void> {
    console.log(`Claimed pipeline run ${run.id} (${run.pipeline_name})`);

    const result = await this.workerService.executePipelineRun(run.id);
    if (result.success) {
      // Copy pipeline output to root job result for job-based pipeline runs
      await this.copyPipelineOutputToRootJob(run.id, pipelineRuns);
      return;
    }

    const completedAt = new Date();
    await pipelineRuns.updateRun(run.id, {
      status: 'failed',
      completed_at: completedAt,
      error_message: result.error ?? 'Pipeline runner failed',
    });

    console.error(`Pipeline run ${run.id} failed: ${result.error ?? 'unknown error'}`);

    await this.emitPipelineFailureEvent(run, result.error ?? 'Pipeline runner failed');
  }

  /**
   * Emit structured metric log lines for observability.
   * Called during heartbeat ticks.
   */
  private logMetrics() {
    console.log(
      JSON.stringify({
        metric: 'orchestrator.in_flight',
        value: this.limiter.inFlight,
        limit: this.limiter.limit,
        jobs_processed: this.jobsProcessed,
        tick_count: this.tickCount,
      }),
    );
  }

  /**
   * Stop claiming new work. Existing in-flight dispatches continue to completion.
   * Called by the shutdown handler to drain gracefully.
   */
  stopClaiming() {
    this._stopping = true;
  }

  /**
   * Get current concurrency tuner status for admin endpoints.
   */
  getTunerStatus() {
    return this.tuner.getStatus();
  }

  /**
   * Get current concurrency status for admin endpoints.
   */
  getConcurrencyStatus() {
    return {
      limit: this.limiter.limit,
      inFlight: this.limiter.inFlight,
      uptimeSeconds: Math.floor(process.uptime()),
      lastChange: this.lastConcurrencyChange.toISOString(),
    };
  }

  /**
   * Set a new concurrency limit at runtime.
   */
  setConcurrency(newLimit: number) {
    this.limiter.setLimit(newLimit);
    this.lastConcurrencyChange = new Date();
    console.log(`Concurrency limit updated via admin API: ${newLimit}`);
  }

  private async tick() {
    this.tickCount++;

    // Log heartbeat roughly once per minute regardless of loop cadence.
    if (this.tickCount % this.heartbeatIntervalTicks === 0) {
      console.log(
        `Orchestrator heartbeat: ${this.tickCount} ticks, ${this.jobsProcessed} jobs processed, ${this.limiter.inFlight}/${this.limiter.limit} in-flight`,
      );
      this.logMetrics();
    }

    const recoveryIntervalTicks = parseInt(
      process.env.EVE_ORCH_RECOVERY_INTERVAL_TICKS ?? '1',
      10,
    );
    if (recoveryIntervalTicks > 0 && this.tickCount % Math.max(1, recoveryIntervalTicks) === 0) {
      await this.recoverCompletedAttempts();
    }

    const staleRecoveryIntervalTicks = parseInt(
      process.env.EVE_ORCH_STALE_RECOVERY_INTERVAL_TICKS ?? '1',
      10,
    );
    if (
      staleRecoveryIntervalTicks > 0
      && this.tickCount % Math.max(1, staleRecoveryIntervalTicks) === 0
    ) {
      await this.recovery.recoverAttemptInitTimeouts();
      await this.recovery.recoverAttemptStartupTimeouts();
      await this.recovery.recoverStaleRunningAttempts();
    }

    // Sweep zombie workflow roots — active roots where all children are terminal.
    // Runs at same cadence as stale recovery (every tick by default).
    if (
      staleRecoveryIntervalTicks > 0
      && this.tickCount % Math.max(1, staleRecoveryIntervalTicks) === 0
    ) {
      await this.sweepZombieWorkflowRoots();
    }

    // Recover active jobs where all attempts are terminal (e.g., pod shutdown drained
    // the attempt but job phase was never updated). Runs at same cadence as stale recovery.
    if (
      staleRecoveryIntervalTicks > 0
      && this.tickCount % Math.max(1, staleRecoveryIntervalTicks) === 0
    ) {
      await this.recovery.recoverActiveJobsWithTerminatedAttempts();
    }

    // Reconcile orphaned job-based pipeline runs on a wall-clock interval.
    if (this.tickCount % this.pipelineReconcileIntervalTicks === 0) {
      await this.reconcileOrphanedPipelineRuns();
    }

    // Check wake_on conditions on a wall-clock interval.
    if (this.tickCount % this.wakeOnIntervalTicks === 0) {
      await this.processWakeOnConditions();
    }

    if (this._stopping) return;

    // Dispatch as many items as we have capacity for
    while (this.limiter.hasCapacity && !this._stopping) {
      // Try pipeline first
      if (this.limiter.tryAcquire()) {
        const pipeline = await this.claimNextPipelineRun();
        if (pipeline) {
          this.dispatchPipeline(pipeline).catch((err) =>
            console.error(`Pipeline dispatch error: ${err}`),
          );
          continue; // Check for more capacity
        }
        // No pipeline claimed — release the slot, try a job instead
        this.limiter.release();
      }

      // Try job
      if (this.limiter.tryAcquire()) {
        const jobs = jobQueries(this.db);
        const claimed = await this.claimNextJobWithBudgetCheck(jobs);
        if (claimed) {
          this.dispatchJob(claimed).catch((err) =>
            console.error(`Job dispatch error: ${err}`),
          );
          continue; // Check for more capacity
        }
        const claimedAssigned = await this.claimNextAssignedJobWithBudgetCheck(jobs);
        if (claimedAssigned) {
          this.dispatchJob(claimedAssigned).catch((err) =>
            console.error(`Assigned job dispatch error: ${err}`),
          );
          continue; // Check for more capacity
        }
        // No job either — release and break
        this.limiter.release();
        break; // Nothing to claim, wait for next tick
      } else {
        // No capacity
        if (!this._capacityLoggedOnce) {
          console.debug(
            `Orchestrator at capacity (${this.limiter.inFlight}/${this.limiter.limit}), skipping claims`,
          );
          this._capacityLoggedOnce = true;
        }
        break;
      }
    }

    // Reset the one-shot capacity log when capacity becomes available again
    if (this.limiter.hasCapacity) {
      this._capacityLoggedOnce = false;
    }
  }

  /**
   * Fire-and-forget dispatch for a claimed pipeline run.
   * Acquires a limiter slot before entry (already acquired by tick)
   * and releases it in the finally block.
   */
  private async dispatchPipeline(run: PipelineRun): Promise<void> {
    const pipelineRuns = pipelineRunQueries(this.db);
    try {
      await this.processPipelineRun(run, pipelineRuns);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Unhandled error in pipeline dispatch for run ${run.id}: ${errMsg}`);
    } finally {
      this.limiter.release();
      console.debug(`Pipeline dispatch complete for ${run.id} (in-flight: ${this.limiter.inFlight}/${this.limiter.limit})`);

      if (this.limiter.hasCapacity && !this._stopping) {
        this.requestTick();
      }
    }
  }

  /**
   * Fire-and-forget dispatch for a claimed job.
   * Acquires a limiter slot before entry (already acquired by tick)
   * and releases it in the finally block.
   */
  private async dispatchJob(
    claimed: { job: Job; attempt: JobAttempt },
  ): Promise<void> {
    this.inFlightJobs.set(claimed.job.id, Date.now());
    try {
      await this.processJob(claimed);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Unhandled error in job dispatch for ${claimed.job.id}: ${errMsg}`);
    } finally {
      const wasTracked = this.inFlightJobs.delete(claimed.job.id);
      if (wasTracked) {
        this.limiter.release();
      } else {
        console.log(`Job ${claimed.job.id} was force-recovered; skipping limiter release`);
      }
      console.debug(`Job dispatch complete for ${claimed.job.id} (in-flight: ${this.limiter.inFlight}/${this.limiter.limit})`);

      if (this.limiter.hasCapacity && !this._stopping) {
        this.requestTick();
      }
    }
  }

  /**
   * Process a single claimed job through its full lifecycle:
   * gate acquisition, workspace creation, worker execution, completion, and cleanup.
   *
   * Extracted from the original tick() to support concurrent dispatch.
   */
  private async processJob(
    claimed: { job: Job; attempt: JobAttempt },
  ): Promise<void> {
    const { job, attempt } = claimed;
    const jobs = jobQueries(this.db);
    const gates = gateQueries(this.db);

    this.jobsProcessed++;
    console.log(`Claimed job ${job.id} (phase: ${job.phase})`);

    // Use config defaults for cleanup (new Jobs system doesn't have per-job cleanup settings)
    const cleanupOnSuccess = this.config.EVE_CLEANUP_WORKSPACE_ON_SUCCESS;
    const cleanupOnFailure = this.config.EVE_CLEANUP_WORKSPACE_ON_FAILURE;
    let workspacePath: string | undefined;
    let attemptSucceeded: boolean | null = null;
    let lastErrorMessage: string | null = null;

    // Track required gates for cleanup in finally block.
    // Keep orchestrator gate resolution aligned with API-side claim semantics.
    const requiredGates = resolveRequiredJobGates(job);

    try {
      // Step 1b: Acquire gates if job requires them
      const gateOutcome = await this.acquireJobGates(job, attempt, jobs, gates, requiredGates);
      if (gateOutcome === 'blocked') {
        return;
      }
      // Step 2: Parse job ID to get project_id
      // New Job IDs are like: project-slug-hash or project-slug-hash.1
      const projectId = job.project_id;

      // Step 3: Attempt is already created by claim()
      console.log(`Using attempt ${attempt.id} (number: ${attempt.attempt_number})`);

      // Step 4: Create workspace directory
      workspacePath = this.resolveWorkspacePath(job, attempt);
      await this.prepareJobWorkspace(workspacePath);

      // Step 5a: Enrich workflow step jobs with prior step results
      const enrichedDescription = await this.enrichWorkflowStep(job, jobs);

      // Steps 5b + 6: Execute worker and complete the attempt with result data
      const dispatched = await this.dispatchAndAwait(job, attempt, jobs, {
        projectId,
        workspacePath,
        enrichedDescription,
      });
      if (dispatched.kind === 'externally_finalized') {
        attemptSucceeded = dispatched.attemptSucceeded;
        lastErrorMessage = dispatched.lastErrorMessage;
        return;
      }
      // Steps 6b-8: receipts and charges, coordination relay, staged-council
      // promotion, and job status update from the worker result
      const finalized = await this.finalizeJobResult(job, attempt, jobs, dispatched);
      attemptSucceeded = finalized.attemptSucceeded;
      lastErrorMessage = finalized.lastErrorMessage;
    } catch (error) {
      // If anything goes wrong during execution, mark both attempt and job as failed
      const failure = await this.handleProcessJobError(job, attempt, jobs, error);
      attemptSucceeded = failure.attemptSucceeded;
      lastErrorMessage = failure.lastErrorMessage;
    } finally {
      await this.releaseJobResources({
        job,
        gates,
        requiredGates,
        workspacePath,
        attemptSucceeded,
        lastErrorMessage,
        cleanupOnSuccess,
        cleanupOnFailure,
      });
    }
  }

  /**
   * Finally path of processJob: release held gates, clean the workspace when
   * configured, and sync pipeline-run / ingest-record / workflow-root state
   * once the attempt reaches a terminal outcome (attemptSucceeded non-null).
   */
  private async releaseJobResources(params: {
    job: Job;
    gates: ReturnType<typeof gateQueries>;
    requiredGates: string[];
    workspacePath: string | undefined;
    attemptSucceeded: boolean | null;
    lastErrorMessage: string | null;
    cleanupOnSuccess: boolean;
    cleanupOnFailure: boolean;
  }): Promise<void> {
    const {
      job,
      gates,
      requiredGates,
      workspacePath,
      attemptSucceeded,
      lastErrorMessage,
      cleanupOnSuccess,
      cleanupOnFailure,
    } = params;

    // Always release gates when job completes (success or failure)
    if (requiredGates.length > 0) {
      const released = await gates.releaseGates(job.id);
      if (released > 0) {
        console.log(`Released ${released} gate(s) for job ${job.id}`);
      }
    }

    const shouldCleanup =
      workspacePath &&
      attemptSucceeded !== null &&
      (attemptSucceeded ? cleanupOnSuccess : cleanupOnFailure);

    if (shouldCleanup && workspacePath) {
      try {
        await fs.rm(workspacePath, { recursive: true, force: true });
        console.log(`Cleaned workspace at ${workspacePath}`);
      } catch (cleanupError) {
        const errMsg =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.warn(`Failed to clean workspace ${workspacePath}: ${errMsg}`);
      }
    }

    // Sync parent pipeline run status when a job reaches a terminal state
    if (job.run_id && attemptSucceeded !== null) {
      await this.syncPipelineRunStatus(job.run_id);
    }

    // Sync ingest record status when a triggered job completes
    if (attemptSucceeded !== null) {
      await this.syncIngestRecordStatus(job, attemptSucceeded, lastErrorMessage);
    }

    // Close workflow root when all children reach terminal state
    if (attemptSucceeded !== null && job.parent_id) {
      await this.tryCloseWorkflowRoot(job.parent_id);
    }
  }

  /**
   * Error path of processJob: mark both the attempt and the job as failed
   * after an unexpected execution error, emitting failure events and staged
   * cleanup. Returns the attempt outcome consumed by processJob's finally
   * block (the attempt may already have been finalized externally, in which
   * case the job's terminal phase determines the outcome).
   */
  private async handleProcessJobError(
    job: Job,
    attempt: JobAttempt,
    jobs: ReturnType<typeof jobQueries>,
    error: unknown,
  ): Promise<{ attemptSucceeded: boolean | null; lastErrorMessage: string | null }> {
    let attemptSucceeded: boolean | null = null;
    let lastErrorMessage: string | null = null;

    console.error(`Error processing job ${job.id}:`, error);
    const errMsg = error instanceof Error ? error.message : String(error);

    // Ensure the attempt is marked as failed (it may still be in 'running' state)
    try {
      const completedAttempt = await jobs.completeAttempt(attempt.id, 'failed', {
        exitCode: 1,
        errorMessage: errMsg,
      });
      if (!completedAttempt) {
        // Attempt already finalized by another path — still transition the job.
        const currentJob = await jobs.findById(job.id);
        if (currentJob && (currentJob.phase === 'done' || currentJob.phase === 'cancelled')) {
          attemptSucceeded = currentJob.phase === 'done';
          console.log(
            `Job ${job.id} already in terminal phase '${currentJob.phase}' after external finalization (error path)`,
          );
          return { attemptSucceeded, lastErrorMessage };
        }
        console.warn(
          `Attempt ${attempt.id} for job ${job.id} already finalized; still transitioning job phase`,
        );
      } else {
        console.log(`Marked attempt ${attempt.id} as failed due to error`);
        await this.tryPersistAttemptReceipt(job, completedAttempt);
        await this.tryChargeForReceipt(job, completedAttempt);
      }
    } catch (attemptError) {
      // Log but don't throw - we still want to mark the job as failed
      console.error(`Failed to mark attempt ${attempt.id} as failed:`, attemptError);
    }

    await jobs.markJobFailed(job.id, errMsg);
    await this.emitJobFailureEvent(job, attempt, {
      errorMessage: errMsg,
      errorCode: 'orchestrator_error',
      exitCode: 1,
    });
    await this.emitJobAttemptCompletedEvent(job, attempt, {
      status: 'failed',
    });

    // Staged cleanup: cancel backlog children on orchestrator error
    await this.cancelStagedBacklogChildren(job, 'Parent failed (orchestrator error)');

    lastErrorMessage = errMsg;
    attemptSucceeded = false;
    return { attemptSucceeded, lastErrorMessage };
  }

  /**
   * Step 5a of processJob: enrich workflow step jobs with prior step results.
   * Returns the job description, appending completed dependency results for
   * workflow steps (best-effort — enrichment failures fall back to the plain
   * description).
   */
  private async enrichWorkflowStep(
    job: Job,
    jobs: ReturnType<typeof jobQueries>,
  ): Promise<string> {
    let enrichedDescription = job.description ?? '';
    if (job.hints?.workflow_name) {
      try {
        const deps = await jobs.getDependencies(job.id);
        const priorResults: string[] = [];
        for (const dep of deps) {
          if (dep.phase === 'done') {
            const depAttempt = await jobs.getLatestAttempt(dep.id);
            if (depAttempt?.result_text) {
              const resultText = depAttempt.result_text.length > 50_000
                ? depAttempt.result_text.slice(0, 50_000) + '\n\n[truncated — result exceeded 50KB]'
                : depAttempt.result_text;
              const stepName = dep.hints?.step_name ?? dep.id;
              priorResults.push(`### Step: ${stepName} (${dep.id})\n\n${resultText}`);
            }
          }
        }
        if (priorResults.length > 0) {
          enrichedDescription += '\n\n---\n## Prior Step Results\n\n' + priorResults.join('\n\n---\n\n');
        }
      } catch (err) {
        console.warn(`Failed to enrich prior step results for ${job.id}:`, err);
      }
    }
    return enrichedDescription;
  }

  /**
   * Steps 6b-8 of processJob: persist receipts and charges, relay the summary
   * to the coordination thread, handle staged-council promotion, and update
   * the job phase from the worker result (waiting / success / failure with
   * retry policy). Returns the attempt outcome consumed by processJob's
   * finally block.
   */
  private async finalizeJobResult(
    job: Job,
    attempt: JobAttempt,
    jobs: ReturnType<typeof jobQueries>,
    completed: Extract<JobDispatchOutcome, { kind: 'completed' }>,
  ): Promise<{ attemptSucceeded: boolean | null; lastErrorMessage: string | null }> {
    const { result, eveControl, outcome, completedAttempt } = completed;
    let attemptSucceeded: boolean | null = null;
    let lastErrorMessage: string | null = null;

    await this.tryPersistAttemptReceipt(job, completedAttempt);
    await this.tryChargeForReceipt(job, completedAttempt);

    await this.updatePipelineStepOutputs(job, result.resultJson);

    // Step 6b: Relay summary to coordination thread (if parent has one)
    await this.relayToCoordinationThread(job, eveControl.summary, attempt.id);

    // Step 7: Staged council — lead signals "prepared" → promote backlog children
    if (
      outcome === 'prepared' &&
      (job.hints as Record<string, unknown> | null)?.staged === true
    ) {
      const promoted = await this.db<{ id: string }[]>`
        UPDATE jobs
        SET phase = 'ready', updated_at = NOW()
        WHERE parent_id = ${job.id}
          AND phase = 'backlog'
        RETURNING id
      `;
      console.log(`Staged dispatch: promoted ${promoted.length} children for job ${job.id}`);

      const currentHints = (job.hints ?? {}) as Record<string, unknown>;
      if (promoted.length === 0) {
        // No children to wait on — requeue lead immediately
        await this.db`
          UPDATE jobs
          SET hints = ${this.db.json({ ...currentHints, staged: false } as never)}, updated_at = NOW()
          WHERE id = ${job.id}
        `;
        await jobs.requeueReady(job.id, 'orchestrator', {
          reason: 'Staged dispatch fallback: no children to run',
        });
      } else {
        // Requeue lead with children.all_done wake condition
        await this.db`
          UPDATE jobs SET
            hints = ${this.db.json({
              ...currentHints,
              staged: false,
              wait: { wake_on: ['children.all_done'] },
            } as never)},
            updated_at = NOW()
          WHERE id = ${job.id}
        `;
        await jobs.requeueReady(job.id, 'orchestrator', {
          reason: 'Staged dispatch: waiting for members',
        });
      }

      attemptSucceeded = true;
      return { attemptSucceeded, lastErrorMessage };
    }

    // Step 8: Update job status based on result
    if (outcome === 'waiting') {
      // Store wake_on in job hints if present
      if (eveControl.wakeOn && eveControl.wakeOn.length > 0) {
        const currentHints = job.hints ?? {};
        await this.db`
          UPDATE jobs SET
            hints = ${this.db.json({ ...currentHints, wait: { wake_on: eveControl.wakeOn } } as never)},
            updated_at = NOW()
          WHERE id = ${job.id}
        `;
        console.log(`Stored wake_on [${eveControl.wakeOn.join(', ')}] for job ${job.id}`);
      }

      const isBlocked = await jobs.isBlocked(job.id);
      const deferUntil = computeWaitingDeferUntil(isBlocked);
      const requeueOptions = { reason: 'Worker requested waiting' } as {
        reason: string;
        deferUntil?: Date | null;
      };

      if (!isBlocked) {
        console.warn(
          `Job ${job.id} requested waiting without blockers; deferring for ${WAITING_BACKOFF_MS}ms`,
        );
        requeueOptions.deferUntil = deferUntil;
      }

      await jobs.requeueReady(job.id, 'orchestrator', requeueOptions);
      console.log(`Requeued job ${job.id} to ready`);
      attemptSucceeded = true;
      return { attemptSucceeded, lastErrorMessage };
    }

    if (outcome === 'success') {
      console.log(`Worker succeeded for job ${job.id}`);

      // Promote resolved git metadata from attempt to job
      const latestAttempt = await jobs.getLatestAttempt(job.id);
      if (latestAttempt?.git_json) {
        await jobs.updateResolvedGit(job.id, latestAttempt.git_json);
      }

      await jobs.markJobDone(job.id);
      console.log(`Marked job ${job.id} as done`);
      attemptSucceeded = true;

      // Emit completion event for post-session review (learning loop)
      await this.emitJobAttemptCompletedEvent(job, attempt, {
        status: 'succeeded',
        durationMs: result.durationMs,
      });

      // Staged cleanup: if lead completed without "prepared", cancel backlog children
      await this.cancelStagedBacklogChildren(job, 'Parent completed without promotion');

      // Deliver result to chat thread if this was a chat-originated job
      void this.deliverChatResult(job, result);
    } else {
      console.log(`Worker failed for job ${job.id}: ${result.error}`);

      // Check retry policy before marking as permanently failed
      const retryPolicy = (job.hints as Record<string, any>)?.retry;
      const maxAttempts = retryPolicy?.max_attempts ?? 1;
      const currentAttempt = attempt.attempt_number;

      if (retryPolicy && currentAttempt < maxAttempts) {
        const retryableErrors = retryPolicy?.retryable_errors as string[] | undefined;
        const errorCode = `${job.execution_type ?? 'agent'}_failed`;
        const isRetryable = !retryableErrors || retryableErrors.includes(errorCode)
          || (retryableErrors.includes('attempt_timeout') && errorCode.includes('timeout'))
          || (retryableErrors.includes('attempt_stale') && errorCode.includes('stale'));

        if (isRetryable) {
          const backoffBase = retryPolicy?.backoff_seconds ?? 60;
          const multiplier = retryPolicy?.backoff_multiplier ?? 2;
          const delaySec = backoffBase * Math.pow(multiplier, currentAttempt - 1);
          const deferUntil = new Date(Date.now() + delaySec * 1000);

          console.log(
            `Job ${job.id}: scheduling auto-retry #${currentAttempt + 1}/${maxAttempts} in ${delaySec}s`,
          );

          // Requeue the job for retry with backoff
          await jobs.requeueReady(job.id, 'orchestrator', {
            reason: `Auto-retry #${currentAttempt + 1} after ${result.error ?? 'failure'} (backoff: ${delaySec}s)`,
            deferUntil,
          });

          lastErrorMessage = result.error ?? 'Worker failed';
          attemptSucceeded = false;
          return { attemptSucceeded, lastErrorMessage }; // Don't mark job as failed yet
        }
      }

      // Max retries exhausted or non-retryable error
      await jobs.markJobFailed(job.id, result.error);
      await this.emitJobFailureEvent(job, attempt, {
        errorMessage: result.error ?? 'Worker failed',
        errorCode: `${job.execution_type ?? 'agent'}_failed`,
        exitCode: result.exitCode,
      });
      await this.emitJobAttemptCompletedEvent(job, attempt, {
        status: 'failed',
        durationMs: result.durationMs,
      });
      console.log(`Marked job ${job.id} as failed (retries exhausted or non-retryable)`);

      // Staged cleanup: cancel backlog children on lead failure
      await this.cancelStagedBacklogChildren(job, 'Parent failed without promotion');

      lastErrorMessage = result.error ?? 'Worker failed';
      attemptSucceeded = false;
    }

    return { attemptSucceeded, lastErrorMessage };
  }

  /**
   * Steps 5b + 6 of processJob: execute the claimed job (worker action/script,
   * or harness invocation routed to the agent runtime when
   * EVE_AGENT_RUNTIME_URL is set) and complete its attempt with the result
   * data. See JobDispatchOutcome for the two ways this can resolve.
   */
  private async dispatchAndAwait(
    job: Job,
    attempt: JobAttempt,
    jobs: ReturnType<typeof jobQueries>,
    context: { projectId: string; workspacePath: string; enrichedDescription: string },
  ): Promise<JobDispatchOutcome> {
    const { projectId, workspacePath, enrichedDescription } = context;
    let attemptSucceeded: boolean | null = null;
    let lastErrorMessage: string | null = null;

    // Step 5b: Execute worker
    console.log(`Executing worker for job ${job.id}, attempt ${attempt.id}`);

    const project = await projectQueries(this.db).findById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found for job ${job.id}`);
    }

    const executionType = job.execution_type ?? 'agent';
    const workerImage = await this.resolveWorkerImage(job);

    const jobTimeoutMs = resolveWorkerPollTimeoutMs(job, executionType);

    let result: HarnessResult;

    if (executionType === 'action') {
      result = await this.workerService.executeAction(job.id, attempt.id as AttemptId, projectId, {
        workerImage,
        timeoutMs: jobTimeoutMs,
      });
    } else if (executionType === 'script') {
      result = await this.workerService.executeScript(job.id, attempt.id as AttemptId, projectId, {
        workerImage,
        timeoutMs: jobTimeoutMs,
      });
    } else {
      // NOTE: New Jobs system uses 'title' and 'description' instead of 'text'
      // Worker execution needs adaptation for the new job format
      const routing = await this.selectHarnessAndRoute(job, attempt, executionType);
      const invocation = await this.buildInvocation(
        job,
        attempt,
        project,
        projectId,
        workspacePath,
        enrichedDescription,
        routing,
      );

      if (process.env.EVE_AGENT_RUNTIME_URL) {
        result = await this.workerService.executeAgentRuntime(invocation, {
          workerImage,
          timeoutMs: jobTimeoutMs,
        });
      } else {
        result = await this.workerService.execute(invocation, {
          workerImage,
          timeoutMs: jobTimeoutMs,
        });
      }
    }

    const eveControl = extractEveControl(result.resultJson);
    const outcome = resolveOrchestrationOutcome(result, eveControl.status);

    if (eveControl.status && outcome !== (result.success ? 'success' : 'failed')) {
      console.warn(
        `Worker status override for job ${job.id}: ${result.success ? 'success' : 'failed'} -> ${outcome}`,
      );
    }

    // Step 6: Complete the attempt with result data from worker
    const attemptStatus = outcome === 'failed' ? 'failed' : 'succeeded';
    const completedAttempt = await jobs.completeAttempt(
      attempt.id,
      attemptStatus,
      {
        exitCode: result.exitCode,
        resultText: result.resultText,
        resultJson: result.resultJson,
        resultSummary: eveControl.summary,
        durationMs: result.durationMs,
        tokenInput: result.tokenInput,
        tokenOutput: result.tokenOutput,
        errorMessage: result.error,
      },
    );
    if (!completedAttempt) {
      // Attempt was finalized by another path (e.g., pod shutdown drain).
      // We MUST still transition the job phase — leaving it 'active' permanently
      // is the root cause of stuck jobs after agent-runtime pod restarts.
      const latestAttempt = await jobs.getLatestAttempt(job.id);
      const currentJob = await jobs.findById(job.id);

      if (currentJob && (currentJob.phase === 'done' || currentJob.phase === 'cancelled')) {
        attemptSucceeded = currentJob.phase === 'done';
        console.log(
          `Job ${job.id} already in terminal phase '${currentJob.phase}' after external finalization`,
        );
        return { kind: 'externally_finalized', attemptSucceeded, lastErrorMessage };
      }

      const externalError = latestAttempt?.error_message ?? result.error ?? 'Attempt terminated externally';
      console.warn(
        `Attempt ${attempt.id} for job ${job.id} was externally finalized (status=${latestAttempt?.status}); recovering job phase`,
      );

      if (latestAttempt?.status === 'succeeded') {
        await jobs.markJobDone(job.id);
        attemptSucceeded = true;
      } else {
        await jobs.markJobFailed(job.id, externalError);
        await this.emitJobFailureEvent(job, attempt, {
          errorMessage: externalError,
          errorCode: 'pod_terminated',
          exitCode: latestAttempt?.exit_code ?? 1,
        });
        attemptSucceeded = false;
        lastErrorMessage = externalError;
      }

      return { kind: 'externally_finalized', attemptSucceeded, lastErrorMessage };
    }
    console.log(`Completed attempt ${attempt.id} with exit code ${result.exitCode}`);

    return { kind: 'completed', result, eveControl, outcome, completedAttempt };
  }

  /**
   * Step 5b of processJob (agent jobs): select the harness for this attempt
   * and persist the routing decision (agent-runtime vs worker target, harness
   * source, profile attribution) as an execution log for diagnostics.
   */
  private async selectHarnessAndRoute(
    job: Job,
    attempt: JobAttempt,
    executionType: string,
  ): Promise<{ harnessSpec: string; profileHash: string | null; profileSource: string | null }> {
    const manifestDefaults = await this.getManifestDefaults(job.project_id);
    const systemPreference = await this.getSystemHarnessPreference();

    // Resolve secrets from all scopes (system -> org -> project -> user) for harness selection
    const resolvedSecrets = await this.resolveSecretsForHarnessSelection(job.project_id);

    const selection = selectAvailableHarness({
      explicit: attempt.harness ?? job.harness ?? undefined,
      projectPreference: manifestDefaults?.harness_preference as string[] | undefined,
      systemPreference,
      env: resolvedSecrets,
    });

    const harnessSpec = selection.harness;
    console.log(
      `Harness: ${selection.harness} (source: ${selection.source}, checked: ${selection.checked.join(', ')})`
    );

    // F4: Persist routing decision as execution log for diagnostics.
    // Includes per-job harness profile attribution (plan §3.6) so analytics
    // can group cost by inline_override vs agent_default without reading
    // the job row. Never include plaintext secrets — we only log the
    // stable hash over the normalized inputs.
    const profileHash = (job as { harness_profile_hash?: string | null }).harness_profile_hash ?? null;
    const profileSource = (job as { harness_profile_source?: string | null }).harness_profile_source ?? null;
    executionLogQueries(this.db).appendLog(attempt.id, 'routing', {
      execution_type: executionType,
      target: process.env.EVE_AGENT_RUNTIME_URL ? 'agent-runtime' : 'worker',
      harness: selection.harness,
      harness_source: selection.source,
      harness_checked: selection.checked,
      harness_profile_name: job.harness_profile ?? null,
      harness_profile_source: profileSource,
      harness_profile_hash: profileHash,
      effective_harness: selection.harness,
      effective_model: (job.harness_options as { model?: string } | null)?.model ?? null,
      effective_effort: (job.harness_options as { reasoning_effort?: string } | null)?.reasoning_effort ?? null,
      agent_id: attempt.agent_id,
      budget: {
        max_tokens: (job.hints as Record<string, unknown>)?.max_tokens,
        max_cost: (job.hints as Record<string, unknown>)?.max_cost,
      },
    }).catch(err => console.warn(`Failed to log routing decision: ${err}`));

    return { harnessSpec, profileHash, profileSource };
  }

  /**
   * Step 5b of processJob (agent jobs): assemble the harness invocation from
   * the job, attempt, project, and routing decision. The invocation carries
   * org-fs mount context, job scope/permissions, toolchains, and env override
   * placeholders resolved later by the shared invoke module.
   */
  private async buildInvocation(
    job: Job,
    attempt: JobAttempt,
    project: Project,
    projectId: string,
    workspacePath: string,
    enrichedDescription: string,
    routing: { harnessSpec: string; profileHash: string | null; profileSource: string | null },
  ) {
    const { harnessSpec, profileHash, profileSource } = routing;

    const { harness, variant: parsedVariant } = parseHarnessSpec(harnessSpec);
    const harnessOptions = job.harness_options ?? undefined;
    const variant = harnessOptions?.variant ?? parsedVariant;

    // Extract permission policy from job hints
    const permission = job.hints?.permission_policy as
      | 'default'
      | 'auto_edit'
      | 'never'
      | 'yolo'
      | undefined;

    // Extract git and workspace configuration from job
    const git: JobGitConfig | undefined = job.git_json ?? undefined;
    const workspace: JobWorkspaceConfig | undefined = job.workspace_json ?? undefined;
    const { orgFsMount, tokenScope } = await this.resolveJobScope(job, project.org_id);
    const invocationData: Record<string, unknown> = {
      orgfs_mount: orgFsMount,
    };
    if (tokenScope) {
      invocationData.__eve_job_scope = tokenScope;
    }
    if (Array.isArray(job.token_permissions) && job.token_permissions.length > 0) {
      invocationData.__eve_job_permissions = job.token_permissions;
    }
    if (job.actor_user_id) {
      invocationData.user_id = job.actor_user_id;
    }
    if (typeof job.hints?.skill_mode === 'string') {
      invocationData.skill_mode = job.hints.skill_mode;
    }
    // Forward chat file attachments from job hints
    if (Array.isArray(job.hints?.chat_files) && job.hints.chat_files.length > 0) {
      invocationData.chat_files = job.hints.chat_files;
    }

    // Resolve toolchains from job hints
    const toolchains = Array.isArray(job.hints?.toolchains) ? job.hints.toolchains as string[] : [];

    // Env overrides travel with the invocation in placeholder form; the
    // shared invoke module resolves ${secret.KEY} against the materialized
    // project secrets at spawn time (never here, never on the API).
    const envOverrides =
      (job as { env_overrides?: Record<string, string> | null }).env_overrides ?? undefined;

    const invocation = {
      attemptId: attempt.id as AttemptId,
      agentId: attempt.agent_id,
      jobId: job.id as JobId,
      parentJobId: job.parent_id ?? null,
      projectId: projectId as ProjectId,
      text: job.title + (enrichedDescription ? '\n\n' + enrichedDescription : ''),
      workspacePath,
      repoUrl: project.repo_url,
      repoBranch: project.branch,
      skillPacks: null, // New Jobs system doesn't have skill_packs on job
      data: invocationData,
      harness,
      variant,
      harness_options: harnessOptions ?? undefined,
      permission,
      resource_refs: (job.resource_refs ?? []) as ResourceRef[],
      git,
      workspace,
      ...(toolchains.length > 0 ? { toolchains } : {}),
      ...(envOverrides && Object.keys(envOverrides).length > 0 ? { env_overrides: envOverrides } : {}),
      ...(profileSource ? { harness_profile_source: profileSource as HarnessProfileSource } : {}),
      ...(profileHash ? { harness_profile_hash: profileHash } : {}),
      ...(job.harness_profile ? { harness_profile_name: job.harness_profile } : {}),
    };

    return invocation;
  }

  /**
   * Step 4 of processJob: resolve the per-attempt workspace directory path.
   */
  private resolveWorkspacePath(job: Job, attempt: JobAttempt): string {
    // Job ID format: slug-hash or slug-hash.1.2
    const jobIdParts = job.id.split('-');
    const projectSlug = jobIdParts[0];
    return path.join(
      this.config.WORKSPACE_ROOT,
      projectSlug,
      job.id,
      attempt.attempt_number.toString(),
    );
  }

  /**
   * Step 4 of processJob: create the workspace directory for the attempt.
   */
  private async prepareJobWorkspace(workspacePath: string): Promise<void> {
    await fs.mkdir(workspacePath, { recursive: true });
    console.log(`Workspace at ${workspacePath}`);
  }

  /**
   * Step 1b of processJob: acquire required gates for a claimed job.
   *
   * Returns 'blocked' when the gates are held elsewhere — the attempt has been
   * failed with a gate-specific message and the job requeued with a short defer,
   * so the caller must stop processing this job. Returns 'acquired' when all
   * required gates are held (or none are required).
   */
  private async acquireJobGates(
    job: Job,
    attempt: JobAttempt,
    jobs: ReturnType<typeof jobQueries>,
    gates: ReturnType<typeof gateQueries>,
    requiredGates: string[],
  ): Promise<'acquired' | 'blocked'> {
    if (requiredGates.length > 0) {
      const ttlSeconds = Math.ceil(
        resolveWorkerPollTimeoutMs(job, job.execution_type ?? 'agent') / 1000,
      );
      const gateResult = await gates.acquireGates(job.id, requiredGates, ttlSeconds, {
        orchestrator: true,
        env_name: job.env_name,
      });

      if (!gateResult.success) {
        // Gates blocked - update blocked_on_gates and release job back to ready
        await gates.updateBlockedOnGates(job.id, gateResult.blocked_by);

        // Build descriptive message about which gates are blocked
        const envGateBlocked = gateResult.blocked_by.some(g => g.startsWith('env:'));
        const branchGateBlocked = gateResult.blocked_by.some(g => g.startsWith('git:branch:'));
        let logMsg: string;
        if (envGateBlocked) {
          logMsg = `Job ${job.id} blocked on environment gate (another job is deploying to ${job.env_name}): ${gateResult.blocked_by.join(', ')}`;
        } else if (branchGateBlocked) {
          logMsg = `Job ${job.id} blocked on branch gate (another job is writing to the same branch): ${gateResult.blocked_by.join(', ')}`;
        } else {
          logMsg = `Job ${job.id} blocked on gates: ${gateResult.blocked_by.join(', ')}`;
        }
        console.log(logMsg);

        // Mark the attempt as failed with a gate-specific message
        await jobs.completeAttempt(attempt.id, 'failed', {
          exitCode: 0,
          errorMessage: `Blocked on gates: ${gateResult.blocked_by.join(', ')}`,
        });

        // Requeue with a short defer to prevent a hot-loop of rapid
        // claim/fail/requeue cycles while the gate remains occupied.
        await jobs.requeueReady(job.id, 'orchestrator', {
          reason: 'Blocked on gates',
          deferUntil: new Date(Date.now() + WAITING_BACKOFF_MS),
        });
        return 'blocked';
      }

      // Gates acquired - clear any previous blocked_on_gates
      await gates.clearBlockedOnGates(job.id);

      // Log which gates were acquired, highlighting environment and branch gates
      const gatesList = requiredGates.map(g => {
        if (g.startsWith('env:')) return `${g} (environment lock)`;
        if (g.startsWith('git:branch:')) return `${g} (branch lock)`;
        return g;
      }).join(', ');
      console.log(`Acquired gates for job ${job.id}: ${gatesList}`);
    }
    return 'acquired';
  }

  /**
   * Close a workflow root job when all its children have reached a terminal state.
   * A workflow root is identified by hints.workflow_root === true.
   * Superseded retry attempts are ignored; only the current step generation
   * participates in final workflow status.
   */
  private async tryCloseWorkflowRoot(parentId: string): Promise<void> {
    try {
      const jobs = jobQueries(this.db);
      const parent = await jobs.findById(parentId);
      if (!parent) return;

      // Only close workflow roots (not generic parent jobs like staged dispatch leads)
      const hints = parent.hints as Record<string, unknown> | null;
      if (!hints?.workflow_root) return;

      // Already terminal — nothing to do
      if (parent.phase === 'done' || parent.phase === 'cancelled') return;

      // Check if all children are in terminal state
      const counts = await this.db<{ total: string; terminal: string; succeeded: string; failed: string }[]>`
        SELECT
          count(*) as total,
          count(*) FILTER (WHERE phase IN ('done', 'cancelled')) as terminal,
          count(*) FILTER (WHERE phase = 'done') as succeeded,
          count(*) FILTER (WHERE phase = 'cancelled') as failed
        FROM jobs
        WHERE parent_id = ${parentId}
          AND NOT (COALESCE(hints, '{}'::jsonb) ? 'workflow_retry_superseded_by')
      `;
      const total = parseInt(counts[0]?.total ?? '0', 10);
      const terminal = parseInt(counts[0]?.terminal ?? '0', 10);
      const succeeded = parseInt(counts[0]?.succeeded ?? '0', 10);
      const failed = parseInt(counts[0]?.failed ?? '0', 10);

      if (total === 0 || total !== terminal) return;

      // All children are terminal — close the root
      const allSucceeded = failed === 0 && succeeded === total;
      if (allSucceeded) {
        await jobs.markJobDone(parentId);
        console.log(`Closed workflow root ${parentId} as done (${succeeded}/${total} current steps succeeded)`);
      } else {
        await jobs.cancelJob(parentId, `Workflow failed: ${succeeded}/${total} current steps succeeded`);
        console.log(`Closed workflow root ${parentId} as cancelled (${succeeded}/${total} current steps succeeded)`);
      }

      // Sync ingest record and fire callback now that the workflow is truly complete
      await this.syncIngestRecordStatus(parent, allSucceeded,
        allSucceeded ? null : `Workflow failed (${succeeded}/${total} current steps succeeded)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to close workflow root ${parentId}: ${msg}`);
    }
  }

  /**
   * Sweep for zombie workflow root jobs — active roots where all children are terminal.
   * Defense-in-depth: catches roots missed by point-of-completion hooks (API cancellation,
   * external timeout, partial step creation failures, etc.).
   */
  private async sweepZombieWorkflowRoots(): Promise<void> {
    try {
      const zombies = await this.db<{ id: string; total: string; succeeded: string; failed: string }[]>`
        SELECT
          r.id,
          count(c.id) as total,
          count(c.id) FILTER (WHERE c.phase = 'done') as succeeded,
          count(c.id) FILTER (WHERE c.phase = 'cancelled') as failed
        FROM jobs r
        JOIN jobs c ON c.parent_id = r.id
        WHERE r.phase = 'active'
          AND (r.hints->>'workflow_root')::boolean = true
          AND NOT (COALESCE(c.hints, '{}'::jsonb) ? 'workflow_retry_superseded_by')
        GROUP BY r.id
        HAVING count(c.id) = count(c.id) FILTER (WHERE c.phase IN ('done', 'cancelled'))
      `;

      if (zombies.length === 0) return;

      const jobs = jobQueries(this.db);
      for (const zombie of zombies) {
        const succeeded = parseInt(zombie.succeeded, 10);
        const failed = parseInt(zombie.failed, 10);
        const total = parseInt(zombie.total, 10);
        const allSucceeded = failed === 0 && succeeded === total;
        if (allSucceeded) {
          await jobs.markJobDone(zombie.id);
          console.log(`Sweep: closed zombie workflow root ${zombie.id} as done (${succeeded}/${zombie.total} current steps succeeded)`);
        } else {
          await jobs.cancelJob(zombie.id, `Workflow failed: ${succeeded}/${zombie.total} current steps succeeded`);
          console.log(`Sweep: closed zombie workflow root ${zombie.id} as cancelled (${succeeded}/${zombie.total} current steps succeeded)`);
        }

        // Sync ingest record and fire callback for zombified workflow roots
        const root = await jobs.findById(zombie.id);
        if (root) {
          await this.syncIngestRecordStatus(root, allSucceeded,
            allSucceeded ? null : `Workflow failed (${succeeded}/${zombie.total} current steps succeeded)`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Zombie workflow root sweep failed: ${msg}`);
    }
  }

  /**
   * Emit `system.job.attempt.completed` for both success and failure.
   * Enables event-driven post-session review (learning loop, observability).
   */
  private async emitJobAttemptCompletedEvent(
    job: {
      id: string;
      project_id: string;
      execution_type: string | null;
      assignee: string | null;
      hints?: Record<string, unknown> | null;
    },
    attempt: { id: string; attempt_number?: number },
    outcome: { status: 'succeeded' | 'failed'; durationMs?: number | null },
  ): Promise<void> {
    try {
      const events = eventQueries(this.db);
      const threadId = (job.hints as Record<string, unknown> | null)
        ?.coordination as { thread_id?: string } | undefined;
      await events.create({
        id: generateEventId(),
        project_id: job.project_id,
        type: 'system.job.attempt.completed',
        source: 'system',
        env_name: null,
        ref_sha: typeof job.hints?.git_sha === 'string' ? job.hints.git_sha : null,
        ref_branch: null,
        actor_type: 'system',
        actor_id: 'orchestrator',
        payload_json: {
          job_id: job.id,
          attempt_id: attempt.id,
          assignee: job.assignee,
          thread_id: threadId?.thread_id ?? null,
          execution_type: job.execution_type,
          status: outcome.status,
          duration_ms: outcome.durationMs ?? null,
        },
        dedupe_key: `job_attempt_completed:${job.id}:${attempt.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to emit job.attempt.completed event for ${job.id}: ${message}`);
    }
  }

  private async emitJobFailureEvent(
    job: {
      id: string;
      project_id: string;
      run_id: string | null;
      step_name: string | null;
      execution_type: string | null;
      action_type: string | null;
      hints?: Record<string, unknown> | null;
    },
    attempt: { id: string },
    details: { errorMessage: string; errorCode: string; exitCode?: number | null },
  ): Promise<void> {
    try {
      const events = eventQueries(this.db);
      const refSha = typeof job.hints?.git_sha === 'string' ? job.hints.git_sha : null;
      await events.create({
        id: generateEventId(),
        project_id: job.project_id,
        type: 'system.job.failed',
        source: 'system',
        env_name: null,
        ref_sha: refSha,
        ref_branch: null,
        actor_type: 'system',
        actor_id: 'orchestrator',
        payload_json: {
          job_id: job.id,
          attempt_id: attempt.id,
          run_id: job.run_id,
          step_name: job.step_name,
          execution_type: job.execution_type,
          action_type: job.action_type,
          pipeline_name: job.hints?.pipeline_name as string
            ?? (job as { labels?: string[] }).labels
              ?.find((l: string) => l.startsWith('pipeline:'))?.slice('pipeline:'.length)
            ?? null,
          error_message: details.errorMessage,
          error_code: details.errorCode,
          exit_code: details.exitCode ?? null,
        },
        dedupe_key: `job_failed:${job.id}:${attempt.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to emit job failure event for ${job.id}: ${message}`);
    }
  }

  /**
   * Post a job's eve.summary to its parent's coordination thread (if one exists).
   * This is the "end-of-attempt relay" — agents in a team dispatch automatically
   * share their summaries with siblings via the coordination thread.
   */
  private async relayToCoordinationThread(
    job: { id: string; parent_id: string | null; project_id: string; assignee: string | null },
    summary: string | undefined,
    attemptId: string,
  ): Promise<void> {
    if (!job.parent_id || !summary) return;

    try {
      const jobs = jobQueries(this.db);
      const parentJob = await jobs.findById(job.parent_id);
      if (!parentJob) return;

      const coordThreadId = (parentJob.hints as Record<string, unknown> | null)
        ?.coordination as { thread_id?: string } | undefined;
      if (!coordThreadId?.thread_id) return;

      const messages = threadMessageQueries(this.db);
      const crypto = await import('crypto');
      await messages.create({
        id: crypto.randomUUID(),
        thread_id: coordThreadId.thread_id,
        direction: 'outbound',
        actor_type: 'agent',
        actor_id: job.assignee,
        body: JSON.stringify({
          kind: 'status',
          body: summary,
          refs: { job_id: job.id, attempt_id: attemptId },
        }),
        job_id: job.id,
      });

      console.log(`Relayed summary from job ${job.id} to coordination thread ${coordThreadId.thread_id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to relay to coordination thread for job ${job.id}: ${message}`);
    }
  }

  /**
   * Cancel backlog children of a staged council lead when it completes
   * without returning "prepared" (solo path, failure, or timeout).
   *
   * After the "prepared" handler runs, hints.staged is cleared to false,
   * so this is a no-op for the synthesis phase (second attempt).
   */
  private async cancelStagedBacklogChildren(
    job: { id: string; hints: Record<string, unknown> | null },
    reason: string,
  ): Promise<void> {
    if ((job.hints as Record<string, unknown> | null)?.staged !== true) return;

    try {
      const cancelled = await this.db<{ id: string }[]>`
        UPDATE jobs
        SET phase = 'cancelled', updated_at = NOW(), close_reason = ${reason}
        WHERE parent_id = ${job.id} AND phase = 'backlog'
        RETURNING id
      `;
      if (cancelled.length > 0) {
        console.log(`Staged cleanup: cancelled ${cancelled.length} backlog children for job ${job.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to cancel staged backlog children for job ${job.id}: ${message}`);
    }
  }

  /**
   * Deliver a completed job's result to the originating chat thread.
   * Only fires for jobs with the "chat" label and a thread_id hint.
   * Runs fire-and-forget — delivery failure must not block job completion.
   */
  private async deliverChatResult(
    job: { id: string; project_id: string; labels: string[] | null; hints: Record<string, unknown> | null; assignee: string | null },
    result: HarnessResult | undefined,
  ): Promise<void> {
    const labels = job.labels ?? [];
    if (!labels.includes('chat')) return;

    const threadId = (job.hints as Record<string, unknown>)?.thread_id as string | undefined;
    if (!threadId) return;

    // Extract result text from the harness result
    const eveControl = extractEveControl(result?.resultJson);
    let text =
      result?.resultText?.trim() ||
      eveControl.summary ||
      'Job completed with no output.';

    // Truncate for Slack (text field supports 40k; leave room for suffix)
    if (text.length > 39_000) {
      text = text.slice(0, 39_000) + `\n\n[Truncated — full result: \`eve job result ${job.id}\`]`;
    }

    try {
      const url = `${this.config.EVE_API_URL}/internal/projects/${job.project_id}/chat/deliver`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': this.config.EVE_INTERNAL_API_KEY ?? '',
        },
        body: JSON.stringify({
          job_id: job.id,
          thread_id: threadId,
          text,
          agent_id: job.assignee ?? undefined,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`Failed to deliver chat result for job ${job.id}: HTTP ${response.status} — ${body}`);
        return;
      }

      console.log(`Delivered chat result for job ${job.id} to thread ${threadId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to deliver chat result for job ${job.id}: ${msg}`);
    }
  }

  /**
   * Check jobs with hints.wait.wake_on and clear deferral if conditions are met.
   * Supported wake_on values:
   *  - "child.done" — any child reached done/cancelled
   *  - "children.all_done" — all children reached done/cancelled
   *  - "thread.message" — new message in coordination thread since deferral
   */
  private async processWakeOnConditions(): Promise<void> {
    try {
      // Find deferred jobs with wake_on hints
      const deferredJobs = await this.db<Array<{
        id: string; hints: Record<string, unknown> | null; defer_until: Date | null;
      }>>`
        SELECT id, hints, defer_until FROM jobs
        WHERE phase = 'ready'
          AND defer_until IS NOT NULL
          AND defer_until > NOW()
          AND hints->'wait'->'wake_on' IS NOT NULL
      `;

      if (deferredJobs.length === 0) return;

      for (const job of deferredJobs) {
        const wait = (job.hints?.wait as { wake_on?: string[] }) ?? {};
        const wakeOn = wait.wake_on ?? [];
        if (wakeOn.length === 0) continue;

        let shouldWake = false;

        for (const condition of wakeOn) {
          if (condition === 'child.done') {
            const terminalChildren = await this.db<{ count: string }[]>`
              SELECT count(*) as count FROM jobs
              WHERE parent_id = ${job.id} AND phase IN ('done', 'cancelled')
            `;
            if (parseInt(terminalChildren[0]?.count ?? '0', 10) > 0) {
              shouldWake = true;
              break;
            }
          } else if (condition === 'children.all_done') {
            const allChildren = await this.db<{ total: string; terminal: string }[]>`
              SELECT
                count(*) as total,
                count(*) FILTER (WHERE phase IN ('done', 'cancelled')) as terminal
              FROM jobs WHERE parent_id = ${job.id}
            `;
            const total = parseInt(allChildren[0]?.total ?? '0', 10);
            const terminal = parseInt(allChildren[0]?.terminal ?? '0', 10);
            if (total > 0 && total === terminal) {
              shouldWake = true;
              break;
            }
          } else if (condition === 'thread.message') {
            const coordination = job.hints?.coordination as { thread_id?: string } | undefined;
            const threadId = coordination?.thread_id;
            if (threadId && job.defer_until) {
              const newMessages = await this.db<{ count: string }[]>`
                SELECT count(*) as count FROM thread_messages
                WHERE thread_id = ${threadId} AND created_at > ${job.defer_until}
              `;
              if (parseInt(newMessages[0]?.count ?? '0', 10) > 0) {
                shouldWake = true;
                break;
              }
            }
          }
        }

        if (shouldWake) {
          await this.db`
            UPDATE jobs SET defer_until = NULL, updated_at = NOW() WHERE id = ${job.id}
          `;
          console.log(`Woke job ${job.id} (wake_on condition met)`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to process wake_on conditions: ${message}`);
    }
  }

  private async updatePipelineStepOutputs(
    job: { run_id: string | null; step_name: string | null },
    resultJson: Record<string, unknown> | null | undefined,
  ): Promise<void> {
    if (!job.run_id || !job.step_name) {
      return;
    }

    if (!resultJson || typeof resultJson !== 'object') {
      return;
    }

    try {
      const pipelineRuns = pipelineRunQueries(this.db);
      await pipelineRuns.setStepOutput(job.run_id, job.step_name, resultJson as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to record pipeline outputs for ${job.run_id}:${job.step_name}: ${message}`);
    }
  }

  private async resolveWorkerImage(job: { project_id: string; env_name: string | null; hints?: Record<string, unknown> | null }): Promise<string | undefined> {
    const hints = job.hints ?? {};
    const hinted = typeof hints.worker_type === 'string' ? hints.worker_type : null;
    const workerType = hinted ?? await this.resolveDefaultWorkerType(job.project_id, job.env_name ?? null);
    if (!workerType) return undefined;

    const mapping = parseWorkerUrlMapping(process.env.EVE_WORKER_URLS ?? '');
    if (mapping.has(workerType)) {
      return workerType;
    }

    console.warn(`Worker type "${workerType}" not mapped in EVE_WORKER_URLS; using default worker`);
    return undefined;
  }

  private async resolveDefaultWorkerType(projectId: string, envName: string | null): Promise<string | null> {
    if (!envName) return null;
    const manifests = projectManifestQueries(this.db);
    const manifest = await manifests.findLatestByProject(projectId);
    if (!manifest) return null;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = yaml.parse(manifest.manifest_yaml) as Record<string, unknown> | null;
    } catch {
      return null;
    }

    const environments = parsed?.environments;
    if (!environments || typeof environments !== 'object') return null;
    const envConfig = (environments as Record<string, unknown>)[envName];
    if (!envConfig || typeof envConfig !== 'object') return null;
    const workers = (envConfig as Record<string, unknown>).workers;
    if (!Array.isArray(workers)) return null;

    const defaultWorker = workers.find((worker) => (worker as Record<string, unknown>)?.default === true)
      ?? workers.find((worker) => (worker as Record<string, unknown>)?.type === 'default')
      ?? workers[0];
    if (!defaultWorker || typeof defaultWorker !== 'object') return null;

    const type = (defaultWorker as Record<string, unknown>).type;
    return typeof type === 'string' && type.length > 0 ? type : null;
  }

  private async copyPipelineOutputToRootJob(
    runId: string,
    pipelineRuns: ReturnType<typeof pipelineRunQueries>,
  ): Promise<void> {
    try {
      // Get the pipeline run with its outputs
      const run = await pipelineRuns.findRunById(runId);
      if (!run || !run.step_outputs_json) {
        return;
      }

      // Find jobs associated with this pipeline run
      const pipelineJobs = await this.db<{ id: string; priority: number; run_id: string | null }[]>`
        SELECT id, priority, run_id
        FROM jobs
        WHERE run_id = ${runId}
        ORDER BY priority ASC
        LIMIT 1
      `;

      if (pipelineJobs.length === 0) {
        return;
      }

      // Use the first job (lowest priority) as the root job
      const rootJobId = pipelineJobs[0].id;
      const jobs = jobQueries(this.db);

      // Get the latest attempt for the root job
      const latestAttempt = await jobs.getLatestAttempt(rootJobId);
      if (!latestAttempt) {
        console.warn(`No attempt found for root job ${rootJobId}, cannot copy pipeline output`);
        return;
      }

      // Merge pipeline output into the attempt's result_json
      await jobs.updateAttemptResultJson(latestAttempt.id, {
        pipeline_output: run.step_outputs_json,
      });

      console.log(`Copied pipeline output to root job ${rootJobId} attempt ${latestAttempt.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to copy pipeline output to root job for run ${runId}: ${message}`);
    }
  }

  /**
   * Synchronise a job-based pipeline run's status from the aggregate state
   * of its child jobs.  Called after every job completion (success or failure).
   *
   * Transition rules:
   *   pending  → running    when the first job reaches a terminal phase
   *   running  → succeeded  when every job is done/cancelled
   *   running  → failed     when any job is cancelled (with a failure reason) or
   *                          failed, and no jobs are still in-flight
   *
   * This is intentionally idempotent — multiple concurrent calls for the same
   * run converge to the same result because the query is a point-in-time
   * snapshot of job phases.
   */
  private async syncPipelineRunStatus(runId: string): Promise<void> {
    try {
      const pipelineRuns = pipelineRunQueries(this.db);
      const run = await pipelineRuns.findRunById(runId);
      if (!run) return;

      // Only manage job-based runs; legacy runs are handled by processPipelineRun
      if (run.run_mode !== 'jobs') return;

      // Already terminal — nothing to do
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return;

      // Query aggregate job status for this run in a single round-trip
      const [counts] = await this.db<{
        total: string;
        done: string;
        cancelled: string;
        failed: string;
        started: string;
      }[]>`
        SELECT
          COUNT(*)::text                                           AS total,
          COUNT(*) FILTER (WHERE phase = 'done')::text             AS done,
          COUNT(*) FILTER (WHERE phase = 'cancelled')::text        AS cancelled,
          COUNT(*) FILTER (WHERE phase = 'cancelled'
            AND close_reason IS NOT NULL
            AND close_reason NOT IN ('cancelled', 'Job cancelled'))::text AS failed
          ,COUNT(*) FILTER (WHERE phase IN ('active', 'review', 'done', 'cancelled'))::text AS started
        FROM jobs
        WHERE run_id = ${runId}
      `;

      if (!counts) return;

      const total = parseInt(counts.total, 10);
      const done = parseInt(counts.done, 10);
      const cancelled = parseInt(counts.cancelled, 10);
      const failed = parseInt(counts.failed, 10);
      const started = parseInt(counts.started, 10);

      if (total === 0) return;

      const terminal = done + cancelled;

      // Mark running as soon as any job starts (active/review/terminal)
      if (run.status === 'pending' && started > 0) {
        await pipelineRuns.updateRun(runId, {
          status: 'running',
          started_at: new Date(),
        });
        console.log(`Pipeline run ${runId}: pending → running (${started}/${total} jobs started)`);
      }

      // All jobs reached a terminal phase — finalise the run
      if (terminal === total) {
        const now = new Date();

        if (failed > 0) {
          // Collect first failure reason for the error_message
          const [failedJob] = await this.db<{ id: string; close_reason: string | null }[]>`
            SELECT id, close_reason FROM jobs
            WHERE run_id = ${runId} AND phase = 'cancelled'
              AND close_reason IS NOT NULL
              AND close_reason NOT IN ('cancelled', 'Job cancelled')
            ORDER BY closed_at ASC NULLS LAST
            LIMIT 1
          `;

          const errMsg = failedJob?.close_reason ?? 'One or more pipeline jobs failed';
          await pipelineRuns.updateRun(runId, {
            status: 'failed',
            started_at: run.started_at ?? now,
            completed_at: now,
            error_message: errMsg,
          });
          console.log(`Pipeline run ${runId}: → failed (${failed} job(s) failed, ${done} succeeded)`);

          // Re-fetch so the failure event has up-to-date fields
          const updatedRun = await pipelineRuns.findRunById(runId);
          if (updatedRun) {
            await this.emitPipelineFailureEvent(updatedRun, errMsg);
          }
        } else {
          await pipelineRuns.updateRun(runId, {
            status: 'succeeded',
            started_at: run.started_at ?? now,
            completed_at: now,
          });
          console.log(`Pipeline run ${runId}: → succeeded (${done}/${total} jobs done)`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to sync pipeline run status for ${runId}: ${message}`);
    }
  }

  /**
   * When a job triggered by a document ingest event completes, update the
   * corresponding ingest record to done/failed and stamp the job_id.
   */
  private async syncIngestRecordStatus(
    job: { id: string; hints?: Record<string, unknown> | null },
    succeeded: boolean,
    errorMessage?: string | null,
  ): Promise<void> {
    try {
      // Skip workflow STEP jobs — only sync from the workflow ROOT or non-workflow jobs.
      // Step jobs have workflow_name but NOT workflow_root. Syncing from steps fires the
      // callback prematurely (e.g., after extract but before synthesis completes).
      const hints = job.hints as Record<string, unknown> | null;
      if (hints?.workflow_name && !hints?.workflow_root) return;

      const requestJson = hints?.request_json;
      if (typeof requestJson !== 'string') return;

      let payload: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(requestJson);
        payload = parsed?.payload;
      } catch {
        return;
      }

      const ingestId = payload?.ingest_id;
      if (typeof ingestId !== 'string') return;

      const ingests = ingestRecordQueries(this.db);
      const record = await ingests.findById(ingestId);
      if (!record || record.status === 'done' || record.status === 'failed') return;

      if (succeeded) {
        await ingests.updateStatus(ingestId, 'done', {
          job_id: job.id,
          completed_at: new Date(),
        });
        console.log(`Ingest ${ingestId}: → done (job ${job.id} succeeded)`);
      } else {
        await ingests.updateStatus(ingestId, 'failed', {
          job_id: job.id,
          completed_at: new Date(),
          error_message: errorMessage ?? 'Processing job failed',
        });
        console.log(`Ingest ${ingestId}: → failed (job ${job.id} failed)`);
      }

      // Fire callback if configured (fire-and-forget)
      if (record.callback_url) {
        void this.fireIngestCallback(record, succeeded ? 'done' : 'failed', job.id, errorMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to sync ingest record status for job ${job.id}: ${message}`);
    }
  }

  /**
   * POST to the callback URL stored on an ingest record when processing
   * completes. Fire-and-forget with retries. Never fails the caller.
   */
  private async fireIngestCallback(
    record: { id: string; callback_url?: string | null; file_name: string; mime_type: string; size_bytes: string | number; storage_key: string },
    status: 'done' | 'failed',
    jobId: string,
    errorMessage?: string | null,
  ): Promise<void> {
    const payload = {
      ingest_id: record.id,
      status,
      job_id: jobId,
      file_name: record.file_name,
      mime_type: record.mime_type,
      size_bytes: Number(record.size_bytes),
      storage_key: record.storage_key,
      completed_at: new Date().toISOString(),
      error_message: errorMessage ?? null,
    };

    const delays = [5000, 15000, 45000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        const resp = await fetch(record.callback_url!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Eve-Event': 'ingest.completed' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          console.log(`Ingest ${record.id}: callback delivered (${resp.status})`);
          return;
        }
        console.warn(`Ingest ${record.id}: callback returned ${resp.status}, attempt ${attempt + 1}/${delays.length}`);
      } catch (err) {
        console.warn(`Ingest ${record.id}: callback failed, attempt ${attempt + 1}/${delays.length}: ${(err as Error).message}`);
      }
      if (attempt < delays.length - 1) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    console.error(`Ingest ${record.id}: callback exhausted all ${delays.length} retries`);
  }

  /**
   * Sweep for job-based pipeline runs stuck in pending/running where all child
   * jobs have reached a terminal phase. This covers cases where the normal
   * per-attempt sync was never triggered (e.g. jobs cancelled directly via API
   * or dedupe logic without an attempt ever running).
   */
  private async reconcileOrphanedPipelineRuns(): Promise<void> {
    try {
      const orphaned = await this.db<{ id: string }[]>`
        SELECT pr.id
        FROM pipeline_runs pr
        WHERE pr.run_mode = 'jobs'
          AND pr.status IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.run_id = pr.id
              AND j.phase NOT IN ('done', 'cancelled')
          )
          AND EXISTS (
            SELECT 1 FROM jobs j WHERE j.run_id = pr.id
          )
      `;

      for (const run of orphaned) {
        console.log(`Reconciling orphaned pipeline run ${run.id}`);
        await this.syncPipelineRunStatus(run.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to reconcile orphaned pipeline runs: ${message}`);
    }
  }

  private async emitPipelineFailureEvent(run: PipelineRun, errorMessage: string): Promise<void> {
    try {
      const events = eventQueries(this.db);
      await events.create({
        id: generateEventId(),
        project_id: run.project_id,
        type: 'system.pipeline.failed',
        source: 'system',
        env_name: run.env_name,
        ref_sha: run.git_sha,
        ref_branch: null,
        actor_type: 'system',
        actor_id: 'orchestrator',
        payload_json: {
          run_id: run.id,
          pipeline_name: run.pipeline_name,
          env_name: run.env_name,
          git_sha: run.git_sha,
          error_message: errorMessage,
          error_code: 'pipeline_failed',
        },
        dedupe_key: `pipeline_failed:${run.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to emit pipeline failure event for ${run.id}: ${message}`);
    }
  }

  /**
   * Resolve secrets from the API for harness selection.
   * Returns an env-like object with secret keys and values.
   * Supports all scopes: system → org → project → user
   */
  private async resolveSecretsForHarnessSelection(
    projectId: string,
    userId?: string
  ): Promise<Record<string, string>> {
    if (!this.config.EVE_INTERNAL_API_KEY || !this.config.EVE_API_URL) {
      console.warn(
        `[resolveSecrets] Missing EVE_INTERNAL_API_KEY or EVE_API_URL — cannot resolve secrets for harness selection (project: ${projectId})`
      );
      return {};
    }

    try {
      const url = `${this.config.EVE_API_URL}/internal/projects/${projectId}/secrets/resolve`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-internal-token': this.config.EVE_INTERNAL_API_KEY,
        },
        body: JSON.stringify({ project_id: projectId, user_id: userId }),
      });

      if (!response.ok) {
        console.warn(
          `[resolveSecrets] Secrets API returned ${response.status} for project ${projectId}`
        );
        return {};
      }

      const json = await response.json();
      const parsed = SecretResolveResponseSchema.safeParse(json);
      if (!parsed.success) {
        console.warn(
          `[resolveSecrets] Invalid response from secrets API for project ${projectId}: ${parsed.error.message}`
        );
        return {};
      }

      // Convert to env-like object (only env_var type secrets)
      const env: Record<string, string> = {};
      for (const secret of parsed.data.data) {
        if (secret.type === 'env_var') {
          env[secret.key] = secret.value;
        }
      }
      return env;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[resolveSecrets] Failed to resolve secrets for project ${projectId}: ${message}`);
      return {};
    }
  }

  private async getManifestDefaults(
    projectId: string
  ): Promise<Record<string, unknown> | null> {
    const manifests = projectManifestQueries(this.db);
    const manifest = await manifests.findLatestByProject(projectId);
    return manifest?.parsed_defaults ?? null;
  }

  private async resolveOrgFsMountContext(job: Job, orgId: string): Promise<OrgFsMountContext> {
    const userId = job.actor_user_id?.trim();
    if (!userId) {
      return NO_ORG_FS_MOUNT;
    }

    try {
      const bindings = await accessRoleQueries(this.db).listApplicableBindings({
        orgId,
        principalType: 'user',
        principalId: userId,
        projectId: job.project_id,
      });
      return deriveOrgFsMountContext(bindings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Failed to resolve orgfs scope for job ${job.id} (${userId}); defaulting to no mount: ${message}`,
      );
      return NO_ORG_FS_MOUNT;
    }
  }

  private async resolveJobScope(job: Job, orgId: string): Promise<{ orgFsMount: OrgFsMountContext; tokenScope: AccessBindingScope | null }> {
    const parsedScope = AccessBindingScopeSchema.safeParse(job.token_scope);
    if (job.token_scope !== null && job.token_scope !== undefined && parsedScope.success) {
      const tokenScope = parsedScope.data;
      return {
        orgFsMount: deriveOrgFsMountContextFromTokenScope(tokenScope),
        tokenScope,
      };
    }

    if (job.token_scope !== null && job.token_scope !== undefined && !parsedScope.success) {
      console.warn(`Job ${job.id} has invalid token_scope; defaulting to no mount and no token scope`);
      return { orgFsMount: NO_ORG_FS_MOUNT, tokenScope: null };
    }

    return {
      orgFsMount: await this.resolveOrgFsMountContext(job, orgId),
      tokenScope: null,
    };
  }

  private async getSystemHarnessPreference(): Promise<string[] | undefined> {
    const settings = systemSettingsQueries(this.db);
    const setting = await settings.get('harness_preference');
    if (!setting?.value) return undefined;
    return setting.value.split(',').map(s => s.trim()).filter(Boolean);
  }

  async onModuleDestroy() {
    console.log('Orchestrator shutting down — stopping new claims...');

    // 1. Stop claiming new work
    this.stopClaiming();

    // 2. Stop the concurrency auto-tuner
    this.tuner.stop();

    // 3. Stop the polling loop
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // 4. Wait for in-flight dispatches to complete (30s timeout)
    if (this.limiter.inFlight > 0) {
      console.log(`Draining ${this.limiter.inFlight} in-flight dispatch(es)...`);
      const drained = await this.limiter.drain(30_000);
      if (drained) {
        console.log('All in-flight dispatches completed.');
      } else {
        console.warn(
          `Shutdown timeout: ${this.limiter.inFlight} dispatch(es) still in-flight after 30s.`,
        );
      }
    }

    console.log('Orchestrator loop shutdown complete.');
  }
}

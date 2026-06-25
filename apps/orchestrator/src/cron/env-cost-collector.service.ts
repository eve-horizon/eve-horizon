import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  environmentCostSnapshotQueries,
  environmentQueries,
  orgQueries,
  projectQueries,
  type Db,
} from '@eve/db';
import { generateEnvironmentCostSnapshotId } from '@eve/shared';

export interface RawAllocation {
  key: string;
  namespace: string | null;
  envId: string | null;
  amountUsd: number;
  sharedAmountUsd: number | null;
  raw: Record<string, unknown>;
}

export interface CostSource {
  readonly name: string;
  fetchMonthToDate(window: { start: Date; end: Date }): Promise<RawAllocation[]>;
}

const DEFAULT_CRON = '0 * * * *';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLATFORM_NAMESPACES = new Set([
  'eve',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'ingress-nginx',
  'cert-manager',
  'monitoring',
  'opencost',
]);

@Injectable()
export class EnvCostCollectorService implements OnModuleInit, OnModuleDestroy {
  private cronJob: CronJob | null = null;

  private readonly environments: ReturnType<typeof environmentQueries>;
  private readonly orgs: ReturnType<typeof orgQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly snapshots: ReturnType<typeof environmentCostSnapshotQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.environments = environmentQueries(db);
    this.orgs = orgQueries(db);
    this.projects = projectQueries(db);
    this.snapshots = environmentCostSnapshotQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_ENV_COST_COLLECTOR_ENABLED !== 'true') {
      console.log('[env-cost] Collector disabled (set EVE_ENV_COST_COLLECTOR_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_ENV_COST_COLLECTOR_CRON ?? DEFAULT_CRON;
    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.collect().catch((err) => {
            console.error('[env-cost] Collection failed:', err instanceof Error ? err.message : String(err));
          });
        },
        null,
        true,
        'UTC',
      );
      console.log(`[env-cost] Collector enabled (cron="${cron}")`);
    } catch (err) {
      console.error('[env-cost] Failed to start cron:', err instanceof Error ? err.message : String(err));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cronJob) {
      try {
        this.cronJob.stop();
      } catch {
        // Ignore stop errors during shutdown.
      }
      this.cronJob = null;
    }
  }

  async collect(source?: CostSource, now = new Date()): Promise<void> {
    const costSource = source ?? this.createSourceFromEnv();
    if (!costSource) {
      console.warn('[env-cost] EVE_OPENCOST_URL not configured; skipping collection');
      return;
    }

    const windowStart = monthStartUtc(now);
    const startedAt = Date.now();
    const activeEnvs = await this.environments.listActive();
    const namespaceMap = new Map<string, EnvCostTarget>();
    const envIdMap = new Map<string, EnvCostTarget>();
    const orgLabelCache = new Map<string, string>();

    for (const env of activeEnvs) {
      if (!env.namespace) continue;
      const project = await this.projects.findById(env.project_id);
      if (!project) {
        console.warn(`[env-cost] Project ${env.project_id} not found for env ${env.id}; skipping`);
        continue;
      }
      let orgLabel = orgLabelCache.get(project.org_id);
      if (!orgLabel) {
        const org = await this.orgs.findById(project.org_id);
        orgLabel = org?.slug ?? org?.name ?? project.org_id;
        orgLabelCache.set(project.org_id, orgLabel);
      }
      const target: EnvCostTarget = {
        environmentId: env.id,
        orgId: project.org_id,
        projectId: env.project_id,
        environmentSlug: formatEnvironmentDisplayPath(orgLabel, project.name || project.slug || env.project_id, env.name),
        namespace: env.namespace,
      };
      namespaceMap.set(env.namespace, target);
      envIdMap.set(env.id, target);
    }

    let allocations: RawAllocation[];
    try {
      allocations = await costSource.fetchMonthToDate({ start: windowStart, end: now });
    } catch (err) {
      console.warn('[env-cost] Source fetch failed:', err instanceof Error ? err.message : String(err));
      return;
    }
    if (allocations.length === 0) {
      console.warn('[env-cost] Source returned no usable allocations; leaving last-good snapshots untouched');
      return;
    }

    const envAmounts = new Map<string, { target: EnvCostTarget; amount: number; sharedAmount: number; raw: Record<string, unknown>[] }>();
    const overhead: RawAllocation[] = [];
    const unmappedNamespaces = new Set<string>();

    for (const allocation of allocations) {
      const target = allocation.envId ? envIdMap.get(allocation.envId) : undefined;
      const resolved = target ?? (allocation.namespace ? namespaceMap.get(allocation.namespace) : undefined);
      const isOverhead = isSharedOverheadAllocation(allocation);
      if (!resolved || isOverhead) {
        overhead.push(allocation);
        if (allocation.namespace && !isOverhead) unmappedNamespaces.add(allocation.namespace);
        continue;
      }

      const existing = envAmounts.get(resolved.environmentId) ?? {
        target: resolved,
        amount: 0,
        sharedAmount: 0,
        raw: [],
      };
      existing.amount += allocation.amountUsd;
      existing.sharedAmount += allocation.sharedAmountUsd ?? 0;
      existing.raw.push(allocation.raw);
      envAmounts.set(resolved.environmentId, existing);
    }

    let envRows = 0;
    for (const { target, amount, sharedAmount, raw } of envAmounts.values()) {
      await this.snapshots.upsert({
        id: generateEnvironmentCostSnapshotId(),
        aggregation_key: `env:${target.environmentId}`,
        environment_id: target.environmentId,
        org_id: target.orgId,
        project_id: target.projectId,
        environment_slug: target.environmentSlug,
        scope: 'environment',
        source: costSource.name,
        window_start: windowStart,
        window_end: now,
        amount_usd: formatAmountUsd(amount),
        shared_amount_usd: sharedAmount > 0 ? formatAmountUsd(sharedAmount) : null,
        confidence: 'estimate',
        breakdown_json: { allocations: raw },
        observed_at: now,
      });
      envRows++;
    }

    const overheadAmount = overhead.reduce((sum, allocation) => sum + allocation.amountUsd, 0);
    await this.snapshots.upsert({
      id: generateEnvironmentCostSnapshotId(),
      aggregation_key: 'shared:platform',
      environment_id: null,
      environment_slug: null,
      scope: 'shared_overhead',
      source: costSource.name,
      window_start: windowStart,
      window_end: now,
      amount_usd: formatAmountUsd(overheadAmount),
      confidence: 'estimate',
      breakdown_json: { allocations: overhead.map((allocation) => allocation.raw) },
      observed_at: now,
    });

    const elapsed = Date.now() - startedAt;
    const unmapped = Array.from(unmappedNamespaces).sort();
    console.log(
      `[env-cost] Collection complete: ${envRows} env rows, ${overhead.length} overhead allocations, ` +
      `${unmapped.length} unmapped namespaces (${elapsed}ms)`,
    );
    if (unmapped.length > 0) {
      console.warn(`[env-cost] Unmapped namespaces counted as overhead: ${unmapped.join(', ')}`);
    }
  }

  private createSourceFromEnv(): CostSource | null {
    const url = process.env.EVE_OPENCOST_URL;
    if (!url) return null;
    const shareIdle = process.env.EVE_ENV_COST_SHARE_IDLE === 'true';
    const timeoutMs = parseInt(process.env.EVE_OPENCOST_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS), 10);
    return new OpenCostSource(url, {
      shareIdle,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    });
  }
}

interface EnvCostTarget {
  environmentId: string;
  orgId: string;
  projectId: string;
  environmentSlug: string;
  namespace: string;
}

export class OpenCostSource implements CostSource {
  readonly name = 'opencost';

  constructor(
    private readonly baseUrl: string,
    private readonly options: { shareIdle: boolean; timeoutMs: number },
  ) {}

  async fetchMonthToDate(window: { start: Date; end: Date }): Promise<RawAllocation[]> {
    const params = new URLSearchParams({
      window: `${toOpenCostWindowTimestamp(window.start)},${toOpenCostWindowTimestamp(window.end)}`,
      aggregate: 'namespace',
      includeIdle: String(!this.options.shareIdle),
      shareIdle: String(this.options.shareIdle),
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/allocation?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenCost allocation request failed: HTTP ${response.status}`);
      }
      const payload = await response.json();
      return normalizeOpenCostAllocations(payload);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Format a Date as an RFC3339 timestamp WITHOUT fractional seconds.
 *
 * OpenCost's /allocation endpoint rejects window timestamps that carry
 * millisecond precision (Date.toISOString() emits e.g. "2026-06-01T00:00:00.000Z"),
 * responding with HTTP 400. Stripping the ".000" suffix yields "2026-06-01T00:00:00Z",
 * which OpenCost accepts.
 */
export function toOpenCostWindowTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function normalizeOpenCostAllocations(payload: unknown): RawAllocation[] {
  const rawAllocations = extractAllocationObjects(payload);
  return rawAllocations
    .map(({ key, value }) => normalizeAllocation(key, value))
    .filter((allocation): allocation is RawAllocation => allocation !== null);
}

function extractAllocationObjects(payload: unknown): Array<{ key: string; value: Record<string, unknown> }> {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    root.data,
    root.allocations,
    root,
  ];

  const sets = Array.isArray(root.sets)
    ? root.sets
    : Array.isArray((root.data as Record<string, unknown> | undefined)?.sets)
      ? ((root.data as Record<string, unknown>).sets as unknown[])
      : [];
  for (const set of sets) {
    if (set && typeof set === 'object') {
      candidates.push((set as Record<string, unknown>).allocations);
    }
  }

  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (item && typeof item === 'object') {
          appendAllocationOrMap(out, String((item as Record<string, unknown>).name ?? out.length), item as Record<string, unknown>);
        }
      }
      continue;
    }
    if (typeof candidate === 'object') {
      appendAllocationOrMap(out, String(out.length), candidate as Record<string, unknown>);
    }
  }
  return dedupeAllocationObjects(out);
}

function appendAllocationOrMap(
  out: Array<{ key: string; value: Record<string, unknown> }>,
  fallbackKey: string,
  value: Record<string, unknown>,
): void {
  if (looksLikeAllocation(value)) {
    out.push({ key: readString(value.name) ?? fallbackKey, value });
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (nested && typeof nested === 'object' && !Array.isArray(nested) && looksLikeAllocation(nested as Record<string, unknown>)) {
      out.push({ key, value: nested as Record<string, unknown> });
    }
  }
}

function looksLikeAllocation(value: Record<string, unknown>): boolean {
  return [
    'totalCost',
    'totalCostUsd',
    'total_cost',
    'cost',
    'amount_usd',
    'amount',
    'sharedCost',
    'shared_cost',
    'sharedAmountUsd',
  ].some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function dedupeAllocationObjects(items: Array<{ key: string; value: Record<string, unknown> }>): Array<{ key: string; value: Record<string, unknown> }> {
  const seen = new Set<Record<string, unknown>>();
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const item of items) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    out.push(item);
  }
  return out;
}

function normalizeAllocation(key: string, value: Record<string, unknown>): RawAllocation | null {
  const properties = asRecord(value.properties);
  const labels = {
    ...asRecord(value.labels),
    ...asRecord(properties?.labels),
  };
  const namespace = readString(value.namespace)
    ?? readString(properties?.namespace)
    ?? (isSpecialAllocationName(key) ? null : key);
  const envId = readLabel(labels, 'eve.env_id') ?? readLabel(labels, 'eve_env_id');
  const amountUsd = readNumber(value.totalCost)
    ?? readNumber(value.totalCostUsd)
    ?? readNumber(value.total_cost)
    ?? readNumber(value.cost)
    ?? readNumber(value.amount_usd)
    ?? readNumber(value.amount)
    ?? 0;
  const sharedAmountUsd = readNumber(value.sharedCost)
    ?? readNumber(value.shared_cost)
    ?? readNumber(value.sharedAmountUsd)
    ?? null;

  if (amountUsd <= 0 && (sharedAmountUsd ?? 0) <= 0) return null;

  return {
    key,
    namespace,
    envId,
    amountUsd,
    sharedAmountUsd,
    raw: value,
  };
}

function isSharedOverheadAllocation(allocation: RawAllocation): boolean {
  if (isSpecialAllocationName(allocation.key)) return true;
  if (allocation.namespace && PLATFORM_NAMESPACES.has(allocation.namespace)) return true;
  return false;
}

function isSpecialAllocationName(value: string): boolean {
  return value === '__idle__' || value === '__unallocated__' || value === 'idle' || value === 'unallocated';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readLabel(labels: Record<string, unknown>, key: string): string | null {
  return readString(labels[key]) ?? readString(labels[`label:${key}`]);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatAmountUsd(value: number): string {
  return Math.max(0, value).toFixed(6);
}

function formatEnvironmentDisplayPath(orgLabel: string, projectLabel: string, environmentLabel: string): string {
  return [orgLabel, projectLabel, environmentLabel]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' / ');
}

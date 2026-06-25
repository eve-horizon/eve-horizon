import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  environmentQueries,
  projectQueries,
  usageRecordQueries,
  balanceLedgerQueries,
  type Db,
} from '@eve/db';
import {
  generateUsageRecordId,
  generateSweepId,
  generateBalanceTransactionId,
} from '@eve/shared';

/**
 * Default usage rates (USD per unit).
 *
 * These translate raw resource consumption into monetary charges:
 * - vcpu_seconds:       ~$0.045 / vCPU-hour
 * - memory_gib_seconds: ~$0.0126 / GiB-hour
 * - gb_hours:           ~$0.073 / GB-month
 */
const DEFAULT_USAGE_RATES: Record<string, number> = {
  vcpu_seconds: 0.0000125,
  memory_gib_seconds: 0.0000035,
  gb_hours: 0.0001,
};

/**
 * K8s API helpers. The orchestrator runs inside the cluster so we can use
 * the in-cluster service account for authentication.
 */
const K8S_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const K8S_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const K8S_API_BASE = 'https://kubernetes.default.svc';

interface K8sPod {
  metadata: { name: string; namespace: string; creationTimestamp: string };
  spec: {
    containers: Array<{
      name: string;
      resources?: {
        requests?: { cpu?: string; memory?: string };
      };
    }>;
  };
  status: { phase: string; startTime?: string };
}

interface K8sPvc {
  metadata: { name: string; namespace: string; creationTimestamp: string };
  spec: {
    resources: { requests: { storage?: string } };
  };
  status: { phase: string };
}

/**
 * Usage sweeper (Phase 9: Non-Job Usage Metering)
 *
 * Periodically scans active environments for K8s resource consumption
 * (pods, PVCs) and writes usage_records + balance charges.
 *
 * Disabled by default; enable with `EVE_USAGE_SWEEPER_ENABLED=true`.
 *
 * Env vars:
 * - EVE_USAGE_SWEEPER_ENABLED=true|false
 * - EVE_USAGE_SWEEPER_CRON="*\/5 * * * *" (default: every 5 minutes)
 */
@Injectable()
export class UsageSweeperService implements OnModuleInit, OnModuleDestroy {
  private cronJob: CronJob | null = null;

  private readonly environments: ReturnType<typeof environmentQueries>;
  private readonly projects: ReturnType<typeof projectQueries>;
  private readonly usageRecords: ReturnType<typeof usageRecordQueries>;
  private readonly ledger: ReturnType<typeof balanceLedgerQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.environments = environmentQueries(db);
    this.projects = projectQueries(db);
    this.usageRecords = usageRecordQueries(db);
    this.ledger = balanceLedgerQueries(db);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.EVE_USAGE_SWEEPER_ENABLED !== 'true') {
      console.log('[usage-sweeper] Disabled (set EVE_USAGE_SWEEPER_ENABLED=true to enable)');
      return;
    }

    const cron = process.env.EVE_USAGE_SWEEPER_CRON ?? '*/5 * * * *';

    try {
      this.cronJob = new CronJob(
        cron,
        () => {
          this.sweep().catch((err) => {
            console.error(
              '[usage-sweeper] Sweep failed:',
              err instanceof Error ? err.message : String(err),
            );
          });
        },
        null,
        true,
        'UTC',
      );
      console.log(`[usage-sweeper] Enabled (cron="${cron}")`);
    } catch (err) {
      console.error(
        '[usage-sweeper] Failed to start cron:',
        err instanceof Error ? err.message : String(err),
      );
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

  /**
   * Main sweep: enumerate active environments, query K8s, write records + charges.
   */
  async sweep(): Promise<void> {
    const sweepId = generateSweepId();
    const now = new Date();
    console.log(`[usage-sweeper] Starting sweep ${sweepId}`);

    const activeEnvs = await this.environments.listActive();
    let recordsCreated = 0;
    let chargesCreated = 0;

    for (const env of activeEnvs) {
      if (!env.namespace) continue;

      // Resolve org_id from the project.
      let orgId: string;
      try {
        const project = await this.projects.findById(env.project_id);
        if (!project) {
          console.warn(`[usage-sweeper] Project ${env.project_id} not found for env ${env.id}, skipping`);
          continue;
        }
        orgId = project.org_id;
      } catch (err) {
        console.warn(
          `[usage-sweeper] Failed to resolve project for env ${env.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }

      try {
        const { records, charges } = await this.sweepNamespace(
          sweepId,
          now,
          env.namespace,
          orgId,
          env.project_id,
          env.id,
        );
        recordsCreated += records;
        chargesCreated += charges;
      } catch (err) {
        // Graceful degradation: log and continue with next env.
        console.warn(
          `[usage-sweeper] Failed to sweep namespace ${env.namespace}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.log(
      `[usage-sweeper] Sweep ${sweepId} complete: ${activeEnvs.length} envs, ${recordsCreated} records, ${chargesCreated} charges`,
    );
  }

  /**
   * Sweep a single K8s namespace: pods (CPU + memory) and PVCs (storage).
   */
  private async sweepNamespace(
    sweepId: string,
    now: Date,
    namespace: string,
    orgId: string,
    projectId: string,
    envId: string,
  ): Promise<{ records: number; charges: number }> {
    let records = 0;
    let charges = 0;
    const sourceId = `${sweepId}:${namespace}`;

    // --- Pods ---
    const pods = await this.listPods(namespace);
    let totalCpuSeconds = 0;
    let totalMemGibSeconds = 0;

    for (const pod of pods) {
      if (pod.status.phase !== 'Running') continue;

      const startTime = pod.status.startTime
        ? new Date(pod.status.startTime)
        : new Date(pod.metadata.creationTimestamp);
      const windowSeconds = Math.max(0, (now.getTime() - startTime.getTime()) / 1000);

      for (const container of pod.spec.containers) {
        const cpuCores = parseCpuRequest(container.resources?.requests?.cpu);
        const memGib = parseMemoryToGib(container.resources?.requests?.memory);
        totalCpuSeconds += cpuCores * windowSeconds;
        totalMemGibSeconds += memGib * windowSeconds;
      }
    }

    if (totalCpuSeconds > 0) {
      const created = await this.writeUsageRecord({
        orgId,
        projectId,
        envId,
        resourceType: 'vcpu_seconds',
        quantity: totalCpuSeconds.toFixed(4),
        unit: 'vcpu_seconds',
        startedAt: now,
        sourceType: 'k8s_sweep',
        sourceId,
      });
      if (created) {
        records++;
        const charged = await this.chargeForRecord(created, orgId);
        if (charged) charges++;
      }
    }

    if (totalMemGibSeconds > 0) {
      const created = await this.writeUsageRecord({
        orgId,
        projectId,
        envId,
        resourceType: 'memory_gib_seconds',
        quantity: totalMemGibSeconds.toFixed(4),
        unit: 'memory_gib_seconds',
        startedAt: now,
        sourceType: 'k8s_sweep',
        sourceId,
      });
      if (created) {
        records++;
        const charged = await this.chargeForRecord(created, orgId);
        if (charged) charges++;
      }
    }

    // --- PVCs ---
    const pvcs = await this.listPvcs(namespace);
    let totalGbHours = 0;

    for (const pvc of pvcs) {
      if (pvc.status.phase !== 'Bound') continue;

      const created = new Date(pvc.metadata.creationTimestamp);
      const windowHours = Math.max(0, (now.getTime() - created.getTime()) / (1000 * 3600));
      const capacityGb = parseStorageToGb(pvc.spec.resources.requests.storage);
      totalGbHours += capacityGb * windowHours;
    }

    if (totalGbHours > 0) {
      const created = await this.writeUsageRecord({
        orgId,
        projectId,
        envId,
        resourceType: 'gb_hours',
        quantity: totalGbHours.toFixed(4),
        unit: 'gb_hours',
        startedAt: now,
        sourceType: 'k8s_sweep',
        sourceId,
      });
      if (created) {
        records++;
        const charged = await this.chargeForRecord(created, orgId);
        if (charged) charges++;
      }
    }

    return { records, charges };
  }

  /**
   * Write a single usage record (idempotent via UNIQUE constraint).
   */
  private async writeUsageRecord(input: {
    orgId: string;
    projectId: string;
    envId: string;
    resourceType: string;
    quantity: string;
    unit: string;
    startedAt: Date;
    sourceType: string;
    sourceId: string;
  }): Promise<{ id: string; resourceType: string; quantity: string; unit: string } | null> {
    // Check idempotency first.
    const existing = await this.usageRecords.findBySource(
      input.sourceType,
      input.sourceId,
      input.resourceType,
    );
    if (existing) return null; // Already recorded this sweep for this namespace + resource type.

    const record = await this.usageRecords.create({
      id: generateUsageRecordId(),
      org_id: input.orgId,
      project_id: input.projectId,
      env_id: input.envId,
      resource_type: input.resourceType,
      quantity: input.quantity,
      unit: input.unit,
      started_at: input.startedAt,
      source_type: input.sourceType,
      source_id: input.sourceId,
    });

    return {
      id: record.id,
      resourceType: record.resource_type,
      quantity: record.quantity,
      unit: record.unit,
    };
  }

  /**
   * Create a balance charge for a usage record.
   */
  private async chargeForRecord(
    record: { id: string; resourceType: string; quantity: string; unit: string },
    orgId: string,
  ): Promise<boolean> {
    const rate = DEFAULT_USAGE_RATES[record.unit];
    if (!rate) return false;

    const quantity = parseFloat(record.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return false;

    const chargeUsd = (quantity * rate).toFixed(10);
    if (parseFloat(chargeUsd) <= 0) return false;

    // Ensure the org has a balance row.
    try {
      await this.ledger.ensureBalance(orgId, 'usd');
    } catch (err) {
      console.warn(
        `[usage-sweeper] Failed to ensure balance for ${orgId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }

    try {
      await this.ledger.createTransaction({
        id: generateBalanceTransactionId(),
        org_id: orgId,
        type: 'charge',
        amount: chargeUsd,
        currency: 'usd',
        description: `Usage: ${record.quantity} ${record.unit}`,
        source_type: 'usage_record',
        source_id: record.id,
      });
      return true;
    } catch (err) {
      // Idempotent: duplicate source_id will throw unique violation.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return false;
      }
      console.warn(`[usage-sweeper] Failed to charge for record ${record.id}:`, msg);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // K8s API helpers
  // ---------------------------------------------------------------------------

  private async readK8sToken(): Promise<string | null> {
    try {
      const { readFile } = await import('node:fs/promises');
      return (await readFile(K8S_TOKEN_PATH, 'utf-8')).trim();
    } catch {
      return null;
    }
  }

  private async k8sFetch<T>(path: string): Promise<T> {
    const token = await this.readK8sToken();
    if (!token) {
      throw new Error('K8s service account token not available');
    }

    // In-cluster: trust the cluster CA. Node needs NODE_EXTRA_CA_CERTS or
    // we disable TLS verification for the internal API call.
    const url = `${K8S_API_BASE}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      // @ts-expect-error -- Node fetch supports this for self-signed certs in-cluster
      dispatcher: undefined,
    });

    if (!response.ok) {
      throw new Error(`K8s API ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  private async listPods(namespace: string): Promise<K8sPod[]> {
    try {
      const data = await this.k8sFetch<{ items: K8sPod[] }>(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
      );
      return data.items ?? [];
    } catch (err) {
      console.warn(
        `[usage-sweeper] Failed to list pods in ${namespace}:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private async listPvcs(namespace: string): Promise<K8sPvc[]> {
    try {
      const data = await this.k8sFetch<{ items: K8sPvc[] }>(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`,
      );
      return data.items ?? [];
    } catch (err) {
      console.warn(
        `[usage-sweeper] Failed to list PVCs in ${namespace}:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// K8s resource quantity parsers
// ---------------------------------------------------------------------------

/**
 * Parse a K8s CPU request string to fractional cores.
 * Examples: "500m" -> 0.5, "2" -> 2, "100m" -> 0.1
 */
function parseCpuRequest(cpu: string | undefined): number {
  if (!cpu) return 0;
  if (cpu.endsWith('m')) {
    return parseInt(cpu.slice(0, -1), 10) / 1000;
  }
  const n = parseFloat(cpu);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a K8s memory request string to GiB.
 * Examples: "512Mi" -> 0.5, "2Gi" -> 2, "1073741824" -> 1
 */
function parseMemoryToGib(memory: string | undefined): number {
  if (!memory) return 0;

  if (memory.endsWith('Gi')) {
    return parseFloat(memory.slice(0, -2));
  }
  if (memory.endsWith('Mi')) {
    return parseFloat(memory.slice(0, -2)) / 1024;
  }
  if (memory.endsWith('Ki')) {
    return parseFloat(memory.slice(0, -2)) / (1024 * 1024);
  }
  if (memory.endsWith('G')) {
    return parseFloat(memory.slice(0, -1)) / 1.073741824;
  }
  if (memory.endsWith('M')) {
    return parseFloat(memory.slice(0, -1)) / 1073.741824;
  }
  if (memory.endsWith('K')) {
    return parseFloat(memory.slice(0, -1)) / 1073741.824;
  }

  // Plain bytes.
  const bytes = parseFloat(memory);
  return Number.isFinite(bytes) ? bytes / (1024 * 1024 * 1024) : 0;
}

/**
 * Parse a K8s storage quantity to GB.
 * Examples: "10Gi" -> 10.737, "1Ti" -> 1099.5, "500Mi" -> 0.524
 */
function parseStorageToGb(storage: string | undefined): number {
  if (!storage) return 0;

  if (storage.endsWith('Ti')) {
    return parseFloat(storage.slice(0, -2)) * 1024 * (1024 / 1000) * (1024 / 1000);
  }
  if (storage.endsWith('Gi')) {
    return parseFloat(storage.slice(0, -2)) * (1024 * 1024 * 1024) / (1000 * 1000 * 1000);
  }
  if (storage.endsWith('Mi')) {
    return parseFloat(storage.slice(0, -2)) * (1024 * 1024) / (1000 * 1000 * 1000);
  }
  if (storage.endsWith('Ki')) {
    return parseFloat(storage.slice(0, -2)) * 1024 / (1000 * 1000 * 1000);
  }

  // Plain bytes.
  const bytes = parseFloat(storage);
  return Number.isFinite(bytes) ? bytes / (1000 * 1000 * 1000) : 0;
}

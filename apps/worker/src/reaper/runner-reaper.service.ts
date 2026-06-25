import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import type { Db } from '@eve/db';

const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];

@Injectable()
export class RunnerReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunnerReaperService.name);
  private coreApi?: k8s.CoreV1Api;
  private timer?: ReturnType<typeof setInterval>;

  private readonly enabled = process.env.EVE_RUNNER_REAPER_ENABLED !== 'false';
  private readonly intervalMs = parseInt(process.env.EVE_RUNNER_REAPER_INTERVAL_MS ?? '300000', 10);
  private readonly graceSeconds = parseInt(process.env.EVE_RUNNER_REAPER_GRACE_SECONDS ?? '120', 10);
  private readonly namespace = process.env.EVE_K8S_NAMESPACE ?? 'eve';

  constructor(@Inject('DB') private readonly db: Db) {}

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Runner reaper disabled (EVE_RUNNER_REAPER_ENABLED=false)');
      return;
    }

    if (process.env.EVE_RUNTIME !== 'k8s') {
      this.logger.log('Runner reaper skipped (EVE_RUNTIME is not k8s)');
      return;
    }

    try {
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    } catch (err) {
      this.logger.warn(`K8s client unavailable, reaper disabled: ${err instanceof Error ? err.message : err}`);
      return;
    }

    this.logger.log(`Runner reaper started (interval: ${this.intervalMs}ms, grace: ${this.graceSeconds}s)`);

    // Run immediately on startup, then on interval
    void this.reapSafe();
    this.timer = setInterval(() => void this.reapSafe(), this.intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async reapSafe(): Promise<void> {
    try {
      await this.reap();
    } catch (err) {
      this.logger.error(`Reap cycle failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async reap(): Promise<void> {
    if (!this.coreApi) return;

    const labelSelector = 'eve.type=runner';
    const now = Date.now();
    const graceMs = this.graceSeconds * 1000;

    // 1. List runner pods and PVCs
    const [podList, pvcList] = await Promise.all([
      this.coreApi.listNamespacedPod(
        this.namespace, undefined, undefined, undefined, undefined, labelSelector,
      ),
      this.coreApi.listNamespacedPersistentVolumeClaim(
        this.namespace, undefined, undefined, undefined, undefined, labelSelector,
      ),
    ]);

    const pods = podList.body.items;
    const pvcs = pvcList.body.items;

    if (pods.length === 0 && pvcs.length === 0) return;

    // 2. Collect unique attempt IDs from annotations (raw UUIDs)
    const attemptIds = new Set<string>();
    for (const pod of pods) {
      const id = pod.metadata?.annotations?.['eve.attempt_id'];
      if (id) attemptIds.add(id);
    }
    for (const pvc of pvcs) {
      const id = pvc.metadata?.annotations?.['eve.attempt_id'];
      if (id) attemptIds.add(id);
    }

    // 3. Batch query DB for attempt statuses
    const statusMap = new Map<string, string>();
    if (attemptIds.size > 0) {
      const ids = [...attemptIds];
      const rows = await this.db<{ id: string; status: string }[]>`
        SELECT id, status FROM job_attempts
        WHERE id = ANY(${ids}::uuid[])
      `;
      for (const row of rows) {
        statusMap.set(row.id, row.status);
      }
    }

    // 4. Determine which pods to delete
    const podsToDelete: string[] = [];
    const podNames = new Set<string>(); // pods we're keeping

    for (const pod of pods) {
      const name = pod.metadata?.name;
      if (!name) continue;

      const createdAt = pod.metadata?.creationTimestamp;
      if (createdAt && (now - new Date(createdAt).getTime()) < graceMs) {
        podNames.add(name); // too young, keep
        continue;
      }

      const attemptId = pod.metadata?.annotations?.['eve.attempt_id'];
      const podPhase = pod.status?.phase;

      // Pod already terminal (Failed/Succeeded) — always delete
      if (podPhase === 'Failed' || podPhase === 'Succeeded') {
        podsToDelete.push(name);
        continue;
      }

      // Check attempt status in DB
      if (attemptId) {
        const status = statusMap.get(attemptId);
        if (!status || TERMINAL_STATUSES.includes(status)) {
          podsToDelete.push(name);
          continue;
        }
      } else {
        // No attempt ID annotation — orphaned, delete
        podsToDelete.push(name);
        continue;
      }

      podNames.add(name); // still alive, keep
    }

    // 5. Determine which PVCs to delete
    const pvcsToDelete: string[] = [];
    const keepPodPvcClaims = new Set<string>();
    for (const pod of pods) {
      const name = pod.metadata?.name;
      if (name && !podsToDelete.includes(name)) {
        // This pod is being kept — protect its PVC
        for (const vol of pod.spec?.volumes ?? []) {
          if (vol.persistentVolumeClaim?.claimName) {
            keepPodPvcClaims.add(vol.persistentVolumeClaim.claimName);
          }
        }
      }
    }

    for (const pvc of pvcs) {
      const name = pvc.metadata?.name;
      if (!name) continue;

      // PVC still in use by a kept pod — skip
      if (keepPodPvcClaims.has(name)) continue;

      const attemptId = pvc.metadata?.annotations?.['eve.attempt_id'];
      if (attemptId) {
        const status = statusMap.get(attemptId);
        if (!status || TERMINAL_STATUSES.includes(status)) {
          pvcsToDelete.push(name);
        }
      } else {
        // No attempt ID — orphaned
        pvcsToDelete.push(name);
      }
    }

    // 6. Delete
    let deletedPods = 0;
    let deletedPvcs = 0;

    for (const name of podsToDelete) {
      try {
        await this.coreApi.deleteNamespacedPod(name, this.namespace);
        deletedPods++;
        this.logger.log(`Reaped pod: ${name}`);
      } catch (err: unknown) {
        if ((err as { statusCode?: number })?.statusCode !== 404) {
          this.logger.warn(`Failed to delete pod ${name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    for (const name of pvcsToDelete) {
      try {
        await this.coreApi.deleteNamespacedPersistentVolumeClaim(name, this.namespace);
        deletedPvcs++;
        this.logger.log(`Reaped PVC: ${name}`);
      } catch (err: unknown) {
        if ((err as { statusCode?: number })?.statusCode !== 404) {
          this.logger.warn(`Failed to delete PVC ${name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const total = pods.length + pvcs.length;
    if (deletedPods > 0 || deletedPvcs > 0) {
      this.logger.log(`Reaped ${deletedPods} pods, ${deletedPvcs} PVCs (${total} checked)`);
    }
  }
}

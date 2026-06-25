# Runner Pod Cleanup Plan

Date: 2026-01-28
Owner: Eve Horizon
Status: Shipped (ce41434)

## Problem

Runner pods accumulate in `Unknown` or `Error` states when:
1. Worker crashes before the `finally` block runs
2. `kubectl delete` fails silently (no error handling)
3. Worker process is killed externally (OOM, SIGKILL)
4. Network issues prevent cleanup commands from reaching k8s API

This causes:
- Resource exhaustion in the cluster
- Confusion when debugging (stale pods mixed with active ones)
- PVC accumulation consuming storage

## Current Behavior

Runner pods are created in `apps/worker/src/invoke/k8s-runner.ts`:

```typescript
// Line 376 - cleanup in finally block
finally {
  await deleteResources(namespace, pvcName, podName);
}
```

The `deleteResources` function doesn't handle errors:

```typescript
async function deleteResources(namespace: string, pvcName: string, podName: string): Promise<void> {
  await execKubectl(['delete', 'pod', podName, `--namespace=${namespace}`]);
  await execKubectl(['delete', 'pvc', pvcName, `--namespace=${namespace}`]);
}
```

## Solution

Three-layer defense:

### Layer 1: Robust Cleanup (Immediate)

Make `deleteResources` idempotent and error-tolerant:

```typescript
async function deleteResources(namespace: string, pvcName: string, podName: string): Promise<void> {
  // --ignore-not-found prevents errors if already deleted
  // --wait=false returns immediately (don't block on termination)
  await execKubectl([
    'delete', 'pod', podName,
    `--namespace=${namespace}`,
    '--ignore-not-found=true',
    '--wait=false'
  ]);
  await execKubectl([
    'delete', 'pvc', pvcName,
    `--namespace=${namespace}`,
    '--ignore-not-found=true',
    '--wait=false'
  ]);
}
```

**Effort**: 10 minutes
**Risk**: None (purely additive flags)

### Layer 2: Orchestrator Orphan Reaper (Short-term)

Add a periodic cleanup task to the orchestrator that:
1. Lists all pods with label `eve.type=runner`
2. Cross-references with attempts in the database
3. Deletes pods where the attempt is in a terminal state

Location: `apps/orchestrator/src/orphan-reaper.service.ts`

```typescript
@Injectable()
export class OrphanReaperService implements OnModuleInit {
  private readonly logger = new Logger(OrphanReaperService.name);

  constructor(
    @Inject('DB') private readonly db: Db,
  ) {}

  onModuleInit() {
    // Run on startup
    this.reapOrphanedRunners();
    // Then every 5 minutes
    setInterval(() => this.reapOrphanedRunners(), 5 * 60 * 1000);
  }

  async reapOrphanedRunners() {
    const namespace = process.env.EVE_K8S_NAMESPACE || 'eve';

    // Get all runner pods
    const { stdout } = await execKubectl([
      'get', 'pods',
      `-n=${namespace}`,
      '-l=eve.type=runner',
      '-o=jsonpath={range .items[*]}{.metadata.name}:{.metadata.labels.eve\\.attempt-id}:{.status.phase}\\n{end}'
    ]);

    const pods = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, attemptId, phase] = line.split(':');
      return { name, attemptId, phase };
    });

    for (const pod of pods) {
      // Skip running pods unless they're very old
      if (pod.phase === 'Running') {
        const age = await this.getPodAgeMinutes(namespace, pod.name);
        if (age < 60) continue; // Skip pods < 1 hour old
      }

      // Check if attempt is terminal
      const attempt = await this.db.attempts.findById(pod.attemptId);
      if (!attempt || ['completed', 'failed', 'cancelled'].includes(attempt.status)) {
        this.logger.log(`Reaping orphaned runner: ${pod.name} (attempt: ${pod.attemptId}, status: ${attempt?.status || 'not found'})`);
        await execKubectl([
          'delete', 'pod', pod.name,
          `-n=${namespace}`,
          '--ignore-not-found=true'
        ]);
      }
    }
  }
}
```

**Effort**: 2-3 hours
**Risk**: Low (read-heavy, only deletes confirmed orphans)

### Layer 3: Pod TTL Backstop (Medium-term)

Add `activeDeadlineSeconds` to runner pod specs as a hard limit:

```yaml
spec:
  activeDeadlineSeconds: 7200  # 2 hours max
  restartPolicy: Never
```

This ensures k8s itself will terminate long-running pods even if all other cleanup fails.

**Effort**: 30 minutes
**Risk**: Could kill legitimate long-running jobs (mitigate with generous timeout)

## Implementation Order

| Phase | Task | Effort | Priority |
|-------|------|--------|----------|
| 1 | Add `--ignore-not-found` to deleteResources | 10 min | P0 |
| 2 | Add OrphanReaperService to orchestrator | 2-3 hrs | P1 |
| 3 | Add `activeDeadlineSeconds` to runner spec | 30 min | P2 |
| 4 | Add CLI command `eve system cleanup-runners` | 1 hr | P3 |

## Metrics & Observability

Add logging for:
- Runner pod creation (already exists)
- Runner pod deletion (success/failure)
- Orphan reaper runs (count of pods reaped)

Future: Add Prometheus metrics for runner pod lifecycle.

## Testing

1. **Unit test**: Mock kubectl calls in OrphanReaperService
2. **Integration test**: Create a runner, kill worker, verify reaper cleans up
3. **E2E test**: Run jobs, verify no orphaned pods after completion

## Rollback

All changes are additive and can be disabled:
- Layer 1: Remove flags (reverts to current behavior)
- Layer 2: Remove OrphanReaperService from module
- Layer 3: Remove activeDeadlineSeconds from pod spec

## Open Questions

1. Should we add a PVC reaper as well? (PVCs may accumulate separately)
2. What's the right `activeDeadlineSeconds` value? (2 hours proposed)
3. Should the reaper run in the orchestrator or as a separate CronJob?

## References

- Current implementation: `apps/worker/src/invoke/k8s-runner.ts`
- K8s pod lifecycle: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- activeDeadlineSeconds: https://kubernetes.io/docs/concepts/workloads/controllers/job/#pod-backoff-failure-policy

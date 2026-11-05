/**
 * Kubernetes isolation and placement for ephemeral runner pods.
 *
 * Runner pods execute job code: pipeline scripts and agent harnesses. That code
 * never needs the Kubernetes API, so a runner pod gets no API token and does not
 * borrow a platform service account (and with it the platform's RBAC or cloud
 * identity) unless an operator opts in explicitly.
 *
 * Both runner builders (worker and agent runtime) read the same variables:
 *
 * | Variable | Effect |
 * | --- | --- |
 * | `EVE_RUNNER_SERVICE_ACCOUNT` | Service account for runner pods. Unset: the namespace default. |
 * | `EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN` | `true` mounts the API token (off by default). |
 * | `EVE_RUNNER_NODE_SELECTOR_KEY` / `_VALUE` | Node label the pod must land on (both or neither). |
 * | `EVE_RUNNER_TAINT_KEY` / `_VALUE` / `_EFFECT` | Taint the pod tolerates (value and effect optional). |
 * | `EVE_RUNNER_POD_AFFINITY_KEY` / `_VALUE` | Run on the same node as a pod with this label (both or neither). |
 *
 * Pod affinity exists for `ReadWriteOnce` org filesystem claims: the worker's
 * runner mounts `eve-org-fs-org-default`, and an RWO disk attaches to one node
 * at a time, so the runner must land where the agent runtime already holds it
 * (for example `app.kubernetes.io/name=eve-agent-runtime`). Without it the pod
 * hangs in ContainerCreating with a Multi-Attach error. RWX claims do not need it.
 */

const TAINT_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const;
type TaintEffect = (typeof TAINT_EFFECTS)[number];

/** Platform service accounts that carry cluster RBAC or cloud identity. */
const PLATFORM_SERVICE_ACCOUNTS = new Set(['eve-worker', 'eve-agent-runtime', 'eve-api', 'eve-orchestrator']);

export interface RunnerToleration {
  key: string;
  operator: 'Equal' | 'Exists';
  value?: string;
  effect?: TaintEffect;
}

export interface RunnerPodAffinity {
  podAffinity: {
    requiredDuringSchedulingIgnoredDuringExecution: Array<{
      labelSelector: { matchLabels: Record<string, string> };
      topologyKey: 'kubernetes.io/hostname';
    }>;
  };
}

export interface RunnerPodIsolation {
  /** Omitted when unset, so the pod runs as the namespace's default service account. */
  serviceAccountName?: string;
  automountServiceAccountToken: boolean;
  nodeSelector?: Record<string, string>;
  tolerations?: RunnerToleration[];
  affinity?: RunnerPodAffinity;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readNodeSelector(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const key = readTrimmed(env, 'EVE_RUNNER_NODE_SELECTOR_KEY');
  const value = readTrimmed(env, 'EVE_RUNNER_NODE_SELECTOR_VALUE');
  if (!key && !value) return undefined;
  if (!key || value === undefined) {
    throw new Error('EVE_RUNNER_NODE_SELECTOR_KEY and EVE_RUNNER_NODE_SELECTOR_VALUE must be set together');
  }
  return { [key]: value };
}

function readPodAffinity(env: NodeJS.ProcessEnv): RunnerPodAffinity | undefined {
  const key = readTrimmed(env, 'EVE_RUNNER_POD_AFFINITY_KEY');
  const value = readTrimmed(env, 'EVE_RUNNER_POD_AFFINITY_VALUE');
  if (!key && !value) return undefined;
  if (!key || value === undefined) {
    throw new Error('EVE_RUNNER_POD_AFFINITY_KEY and EVE_RUNNER_POD_AFFINITY_VALUE must be set together');
  }
  return {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [{
        labelSelector: { matchLabels: { [key]: value } },
        topologyKey: 'kubernetes.io/hostname',
      }],
    },
  };
}

function readTolerations(env: NodeJS.ProcessEnv): RunnerToleration[] | undefined {
  const key = readTrimmed(env, 'EVE_RUNNER_TAINT_KEY');
  const value = readTrimmed(env, 'EVE_RUNNER_TAINT_VALUE');
  const effect = readTrimmed(env, 'EVE_RUNNER_TAINT_EFFECT');
  if (!key) {
    if (value || effect) {
      throw new Error('EVE_RUNNER_TAINT_VALUE and EVE_RUNNER_TAINT_EFFECT need EVE_RUNNER_TAINT_KEY');
    }
    return undefined;
  }
  if (effect && !TAINT_EFFECTS.includes(effect as TaintEffect)) {
    throw new Error(`EVE_RUNNER_TAINT_EFFECT must be one of ${TAINT_EFFECTS.join(', ')} (got "${effect}")`);
  }
  return [{
    key,
    ...(value ? { operator: 'Equal' as const, value } : { operator: 'Exists' as const }),
    ...(effect ? { effect: effect as TaintEffect } : {}),
  }];
}

/**
 * Resolve the service account, token mount, placement and co-location for a runner pod.
 * Throws on half-configured placement so a typo fails the job loudly instead of
 * scheduling job code onto the platform's own nodes.
 */
export function resolveRunnerPodIsolation(env: NodeJS.ProcessEnv = process.env): RunnerPodIsolation {
  const serviceAccountName = readTrimmed(env, 'EVE_RUNNER_SERVICE_ACCOUNT');
  const automount = readTrimmed(env, 'EVE_RUNNER_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN')?.toLowerCase();
  const nodeSelector = readNodeSelector(env);
  const tolerations = readTolerations(env);
  const affinity = readPodAffinity(env);
  return {
    ...(serviceAccountName ? { serviceAccountName } : {}),
    automountServiceAccountToken: automount === 'true' || automount === '1',
    ...(nodeSelector ? { nodeSelector } : {}),
    ...(tolerations ? { tolerations } : {}),
    ...(affinity ? { affinity } : {}),
  };
}

/**
 * True when runner pods are configured to run as a platform service account,
 * which hands job code that account's cloud identity (Workload Identity, IRSA)
 * even without a mounted token.
 */
export function runnerUsesPlatformServiceAccount(isolation: RunnerPodIsolation): boolean {
  return isolation.serviceAccountName !== undefined && PLATFORM_SERVICE_ACCOUNTS.has(isolation.serviceAccountName);
}

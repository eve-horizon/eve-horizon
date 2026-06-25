/**
 * Structured taxonomy for deploy failures. `DeployerService.deploy()` throws
 * `DeployFailureError` so the action-executor can persist both the failure kind
 * and a post-apply cluster snapshot on the attempt, and the CLI can render a
 * one-line "Next step" hint without parsing error messages.
 *
 * The `kind` strings are also used in `environments.last_deploy_failure_json`
 * and `attempt_logs.error_context.kind` so operators can grep/filter on a
 * stable vocabulary.
 */

import { K8sOperationError } from './k8s-error.js';

export interface ContainerSnapshot {
  name: string;
  ready: boolean;
  restartCount: number;
  image?: string | null;
  state: 'running' | 'waiting' | 'terminated' | 'unknown';
  waitingReason?: string | null;
  terminatedReason?: string | null;
  terminatedExitCode?: number | null;
  lastTerminatedReason?: string | null;
  lastTerminatedExitCode?: number | null;
}

export interface PodSnapshot {
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  service?: string | null;
  containers: ContainerSnapshot[];
}

export interface ClusterSnapshot {
  namespace: string;
  pods: PodSnapshot[];
  capturedAt: string;
}

export type DeployFailure =
  | { kind: 'k8s_api_error'; statusCode?: number; operation?: string; resource?: string; message: string }
  | { kind: 'manifest_invalid'; message: string; details?: string }
  | { kind: 'image_pull_error'; service: string; pod: string; image?: string | null; message: string }
  | {
      kind: 'app_crash_loop';
      service: string;
      pod: string;
      container: string;
      exitCode?: number | null;
      message: string;
      previousLogExcerpt?: string[];
    }
  | { kind: 'readiness_timeout'; notReady: string[]; message: string }
  | { kind: 'dependency_timeout'; service: string; waitedOn: string[]; message: string }
  | { kind: 'ingress_conflict'; hostname?: string; conflictingIngress?: string; message: string };

export class DeployFailureError extends Error {
  readonly failure: DeployFailure;
  readonly snapshot?: ClusterSnapshot;
  readonly manifestApplied: boolean;

  constructor(
    failure: DeployFailure,
    snapshot?: ClusterSnapshot,
    options?: { cause?: unknown; manifestApplied?: boolean },
  ) {
    super(`[${failure.kind}] ${failure.message}`);
    this.name = 'DeployFailureError';
    this.failure = failure;
    this.snapshot = snapshot;
    this.manifestApplied = options?.manifestApplied ?? false;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Select the pod most likely to explain a deploy failure. Preference order:
 *   1. CrashLoopBackOff / ImagePullBackOff / ErrImagePull
 *   2. Any not-ready pod with the highest restart count
 *   3. First not-ready pod
 *   4. First pod
 */
export function selectFailingPod(snapshot: ClusterSnapshot): PodSnapshot | null {
  if (snapshot.pods.length === 0) return null;

  const badReasons = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerError']);
  const withBadReason = snapshot.pods.find((p) =>
    p.containers.some((c) => c.waitingReason && badReasons.has(c.waitingReason)),
  );
  if (withBadReason) return withBadReason;

  const notReady = snapshot.pods.filter((p) => !p.ready);
  if (notReady.length > 0) {
    notReady.sort((a, b) => b.restartCount - a.restartCount);
    return notReady[0];
  }

  return snapshot.pods[0];
}

/**
 * Classify the failure kind based on a post-apply cluster snapshot and an
 * optional underlying error. Returns null when no failure is evident (caller
 * should treat that as "unknown" and keep the original error).
 */
export function classifyFromSnapshot(
  snapshot: ClusterSnapshot | null,
  underlying?: unknown,
): DeployFailure | null {
  if (underlying instanceof K8sOperationError) {
    const status = underlying.statusCode ?? 0;
    const body = underlying.body as { message?: string } | undefined;

    // nginx admission "host + path" conflicts arrive as 422.
    const isAdmissionIngress =
      status === 422 &&
      /ingress/i.test(underlying.resourceKind ?? '') &&
      /already defined/i.test(body?.message ?? underlying.message);
    if (isAdmissionIngress) {
      const match = /in ingress (\S+)/i.exec(body?.message ?? underlying.message);
      return {
        kind: 'ingress_conflict',
        conflictingIngress: match?.[1],
        message: underlying.message,
      };
    }

    // Invalid manifest / 400 / 422 on apply.
    if (status === 400 || status === 422) {
      return {
        kind: 'manifest_invalid',
        message: underlying.message,
        details: body?.message,
      };
    }

    return {
      kind: 'k8s_api_error',
      statusCode: status || undefined,
      operation: underlying.operation,
      resource: underlying.resourceKind && underlying.resourceName
        ? `${underlying.resourceKind}/${underlying.resourceName}`
        : underlying.resourceKind,
      message: underlying.message,
    };
  }

  if (!snapshot) return null;

  const pod = selectFailingPod(snapshot);
  if (!pod) return null;

  const container = pod.containers.find(
    (c) => c.waitingReason === 'CrashLoopBackOff' || (c.terminatedExitCode ?? 0) !== 0,
  )
    ?? pod.containers.find((c) => !c.ready)
    ?? pod.containers[0];

  if (container?.waitingReason && ['ImagePullBackOff', 'ErrImagePull'].includes(container.waitingReason)) {
    return {
      kind: 'image_pull_error',
      service: pod.service ?? pod.name,
      pod: pod.name,
      image: container.image ?? null,
      message: `${container.waitingReason}: ${container.name}`,
    };
  }

  if (
    container?.waitingReason === 'CrashLoopBackOff' ||
    (container?.lastTerminatedExitCode ?? 0) > 0 ||
    (container?.terminatedExitCode ?? 0) > 0
  ) {
    const exit =
      container?.lastTerminatedExitCode ?? container?.terminatedExitCode ?? null;
    return {
      kind: 'app_crash_loop',
      service: pod.service ?? pod.name,
      pod: pod.name,
      container: container?.name ?? 'main',
      exitCode: exit,
      message: `container ${container?.name ?? 'main'} exited ${exit ?? '?'} (reason: ${container?.lastTerminatedReason ?? container?.terminatedReason ?? container?.waitingReason ?? 'Error'})`,
    };
  }

  const notReady = snapshot.pods.filter((p) => !p.ready).map((p) => p.name);
  if (notReady.length > 0) {
    return {
      kind: 'readiness_timeout',
      notReady,
      message: `${notReady.length} pod(s) did not become ready: ${notReady.join(', ')}`,
    };
  }

  return null;
}

/**
 * Cap + lightly redact a previous-container log excerpt so it's safe to persist.
 */
export function redactExcerpt(
  lines: string[],
  opts: { maxLines?: number; secrets?: string[] } = {},
): string[] {
  const max = opts.maxLines ?? 20;
  const secretPatterns = [
    // Stripe-style keys: sk_live_xxxx, pk_test_xxxx, etc. The label after the
    // first underscore can itself contain alphanumerics and underscores.
    /\b(?:sk|pk|rk)_[a-z]+_[A-Za-z0-9_]{12,}/gi,
    // Generic prefix=<long token>: `token=...`, `key=...`, `password=...`
    /\b(?:api[_-]?key|auth[_-]?token|token|secret|password)\s*[:=]\s*[A-Za-z0-9._/+=-]{12,}/gi,
    /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
    /\b[A-Za-z0-9]{40,}\b/g, // long opaque tokens
  ];
  const additional = (opts.secrets ?? []).filter((s) => s.length >= 4);

  const trimmed = lines.slice(-max);
  return trimmed.map((line) => {
    let redacted = line;
    for (const p of secretPatterns) {
      redacted = redacted.replace(p, '[REDACTED]');
    }
    for (const s of additional) {
      redacted = redacted.split(s).join('[REDACTED]');
    }
    return redacted;
  });
}

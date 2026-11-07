import type * as k8s from '@kubernetes/client-node';
import type { Config } from '@eve/shared';

/**
 * Node placement applied to every app pod the deployer creates (Deployments
 * and service Jobs). Contract: docs/plans/app-compute-classes-plan.md.
 */
export interface AppPlacement {
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
}

export type AppPlacementConfig = Pick<
  Config,
  | 'EVE_COMPUTE_MODEL'
  | 'EVE_APP_PLACEMENT_ENABLED'
  | 'EVE_APP_NODE_SELECTOR_KEY'
  | 'EVE_APP_NODE_SELECTOR_VALUE'
  | 'EVE_APP_TAINT_KEY'
  | 'EVE_APP_TAINT_VALUE'
  | 'EVE_APP_TAINT_EFFECT'
>;

const MANAGED_COMPUTE_MODELS = new Set(['gke', 'eks', 'aks']);
const TAINT_EFFECTS = new Set(['NoSchedule', 'PreferNoSchedule', 'NoExecute']);

/**
 * Resolve the placement for app pods, with a warning for each setting that
 * could not be honoured. Placement applies only when EVE_APP_PLACEMENT_ENABLED
 * is true and the cluster is managed Kubernetes (gke, eks, aks).
 */
export function resolveAppPlacement(config: AppPlacementConfig): {
  placement: AppPlacement | null;
  warnings: string[];
} {
  if (!config.EVE_APP_PLACEMENT_ENABLED) {
    return { placement: null, warnings: [] };
  }
  if (!MANAGED_COMPUTE_MODELS.has(config.EVE_COMPUTE_MODEL)) {
    return {
      placement: null,
      warnings: [
        `EVE_APP_PLACEMENT_ENABLED is set but EVE_COMPUTE_MODEL=${config.EVE_COMPUTE_MODEL}; ` +
        'app placement applies only to gke, eks and aks. Scheduling app pods without it.',
      ],
    };
  }

  const warnings: string[] = [];
  const placement: AppPlacement = {};

  const selectorKey = config.EVE_APP_NODE_SELECTOR_KEY?.trim();
  const selectorValue = config.EVE_APP_NODE_SELECTOR_VALUE?.trim();
  if (selectorKey && selectorValue) {
    placement.nodeSelector = { [selectorKey]: selectorValue };
  } else {
    warnings.push(
      'App placement is enabled but EVE_APP_NODE_SELECTOR_KEY/EVE_APP_NODE_SELECTOR_VALUE are not both set; ' +
      'app pods are not pinned to a node pool.',
    );
  }

  const taintKey = config.EVE_APP_TAINT_KEY?.trim();
  if (taintKey) {
    const taintValue = config.EVE_APP_TAINT_VALUE?.trim();
    const effect = config.EVE_APP_TAINT_EFFECT?.trim() || 'NoSchedule';
    const toleration: k8s.V1Toleration = taintValue
      ? { key: taintKey, operator: 'Equal', value: taintValue }
      : { key: taintKey, operator: 'Exists' };
    if (TAINT_EFFECTS.has(effect)) {
      toleration.effect = effect;
    } else {
      // An empty effect tolerates every effect of the taint, which still lets
      // pods onto the pool instead of producing an invalid pod spec.
      warnings.push(
        `EVE_APP_TAINT_EFFECT=${effect} is not NoSchedule, PreferNoSchedule or NoExecute; ` +
        'tolerating every effect of the app taint.',
      );
    }
    placement.tolerations = [toleration];
  }

  return {
    placement: placement.nodeSelector || placement.tolerations ? placement : null,
    warnings,
  };
}

/** Merge placement into a pod spec, keeping whatever selector and tolerations it already has. */
export function applyAppPlacement(podSpec: k8s.V1PodSpec, placement: AppPlacement | null): void {
  if (!placement) return;
  if (placement.nodeSelector) {
    podSpec.nodeSelector = { ...(podSpec.nodeSelector ?? {}), ...placement.nodeSelector };
  }
  if (placement.tolerations) {
    podSpec.tolerations = [...(podSpec.tolerations ?? []), ...placement.tolerations];
  }
}

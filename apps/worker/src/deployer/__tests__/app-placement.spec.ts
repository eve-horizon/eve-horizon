import { describe, expect, it } from 'vitest';
import type * as k8s from '@kubernetes/client-node';
import { applyAppPlacement, resolveAppPlacement, type AppPlacementConfig } from '../app-placement.js';

const gkeTemplate: AppPlacementConfig = {
  EVE_COMPUTE_MODEL: 'gke',
  EVE_APP_PLACEMENT_ENABLED: true,
  EVE_APP_NODE_SELECTOR_KEY: 'pool',
  EVE_APP_NODE_SELECTOR_VALUE: 'apps',
  EVE_APP_TAINT_KEY: 'pool',
  EVE_APP_TAINT_VALUE: 'apps',
  EVE_APP_TAINT_EFFECT: 'NoSchedule',
};

describe('resolveAppPlacement', () => {
  it('pins pods to the app pool and tolerates its taint on managed Kubernetes', () => {
    expect(resolveAppPlacement(gkeTemplate)).toEqual({
      placement: {
        nodeSelector: { pool: 'apps' },
        tolerations: [{ key: 'pool', operator: 'Equal', value: 'apps', effect: 'NoSchedule' }],
      },
      warnings: [],
    });
  });

  it.each(['eks', 'aks'] as const)('applies on %s too', (model) => {
    expect(resolveAppPlacement({ ...gkeTemplate, EVE_COMPUTE_MODEL: model }).placement?.nodeSelector).toEqual({
      pool: 'apps',
    });
  });

  it('does nothing unless EVE_APP_PLACEMENT_ENABLED is set, even with every variable present', () => {
    expect(resolveAppPlacement({ ...gkeTemplate, EVE_APP_PLACEMENT_ENABLED: false })).toEqual({
      placement: null,
      warnings: [],
    });
  });

  it.each(['k3s', 'ecs'] as const)('does nothing on %s and says why', (model) => {
    const result = resolveAppPlacement({ ...gkeTemplate, EVE_COMPUTE_MODEL: model });
    expect(result.placement).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining(`EVE_COMPUTE_MODEL=${model}`)]);
  });

  it('warns and still tolerates the taint when the selector is incomplete', () => {
    const result = resolveAppPlacement({ ...gkeTemplate, EVE_APP_NODE_SELECTOR_VALUE: '  ' });
    expect(result.placement).toEqual({
      tolerations: [{ key: 'pool', operator: 'Equal', value: 'apps', effect: 'NoSchedule' }],
    });
    expect(result.warnings).toEqual([expect.stringContaining('not pinned to a node pool')]);
  });

  it('defaults the effect to NoSchedule and uses Exists for a taint without a value', () => {
    const result = resolveAppPlacement({
      ...gkeTemplate,
      EVE_APP_TAINT_VALUE: undefined,
      EVE_APP_TAINT_EFFECT: undefined,
    });
    expect(result.placement?.tolerations).toEqual([{ key: 'pool', operator: 'Exists', effect: 'NoSchedule' }]);
  });

  it('tolerates every effect, with a warning, when the effect is not a Kubernetes taint effect', () => {
    const result = resolveAppPlacement({ ...gkeTemplate, EVE_APP_TAINT_EFFECT: 'NO_SCHEDULE' });
    expect(result.placement?.tolerations).toEqual([{ key: 'pool', operator: 'Equal', value: 'apps' }]);
    expect(result.warnings).toEqual([expect.stringContaining('EVE_APP_TAINT_EFFECT=NO_SCHEDULE')]);
  });

  it('returns no placement when nothing is configured', () => {
    const result = resolveAppPlacement({ EVE_COMPUTE_MODEL: 'gke', EVE_APP_PLACEMENT_ENABLED: true });
    expect(result.placement).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
});

describe('applyAppPlacement', () => {
  it('merges into an existing selector and tolerations', () => {
    const podSpec: k8s.V1PodSpec = {
      containers: [],
      nodeSelector: { 'kubernetes.io/arch': 'amd64' },
      tolerations: [{ key: 'other', operator: 'Exists' }],
    };
    applyAppPlacement(podSpec, resolveAppPlacement(gkeTemplate).placement);
    expect(podSpec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'amd64', pool: 'apps' });
    expect(podSpec.tolerations).toEqual([
      { key: 'other', operator: 'Exists' },
      { key: 'pool', operator: 'Equal', value: 'apps', effect: 'NoSchedule' },
    ]);
  });

  it('leaves the pod spec untouched without placement', () => {
    const podSpec: k8s.V1PodSpec = { containers: [] };
    applyAppPlacement(podSpec, null);
    expect(podSpec).toEqual({ containers: [] });
  });
});

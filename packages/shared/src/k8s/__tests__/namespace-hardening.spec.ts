import { describe, expect, it } from 'vitest';
import {
  generateResourceQuota,
  generateLimitRange,
  generateNetworkPolicy,
  generateAllHardeningManifests,
  mergeHardeningConfig,
  DEFAULT_HARDENING_CONFIG,
  type NamespaceHardeningConfig,
} from '../namespace-hardening.js';
import {
  prepareHardeningManifests,
  parseHardeningSettingValue,
} from '../apply-hardening.js';

// ---------------------------------------------------------------------------
// generateResourceQuota
// ---------------------------------------------------------------------------

describe('generateResourceQuota', () => {
  it('produces a valid ResourceQuota with defaults', () => {
    const quota = generateResourceQuota({ namespace: 'eve-org-proj-test' }) as Record<string, unknown>;

    expect(quota.apiVersion).toBe('v1');
    expect(quota.kind).toBe('ResourceQuota');

    const metadata = quota.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('eve-env-quota');
    expect(metadata.namespace).toBe('eve-org-proj-test');
    expect((metadata.labels as Record<string, string>)['app.kubernetes.io/managed-by']).toBe('eve-horizon');

    const hard = (quota.spec as Record<string, unknown>).hard as Record<string, string>;
    expect(hard['requests.cpu']).toBe('4');
    expect(hard['requests.memory']).toBe('8Gi');
    expect(hard.persistentvolumeclaims).toBe('10');
    expect(hard['requests.storage']).toBe('50Gi');
  });

  it('uses custom quota values when provided', () => {
    const config: NamespaceHardeningConfig = {
      namespace: 'custom-ns',
      resource_quota: {
        cpu_requests: '8',
        memory_requests: '16Gi',
        pvcs: '20',
        storage: '100Gi',
      },
    };

    const quota = generateResourceQuota(config) as Record<string, unknown>;
    const hard = (quota.spec as Record<string, unknown>).hard as Record<string, string>;

    expect(hard['requests.cpu']).toBe('8');
    expect(hard['requests.memory']).toBe('16Gi');
    expect(hard.persistentvolumeclaims).toBe('20');
    expect(hard['requests.storage']).toBe('100Gi');
  });
});

// ---------------------------------------------------------------------------
// generateLimitRange
// ---------------------------------------------------------------------------

describe('generateLimitRange', () => {
  it('produces a valid LimitRange with defaults', () => {
    const lr = generateLimitRange({ namespace: 'eve-org-proj-test' }) as Record<string, unknown>;

    expect(lr.apiVersion).toBe('v1');
    expect(lr.kind).toBe('LimitRange');

    const metadata = lr.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('eve-env-limits');
    expect(metadata.namespace).toBe('eve-org-proj-test');

    const limits = (lr.spec as Record<string, unknown>).limits as Array<Record<string, unknown>>;
    expect(limits).toHaveLength(1);
    expect(limits[0].type).toBe('Container');

    const defaultRequest = limits[0].defaultRequest as Record<string, string>;
    expect(defaultRequest.cpu).toBe('100m');
    expect(defaultRequest.memory).toBe('256Mi');

    const defaultLimits = limits[0].default as Record<string, string>;
    expect(defaultLimits.cpu).toBe('500m');
    expect(defaultLimits.memory).toBe('512Mi');
  });

  it('uses custom limit values when provided', () => {
    const config: NamespaceHardeningConfig = {
      namespace: 'custom-ns',
      limit_range: {
        default_cpu_request: '200m',
        default_memory_request: '512Mi',
        default_cpu_limit: '1',
        default_memory_limit: '1Gi',
      },
    };

    const lr = generateLimitRange(config) as Record<string, unknown>;
    const limits = (lr.spec as Record<string, unknown>).limits as Array<Record<string, unknown>>;
    const defaultRequest = limits[0].defaultRequest as Record<string, string>;
    const defaultLimits = limits[0].default as Record<string, string>;

    expect(defaultRequest.cpu).toBe('200m');
    expect(defaultRequest.memory).toBe('512Mi');
    expect(defaultLimits.cpu).toBe('1');
    expect(defaultLimits.memory).toBe('1Gi');
  });
});

// ---------------------------------------------------------------------------
// generateNetworkPolicy
// ---------------------------------------------------------------------------

describe('generateNetworkPolicy', () => {
  it('produces a valid NetworkPolicy with default-deny base', () => {
    const np = generateNetworkPolicy({ namespace: 'eve-org-proj-test' }) as Record<string, unknown>;

    expect(np.apiVersion).toBe('networking.k8s.io/v1');
    expect(np.kind).toBe('NetworkPolicy');

    const metadata = np.metadata as Record<string, unknown>;
    expect(metadata.name).toBe('eve-default-deny');
    expect(metadata.namespace).toBe('eve-org-proj-test');

    const spec = np.spec as Record<string, unknown>;
    expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);

    // podSelector should be empty (applies to all pods)
    expect(spec.podSelector).toEqual({});
  });

  it('includes in-namespace ingress and ingress-nginx by default', () => {
    const np = generateNetworkPolicy({ namespace: 'eve-org-proj-test' }) as Record<string, unknown>;
    const spec = np.spec as Record<string, unknown>;
    const ingress = spec.ingress as Array<Record<string, unknown>>;

    // First rule: in-namespace traffic
    const inNsRule = ingress[0];
    expect(inNsRule.from).toEqual([{ podSelector: {} }]);

    // Second rule: ingress-nginx
    const ingressNginxRule = ingress[1];
    expect(ingressNginxRule.from).toEqual([
      {
        namespaceSelector: {
          matchLabels: {
            'kubernetes.io/metadata.name': 'ingress-nginx',
          },
        },
      },
    ]);
  });

  it('includes DNS, in-namespace, eve, kube-system, and external egress by default', () => {
    const np = generateNetworkPolicy({ namespace: 'eve-org-proj-test' }) as Record<string, unknown>;
    const spec = np.spec as Record<string, unknown>;
    const egress = spec.egress as Array<Record<string, unknown>>;

    // Should have: DNS, in-namespace, eve, kube-system, external CIDRs
    expect(egress.length).toBeGreaterThanOrEqual(4);

    // First rule: DNS (kube-system port 53)
    const dnsRule = egress[0];
    expect(dnsRule.ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);

    // Second rule: in-namespace
    const inNsRule = egress[1];
    expect(inNsRule.to).toEqual([{ podSelector: {} }]);
  });

  it('uses custom network policy when provided', () => {
    const config: NamespaceHardeningConfig = {
      namespace: 'custom-ns',
      network_policy: {
        allow_ingress_from_namespaces: ['my-ingress'],
        allow_egress_to_namespaces: ['my-platform'],
        allow_egress_cidrs: ['10.0.0.0/8'],
      },
    };

    const np = generateNetworkPolicy(config) as Record<string, unknown>;
    const spec = np.spec as Record<string, unknown>;
    const ingress = spec.ingress as Array<Record<string, unknown>>;
    const egress = spec.egress as Array<Record<string, unknown>>;

    // Should have my-ingress in ingress rules
    const ingressNs = ingress.find((rule) => {
      const from = rule.from as Array<Record<string, unknown>>;
      return from?.some(
        (f) => (f.namespaceSelector as Record<string, unknown>)?.matchLabels != null &&
          ((f.namespaceSelector as Record<string, unknown>).matchLabels as Record<string, string>)['kubernetes.io/metadata.name'] === 'my-ingress'
      );
    });
    expect(ingressNs).toBeDefined();

    // Should have my-platform in egress rules
    const egressNs = egress.find((rule) => {
      const to = rule.to as Array<Record<string, unknown>>;
      return to?.some(
        (t) => (t.namespaceSelector as Record<string, unknown>)?.matchLabels != null &&
          ((t.namespaceSelector as Record<string, unknown>).matchLabels as Record<string, string>)['kubernetes.io/metadata.name'] === 'my-platform'
      );
    });
    expect(egressNs).toBeDefined();

    // Should have 10.0.0.0/8 in egress CIDRs
    const egressCidr = egress.find((rule) => {
      const to = rule.to as Array<Record<string, unknown>>;
      return to?.some((t) => (t as Record<string, unknown>).ipBlock != null);
    });
    expect(egressCidr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generateAllHardeningManifests
// ---------------------------------------------------------------------------

describe('generateAllHardeningManifests', () => {
  it('returns exactly three manifests', () => {
    const manifests = generateAllHardeningManifests({ namespace: 'test-ns' });
    expect(manifests).toHaveLength(3);

    const kinds = manifests.map((m) => (m as Record<string, unknown>).kind);
    expect(kinds).toEqual(['ResourceQuota', 'LimitRange', 'NetworkPolicy']);
  });

  it('all manifests target the same namespace', () => {
    const manifests = generateAllHardeningManifests({ namespace: 'my-ns' });
    for (const manifest of manifests) {
      const metadata = (manifest as Record<string, unknown>).metadata as Record<string, unknown>;
      expect(metadata.namespace).toBe('my-ns');
    }
  });
});

// ---------------------------------------------------------------------------
// mergeHardeningConfig
// ---------------------------------------------------------------------------

describe('mergeHardeningConfig', () => {
  it('uses all defaults when no overrides provided', () => {
    const config = mergeHardeningConfig('test-ns');
    expect(config.namespace).toBe('test-ns');
    expect(config.resource_quota).toEqual(DEFAULT_HARDENING_CONFIG.resource_quota);
    expect(config.limit_range).toEqual(DEFAULT_HARDENING_CONFIG.limit_range);
    expect(config.network_policy).toEqual(DEFAULT_HARDENING_CONFIG.network_policy);
  });

  it('overrides only the specified sections', () => {
    const config = mergeHardeningConfig('test-ns', {
      resource_quota: {
        cpu_requests: '16',
        memory_requests: '32Gi',
        pvcs: '50',
        storage: '200Gi',
      },
    });
    expect(config.resource_quota!.cpu_requests).toBe('16');
    expect(config.limit_range).toEqual(DEFAULT_HARDENING_CONFIG.limit_range);
    expect(config.network_policy).toEqual(DEFAULT_HARDENING_CONFIG.network_policy);
  });
});

// ---------------------------------------------------------------------------
// prepareHardeningManifests
// ---------------------------------------------------------------------------

describe('prepareHardeningManifests', () => {
  it('returns manifests and resolved config', () => {
    const result = prepareHardeningManifests('my-ns');
    expect(result.namespace).toBe('my-ns');
    expect(result.manifests).toHaveLength(3);
    expect(result.config.namespace).toBe('my-ns');
    expect(result.config.resource_quota).toEqual(DEFAULT_HARDENING_CONFIG.resource_quota);
  });

  it('applies overrides from system settings', () => {
    const result = prepareHardeningManifests('my-ns', {
      resource_quota: {
        cpu_requests: '2',
        memory_requests: '4Gi',
        pvcs: '5',
        storage: '25Gi',
      },
    });

    const quota = result.manifests[0] as Record<string, unknown>;
    const hard = (quota.spec as Record<string, unknown>).hard as Record<string, string>;
    expect(hard['requests.cpu']).toBe('2');
    expect(hard['requests.memory']).toBe('4Gi');
  });
});

// ---------------------------------------------------------------------------
// parseHardeningSettingValue
// ---------------------------------------------------------------------------

describe('parseHardeningSettingValue', () => {
  it('parses valid JSON into a partial config', () => {
    const value = JSON.stringify({
      resource_quota: { cpu_requests: '8', memory_requests: '16Gi', pvcs: '20', storage: '100Gi' },
    });
    const result = parseHardeningSettingValue(value);
    expect(result).toBeDefined();
    expect(result!.resource_quota!.cpu_requests).toBe('8');
  });

  it('returns undefined for null/empty input', () => {
    expect(parseHardeningSettingValue(null)).toBeUndefined();
    expect(parseHardeningSettingValue(undefined)).toBeUndefined();
    expect(parseHardeningSettingValue('')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseHardeningSettingValue('not-json')).toBeUndefined();
  });

  it('returns undefined for non-object JSON', () => {
    expect(parseHardeningSettingValue('"string"')).toBeUndefined();
    expect(parseHardeningSettingValue('42')).toBeUndefined();
    expect(parseHardeningSettingValue('[1,2,3]')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip (ensure kubectl-ready)
// ---------------------------------------------------------------------------

describe('kubectl serialization', () => {
  it('all manifests serialize to valid JSON', () => {
    const manifests = generateAllHardeningManifests({ namespace: 'eve-org-proj-prod' });
    for (const manifest of manifests) {
      const json = JSON.stringify(manifest);
      const parsed = JSON.parse(json);
      expect(parsed.metadata.namespace).toBe('eve-org-proj-prod');
    }
  });
});

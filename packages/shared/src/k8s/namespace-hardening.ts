/**
 * Namespace Hardening — Phase 10
 *
 * Pure functions that generate K8s manifest objects for environment namespace
 * hardening: ResourceQuota, LimitRange, and NetworkPolicy.
 *
 * These are plain JS objects that can be serialized to JSON and applied via
 * `kubectl apply -f -` or any K8s client library.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NamespaceHardeningConfig {
  namespace: string;
  resource_quota?: {
    cpu_requests: string;        // e.g. "4"
    memory_requests: string;     // e.g. "8Gi"
    pvcs: string;                // e.g. "10"
    storage: string;             // e.g. "50Gi"
  };
  limit_range?: {
    default_cpu_request: string; // e.g. "100m"
    default_memory_request: string; // e.g. "256Mi"
    default_cpu_limit: string;   // e.g. "500m"
    default_memory_limit: string;// e.g. "512Mi"
  };
  network_policy?: {
    allow_ingress_from_namespaces?: string[];  // e.g. ["ingress-nginx"]
    allow_egress_to_namespaces?: string[];     // e.g. ["eve", "kube-system"]
    allow_egress_cidrs?: string[];             // e.g. ["0.0.0.0/0"]
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default hardening config for standard environments.
 * Omits `namespace` — the caller supplies that.
 */
export const DEFAULT_HARDENING_CONFIG: Omit<NamespaceHardeningConfig, 'namespace'> = {
  resource_quota: {
    cpu_requests: '4',
    memory_requests: '8Gi',
    pvcs: '10',
    storage: '50Gi',
  },
  limit_range: {
    default_cpu_request: '100m',
    default_memory_request: '256Mi',
    default_cpu_limit: '500m',
    default_memory_limit: '512Mi',
  },
  network_policy: {
    allow_ingress_from_namespaces: ['ingress-nginx'],
    allow_egress_to_namespaces: ['eve', 'kube-system'],
    allow_egress_cidrs: ['0.0.0.0/0'],
  },
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate a ResourceQuota manifest for the given namespace.
 * Caps aggregate CPU, memory, PVC count, and storage across all pods.
 */
export function generateResourceQuota(config: NamespaceHardeningConfig): object {
  const quota = config.resource_quota ?? DEFAULT_HARDENING_CONFIG.resource_quota!;

  return {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: 'eve-env-quota',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'eve-horizon',
        'eve.component': 'namespace-hardening',
      },
    },
    spec: {
      hard: {
        'requests.cpu': quota.cpu_requests,
        'requests.memory': quota.memory_requests,
        persistentvolumeclaims: quota.pvcs,
        'requests.storage': quota.storage,
      },
    },
  };
}

/**
 * Generate a LimitRange manifest for the given namespace.
 * Sets default resource requests and limits for containers that don't
 * declare their own, preventing unbounded resource consumption.
 */
export function generateLimitRange(config: NamespaceHardeningConfig): object {
  const limits = config.limit_range ?? DEFAULT_HARDENING_CONFIG.limit_range!;

  return {
    apiVersion: 'v1',
    kind: 'LimitRange',
    metadata: {
      name: 'eve-env-limits',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'eve-horizon',
        'eve.component': 'namespace-hardening',
      },
    },
    spec: {
      limits: [
        {
          type: 'Container',
          defaultRequest: {
            cpu: limits.default_cpu_request,
            memory: limits.default_memory_request,
          },
          default: {
            cpu: limits.default_cpu_limit,
            memory: limits.default_memory_limit,
          },
        },
      ],
    },
  };
}

/**
 * Generate a NetworkPolicy manifest for the given namespace.
 *
 * Strategy: default-deny all ingress and egress, then poke explicit holes:
 *   - Ingress: from namespaces in the allow list (e.g. ingress-nginx)
 *     plus in-namespace traffic (pods talking to each other).
 *   - Egress: to namespaces in the allow list (e.g. eve, kube-system)
 *     plus specified external CIDRs, plus DNS (kube-system port 53).
 */
export function generateNetworkPolicy(config: NamespaceHardeningConfig): object {
  const netpol = config.network_policy ?? DEFAULT_HARDENING_CONFIG.network_policy!;

  // Build ingress rules
  const ingressRules: object[] = [];

  // Allow in-namespace traffic (pods within the same namespace)
  ingressRules.push({
    from: [
      {
        podSelector: {},  // all pods in same namespace
      },
    ],
  });

  // Allow from specified namespaces (e.g. ingress-nginx)
  if (netpol.allow_ingress_from_namespaces && netpol.allow_ingress_from_namespaces.length > 0) {
    for (const ns of netpol.allow_ingress_from_namespaces) {
      ingressRules.push({
        from: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': ns,
              },
            },
          },
        ],
      });
    }
  }

  // Build egress rules
  const egressRules: object[] = [];

  // Allow DNS resolution (always needed — UDP + TCP port 53 to kube-system)
  egressRules.push({
    to: [
      {
        namespaceSelector: {
          matchLabels: {
            'kubernetes.io/metadata.name': 'kube-system',
          },
        },
      },
    ],
    ports: [
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ],
  });

  // Allow in-namespace traffic
  egressRules.push({
    to: [
      {
        podSelector: {},  // all pods in same namespace
      },
    ],
  });

  // Allow to specified namespaces
  if (netpol.allow_egress_to_namespaces && netpol.allow_egress_to_namespaces.length > 0) {
    for (const ns of netpol.allow_egress_to_namespaces) {
      // Skip kube-system here since DNS rule already covers it with port restriction
      // but we add a full-access rule for other namespaces and kube-system non-DNS
      egressRules.push({
        to: [
          {
            namespaceSelector: {
              matchLabels: {
                'kubernetes.io/metadata.name': ns,
              },
            },
          },
        ],
      });
    }
  }

  // Allow egress to external CIDRs
  if (netpol.allow_egress_cidrs && netpol.allow_egress_cidrs.length > 0) {
    egressRules.push({
      to: netpol.allow_egress_cidrs.map((cidr) => ({
        ipBlock: { cidr },
      })),
    });
  }

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: 'eve-default-deny',
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'eve-horizon',
        'eve.component': 'namespace-hardening',
      },
    },
    spec: {
      podSelector: {},  // applies to all pods in namespace
      policyTypes: ['Ingress', 'Egress'],
      ingress: ingressRules,
      egress: egressRules,
    },
  };
}

/**
 * Generate all hardening manifests for a namespace.
 * Returns an array of K8s manifest objects ready for kubectl apply.
 */
export function generateAllHardeningManifests(config: NamespaceHardeningConfig): object[] {
  return [
    generateResourceQuota(config),
    generateLimitRange(config),
    generateNetworkPolicy(config),
  ];
}

/**
 * Merge a partial hardening config (e.g. from system_settings) with defaults.
 * The `namespace` must always be provided explicitly.
 */
export function mergeHardeningConfig(
  namespace: string,
  overrides?: Partial<Omit<NamespaceHardeningConfig, 'namespace'>>,
): NamespaceHardeningConfig {
  return {
    namespace,
    resource_quota: overrides?.resource_quota ?? DEFAULT_HARDENING_CONFIG.resource_quota,
    limit_range: overrides?.limit_range ?? DEFAULT_HARDENING_CONFIG.limit_range,
    network_policy: overrides?.network_policy ?? DEFAULT_HARDENING_CONFIG.network_policy,
  };
}

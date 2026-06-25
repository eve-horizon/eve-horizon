export type ResourceClassK8sSpecV1 = {
  cpu_request: string;
  cpu_limit: string;
  mem_request: string;
  mem_limit: string;
};

export type ResourceClassSpecV1 = {
  vcpu: number;
  memory_gib: number;
  k8s?: ResourceClassK8sSpecV1;
};

export type ResourceClassesV1 = Record<string, ResourceClassSpecV1>;

export const DEFAULT_RESOURCE_CLASS_NAME = 'job.c1';

export const DEFAULT_RESOURCE_CLASSES_V1: ResourceClassesV1 = {
  'job.c1': {
    vcpu: 1,
    memory_gib: 2,
    k8s: { cpu_request: '1', cpu_limit: '2', mem_request: '2Gi', mem_limit: '4Gi' },
  },
  'job.c2': {
    vcpu: 2,
    memory_gib: 4,
    k8s: { cpu_request: '2', cpu_limit: '4', mem_request: '4Gi', mem_limit: '8Gi' },
  },
};

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
}

export function parseResourceClassesV1(value: string | null | undefined): ResourceClassesV1 | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const out: ResourceClassesV1 = {};
    for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const obj = raw as Record<string, unknown>;
      const vcpu = readPositiveNumber(obj.vcpu);
      const memoryGib = readPositiveNumber(obj.memory_gib);
      if (!vcpu || !memoryGib) continue;

      let k8s: ResourceClassK8sSpecV1 | undefined;
      const rawK8s = obj.k8s;
      if (rawK8s && typeof rawK8s === 'object' && !Array.isArray(rawK8s)) {
        const k8sObj = rawK8s as Record<string, unknown>;
        const cpuRequest = readString(k8sObj.cpu_request);
        const cpuLimit = readString(k8sObj.cpu_limit);
        const memRequest = readString(k8sObj.mem_request);
        const memLimit = readString(k8sObj.mem_limit);
        if (cpuRequest && cpuLimit && memRequest && memLimit) {
          k8s = {
            cpu_request: cpuRequest,
            cpu_limit: cpuLimit,
            mem_request: memRequest,
            mem_limit: memLimit,
          };
        }
      }

      out[name] = { vcpu, memory_gib: memoryGib, ...(k8s ? { k8s } : {}) };
    }

    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function resolveResourceClassName(input: {
  job_hints?: Record<string, unknown> | null;
  manifest_defaults?: Record<string, unknown> | null;
  fallback?: string | null;
}): string | null {
  const fromHints = input.job_hints?.resource_class;
  if (typeof fromHints === 'string' && fromHints.trim()) return fromHints.trim();

  const fromManifest = input.manifest_defaults?.resource_class;
  if (typeof fromManifest === 'string' && fromManifest.trim()) return fromManifest.trim();

  const fallback = input.fallback ?? null;
  return fallback && fallback.trim() ? fallback.trim() : null;
}

export function getResourceClassSpec(
  resourceClasses: ResourceClassesV1 | null,
  name: string | null,
): ResourceClassSpecV1 | null {
  if (!resourceClasses || !name) return null;
  return resourceClasses[name] ?? null;
}


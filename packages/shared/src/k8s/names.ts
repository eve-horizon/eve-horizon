/**
 * Canonical Kubernetes name derivation for platform-managed resources.
 *
 * These are the single source of truth for how org/project/environment slugs
 * become namespaces, resource names, and label values. The deployer creates
 * cluster objects with these names; every other service (API diagnostics,
 * logs, env-db host resolution, executors) must derive the SAME names or
 * lookups silently miss. Do not fork these — import them.
 */

/**
 * Normalize a value into a valid RFC-1123 k8s object name: lowercase
 * alphanumerics and dashes, no leading/trailing/repeated dashes, max 63 chars.
 * Throws when nothing valid remains.
 */
export function toK8sName(value: string, label: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/--+/g, '-');

  if (!normalized) {
    throw new Error(`Invalid ${label} name: ${value}`);
  }

  return normalized.length > 63 ? normalized.slice(0, 63).replace(/-+$/, '') : normalized;
}

/**
 * Normalize a value into a valid k8s label value: lowercase alphanumerics,
 * dashes, underscores and dots; must start/end alphanumeric; max 63 chars.
 */
export function toK8sLabelValue(value: string, label: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .replace(/-+$/, '');

  if (!normalized) {
    throw new Error(`Invalid ${label} label value: ${value}`);
  }

  return normalized.length > 63 ? normalized.slice(0, 63).replace(/[-_.]+$/, '') : normalized;
}

/**
 * Join an environment slug and component slug into a resource name,
 * trimming both sides when the combination would exceed 63 chars.
 */
export function combineK8sName(envSlug: string, componentSlug: string, label: string): string {
  const combined = `${envSlug}-${componentSlug}`;
  if (combined.length <= 63) {
    return combined;
  }

  const maxEnv = 31;
  const maxComponent = 31;
  const trimmedEnv = envSlug.slice(0, maxEnv).replace(/-+$/, '');
  const trimmedComponent = componentSlug.slice(0, maxComponent).replace(/-+$/, '');
  const trimmed = `${trimmedEnv}-${trimmedComponent}`.replace(/-+$/, '');

  if (!trimmed) {
    throw new Error(`Invalid ${label} name from ${envSlug}-${componentSlug}`);
  }

  return trimmed;
}

/**
 * Append a normalized suffix to a base name, trimming the base so the
 * result stays within 63 chars.
 */
export function appendK8sSuffix(base: string, suffix: string, label: string): string {
  const normalizedSuffix = toK8sName(suffix, label);
  const reserved = normalizedSuffix.length + 1;
  const maxBaseLength = 63 - reserved;
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/, '');
  const combined = `${trimmedBase}-${normalizedSuffix}`;
  if (!trimmedBase || combined.length > 63) {
    throw new Error(`Invalid ${label} name from ${base}-${suffix}`);
  }
  return combined;
}

/**
 * Derive the namespace for a project environment. A stored namespace (the
 * `environments.namespace` column) wins when present; both paths are
 * sanitized so a previously-stored mixed-case value can never diverge from
 * what the cluster actually holds.
 */
export function deriveNamespace(
  orgSlug: string,
  projectSlug: string,
  envName: string,
  storedNamespace?: string | null,
): string {
  if (storedNamespace) {
    return toK8sName(storedNamespace, 'namespace');
  }
  return toK8sName(`eve-${orgSlug}-${projectSlug}-${envName}`, 'namespace');
}

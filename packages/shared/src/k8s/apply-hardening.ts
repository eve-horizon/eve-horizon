/**
 * Hardening Application Service — Phase 10
 *
 * Takes a namespace name and optional hardening config overrides,
 * resolves the final config (merging defaults with system_settings overrides),
 * and returns the manifests as JSON objects ready for kubectl apply.
 *
 * The actual kubectl apply is the caller's responsibility (worker/deployer).
 */

import {
  type NamespaceHardeningConfig,
  generateAllHardeningManifests,
  mergeHardeningConfig,
} from './namespace-hardening.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HardeningResult {
  namespace: string;
  manifests: object[];
  config: NamespaceHardeningConfig;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prepare hardening manifests for a namespace.
 *
 * @param namespace  The K8s namespace to harden.
 * @param overrides  Optional partial config from system_settings or org-level overrides.
 *                   Any field not provided falls back to DEFAULT_HARDENING_CONFIG.
 * @returns          The resolved config and the K8s manifest objects.
 */
export function prepareHardeningManifests(
  namespace: string,
  overrides?: Partial<Omit<NamespaceHardeningConfig, 'namespace'>>,
): HardeningResult {
  const config = mergeHardeningConfig(namespace, overrides);
  const manifests = generateAllHardeningManifests(config);

  return {
    namespace,
    manifests,
    config,
  };
}

/**
 * Parse the `namespace_hardening` system setting value (JSON string)
 * into a partial config suitable for passing to `prepareHardeningManifests`.
 *
 * Returns undefined if the value is null/undefined/empty or invalid JSON.
 */
export function parseHardeningSettingValue(
  value: string | null | undefined,
): Partial<Omit<NamespaceHardeningConfig, 'namespace'>> | undefined {
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Partial<Omit<NamespaceHardeningConfig, 'namespace'>>;
  } catch {
    return undefined;
  }
}

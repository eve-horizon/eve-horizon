// ---------------------------------------------------------------------------
// Placement — select the best instance for a new tenant
// ---------------------------------------------------------------------------

export interface PlacementResult {
  instanceId: string;
  score: number;
  tenantCount: number;
}

export interface PlacementInput {
  dbClass: string;
  instances: Array<{
    id: string;
    status: string;
    instance_class: string;
    capacity_json: Record<string, unknown> | null;
  }>;
  tenantCounts: Map<string, number>;
}

/**
 * Select the best (least-loaded) instance for tenant placement.
 *
 * Scoring:
 *   - Each instance is scored by its current active tenant count (lower is better).
 *   - Instances at capacity (determined by `capacity_json.max_tenants`) are excluded.
 *   - Only instances with status `available` and matching `instance_class` are considered.
 *   - Ties are broken deterministically by instance ID (lexicographic ascending).
 *
 * Returns `null` when no eligible instance exists.
 */
export function selectBestInstance(input: PlacementInput): PlacementResult | null {
  const { dbClass, instances, tenantCounts } = input;

  const candidates: PlacementResult[] = [];

  for (const inst of instances) {
    // Only consider available instances of the requested class
    if (inst.status !== 'available' || inst.instance_class !== dbClass) {
      continue;
    }

    const tenantCount = tenantCounts.get(inst.id) ?? 0;

    // Check capacity limit from capacity_json if present
    const maxTenants =
      inst.capacity_json &&
      typeof inst.capacity_json.max_tenants === 'number'
        ? inst.capacity_json.max_tenants
        : null;

    if (maxTenants !== null && tenantCount >= maxTenants) {
      continue; // Instance is at capacity
    }

    candidates.push({
      instanceId: inst.id,
      score: tenantCount,
      tenantCount,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort by score (ascending), then by instance ID for deterministic tie-breaking
  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.instanceId.localeCompare(b.instanceId);
  });

  return candidates[0];
}

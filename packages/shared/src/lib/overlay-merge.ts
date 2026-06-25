/**
 * RFC 7396-inspired deep-merge for Eve AgentPack config overlays.
 *
 * Rules:
 * - null in overlay = remove key from base
 * - both objects: recurse (deep-merge)
 * - otherwise: overlay replaces base
 *
 * Extensions:
 * - Routes (list-with-ID): upsert by `id`, support `_remove: true`
 */

// --- Core deep-merge ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge two values following RFC 7396 semantics.
 * - null in overlay removes the key
 * - objects are recursively merged
 * - all other types: overlay replaces base
 */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null) return undefined;

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null) {
        delete result[key];
      } else if (key in result) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return overlay;
}

// --- Map-keyed config merge (agents.yaml, teams.yaml) ---

interface VersionedMap {
  version?: number;
  [key: string]: unknown;
}

/**
 * Merge two map-keyed configs (agents.yaml or teams.yaml).
 * The map key (e.g. agent ID) determines which entries get merged/removed/added.
 */
export function mergeMapConfig(base: VersionedMap, overlay: VersionedMap): VersionedMap {
  const baseMap = extractMap(base);
  const overlayMap = extractMap(overlay);
  const merged = deepMerge(baseMap, overlayMap) as Record<string, unknown> | undefined;

  return {
    version: overlay.version ?? base.version,
    ...(merged ?? {}),
  };
}

/**
 * Extract the map portion from a versioned config (strip `version` key).
 */
function extractMap(config: VersionedMap): Record<string, unknown> {
  const { version: _, ...rest } = config;
  return rest;
}

// --- Route merge (list-with-ID, upsert by id) ---

interface Route {
  id: string;
  _remove?: boolean;
  [key: string]: unknown;
}

/**
 * Merge routes using id-based upsert.
 * - Matching id: deep-merge the route entry
 * - `_remove: true`: delete the route
 * - New id: append to list
 */
export function mergeRoutes(base: Route[], overlay: Route[]): Route[] {
  const result = new Map<string, Route>(base.map((r) => [r.id, r]));

  for (const route of overlay) {
    if (route._remove) {
      result.delete(route.id);
    } else if (result.has(route.id)) {
      const merged = deepMerge(result.get(route.id), route) as Route;
      result.set(route.id, merged);
    } else {
      result.set(route.id, route);
    }
  }

  return Array.from(result.values());
}

// --- Chat config merge ---

interface ChatConfig {
  routes?: Route[];
  [key: string]: unknown;
}

/**
 * Merge chat configs. Routes use id-based upsert; everything else deep-merges.
 */
export function mergeChatConfig(base: ChatConfig, overlay: ChatConfig): ChatConfig {
  const baseRoutes = base.routes ?? [];
  const overlayRoutes = overlay.routes ?? [];

  // Deep-merge everything except routes
  const { routes: _br, ...baseRest } = base;
  const { routes: _or, ...overlayRest } = overlay;
  const merged = deepMerge(baseRest, overlayRest) as Record<string, unknown>;

  return {
    ...merged,
    routes: mergeRoutes(baseRoutes, overlayRoutes),
  };
}

// --- x-eve merge (pure deep-merge in listed order) ---

/**
 * Merge x-eve config fragments from packs, then project overlay on top.
 * Packs are merged in listed order; project always wins.
 */
export function mergeXEve(
  packFragments: Record<string, unknown>[],
  projectXEve: Record<string, unknown>,
): Record<string, unknown> {
  let result: unknown = {};
  for (const fragment of packFragments) {
    result = deepMerge(result, fragment);
  }
  result = deepMerge(result, projectXEve);
  return (result as Record<string, unknown>) ?? {};
}

// --- Full config merge pipeline ---

export interface MergeInput {
  agents: VersionedMap;
  teams: VersionedMap;
  chat: ChatConfig;
  xEve: Record<string, unknown>;
}

/**
 * Merge a base config with an overlay (pack + project).
 * Used in the full resolution pipeline.
 */
export function mergeConfigs(base: MergeInput, overlay: Partial<MergeInput>): MergeInput {
  return {
    agents: overlay.agents ? mergeMapConfig(base.agents, overlay.agents) : base.agents,
    teams: overlay.teams ? mergeMapConfig(base.teams, overlay.teams) : base.teams,
    chat: overlay.chat ? mergeChatConfig(base.chat, overlay.chat) : base.chat,
    xEve: overlay.xEve ? (deepMerge(base.xEve, overlay.xEve) as Record<string, unknown>) : base.xEve,
  };
}

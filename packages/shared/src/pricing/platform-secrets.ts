/**
 * Platform Secrets Resolver
 *
 * Platform secrets are stored in the `system_settings` table under the key
 * `platform_secrets` as a flat JSON object:
 *
 *   { "gmicloud.api_key": "sk-...", "together.api_key": "..." }
 *
 * Secret refs use the `platform.` prefix as a namespace marker:
 *
 *   "platform.gmicloud.api_key"  ->  looks up "gmicloud.api_key"
 *
 * This module is intentionally dependency-light - it takes a `db` parameter
 * that provides a minimal settings-lookup interface, so it can be used
 * from both the worker and the API without importing @eve/db.
 */

/**
 * Minimal DB interface for platform secret resolution.
 * Wrapping code provides the implementation (typically via systemSettingsQueries).
 */
export interface PlatformSecretDb {
  getSystemSetting(key: string): Promise<{ value: string } | null>;
}

/**
 * Resolve a platform secret reference to its value.
 *
 * @param db  - Object with a `getSystemSetting` method
 * @param ref - Secret reference, e.g. "platform.gmicloud.api_key"
 * @returns   The secret value, or null if not found or unparseable
 */
export async function resolvePlatformSecret(
  db: PlatformSecretDb,
  ref: string,
): Promise<string | null> {
  // Strip 'platform.' prefix if present
  const key = ref.startsWith('platform.') ? ref.slice('platform.'.length) : ref;

  const setting = await db.getSystemSetting('platform_secrets');
  if (!setting) return null;

  try {
    const secrets = JSON.parse(setting.value) as Record<string, string>;
    return secrets[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a managed model secret reference.
 *
 * Platform-scoped refs (prefixed with `platform.`) resolve from system_settings.
 * All other refs resolve from the cascaded env (org/project/user secrets
 * that are already materialized by the time managed model resolution runs).
 *
 * @param ref          - Secret reference, e.g. "platform.gmicloud.api_key" or "GMICLOUD_API_KEY"
 * @param platformDb   - DB interface for platform secret resolution
 * @param cascadedEnv  - Materialized org/project/user secrets as env vars
 * @returns            The secret value, or null if not found
 */
export async function resolveManagedSecret(
  ref: string,
  platformDb: PlatformSecretDb,
  cascadedEnv?: Record<string, string | undefined>,
): Promise<string | null> {
  if (ref.startsWith('platform.')) {
    return resolvePlatformSecret(platformDb, ref);
  }
  return cascadedEnv?.[ref] ?? null;
}

/**
 * Resolve template strings in extra_headers.
 *
 * Replaces `{{ref}}` patterns with values from platform secrets.
 * If any ref cannot be resolved, the header is omitted.
 *
 * @param headers  - Header map with optional `{{ref}}` template values
 * @param db       - Platform secret DB interface
 * @returns        Resolved header map (entries with unresolvable refs are dropped)
 */
export async function resolveTemplatedHeaders(
  headers: Record<string, string>,
  db: PlatformSecretDb,
  cascadedEnv?: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const templatePattern = /\{\{(.+?)\}\}/g;

  for (const [header, value] of Object.entries(headers)) {
    const matches = [...value.matchAll(templatePattern)];

    if (matches.length === 0) {
      // No templates - pass through as-is
      resolved[header] = value;
      continue;
    }

    let resolvedValue = value;
    let allResolved = true;

    for (const match of matches) {
      const ref = match[1].trim();
      const secret = await resolveManagedSecret(ref, db, cascadedEnv);
      if (secret === null) {
        allResolved = false;
        break;
      }
      resolvedValue = resolvedValue.replace(match[0], secret);
    }

    if (allResolved) {
      resolved[header] = resolvedValue;
    }
  }

  return resolved;
}

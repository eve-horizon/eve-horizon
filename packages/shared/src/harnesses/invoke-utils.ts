/**
 * Shared invoke utility functions used by both Worker and Agent Runtime.
 *
 * These are "directly extractable" helpers — identical (or near-identical)
 * implementations that were duplicated across the two services.
 */

// ---------------------------------------------------------------------------
// extractPrefixedEnv
// ---------------------------------------------------------------------------

/**
 * Extract environment variables whose keys start with any of the given
 * prefixes.  Entries with falsy values are excluded.
 */
export function extractPrefixedEnv(
  prefixes: string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const entries = Object.entries(env).filter(([key, value]) => {
    if (!value) return false;
    return prefixes.some((prefix) => key.startsWith(prefix));
  });

  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// sanitizeSecretFilename
// ---------------------------------------------------------------------------

/**
 * Replace any characters that are not alphanumeric, underscore, dot, or
 * hyphen with an underscore.  Used when writing secret values to files.
 */
export function sanitizeSecretFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// ---------------------------------------------------------------------------
// writeEveCredentials — re-exported from canonical invoke/eve-credentials.ts
// ---------------------------------------------------------------------------

export { writeEveCredentials } from '../invoke/eve-credentials.js';

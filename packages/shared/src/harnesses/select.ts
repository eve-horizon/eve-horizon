/**
 * Intelligent harness selection based on credential availability.
 * Checks harnesses in preference order and returns first one with valid credentials.
 */

import { resolveHarnessName, type HarnessCanonicalName } from './registry.js';
import { getHarnessAuthStatus } from './auth.js';

export interface HarnessSelectionResult {
  harness: HarnessCanonicalName;
  source: 'explicit' | 'project' | 'system' | 'default';
  checked: string[];
  unavailable: { name: string; reason: string }[];
}

export const DEFAULT_HARNESS_PREFERENCE: HarnessCanonicalName[] = [
  'zai', 'claude', 'codex', 'gemini'
];

/**
 * Select an available harness based on preference order and credential availability.
 *
 * Resolution order:
 * 1. Explicit harness (if specified) - use it, fail if no auth
 * 2. Project preference - first available wins
 * 3. System preference - first available wins
 * 4. Default preference - first available wins
 *
 * @param options.explicit - Explicit harness name (no fallback)
 * @param options.projectPreference - Project-level harness preference order
 * @param options.systemPreference - System-level harness preference order
 * @param options.env - Resolved secrets to use for auth checks (merged with process.env)
 */
export function selectAvailableHarness(options: {
  explicit?: string;
  projectPreference?: string[];
  systemPreference?: string[];
  env?: Record<string, string | undefined>;
}): HarnessSelectionResult {
  // 1. If explicit harness specified, use it (no fallback - honor user intent)
  if (options.explicit) {
    const canonical = resolveHarnessName(options.explicit);
    if (!canonical) {
      throw new Error(`Unknown harness: ${options.explicit}`);
    }
    return {
      harness: canonical,
      source: 'explicit',
      checked: [canonical],
      unavailable: []
    };
  }

  // 2. Build preference order: project → system → default
  const preference = options.projectPreference
    ?? options.systemPreference
    ?? DEFAULT_HARNESS_PREFERENCE;

  const source: HarnessSelectionResult['source'] = options.projectPreference
    ? 'project'
    : options.systemPreference
      ? 'system'
      : 'default';

  // 3. Find first available harness
  const checked: string[] = [];
  const unavailable: { name: string; reason: string }[] = [];

  for (const name of preference) {
    const canonical = resolveHarnessName(name);
    if (!canonical) continue;

    checked.push(canonical);
    const authStatus = getHarnessAuthStatus(canonical, options.env);

    if (authStatus.available) {
      return { harness: canonical, source, checked, unavailable };
    }

    unavailable.push({ name: canonical, reason: authStatus.reason });
  }

  // 4. No available harness - provide helpful error
  const checkedList = checked.join(', ');
  const reasons = unavailable.map(u => `  ${u.name}: ${u.reason}`).join('\n');

  throw new Error(
    `No harness with valid credentials.\n` +
    `Checked: ${checkedList}\n` +
    `Reasons:\n${reasons}\n` +
    `Run 'eve harness list' to see full auth status.`
  );
}

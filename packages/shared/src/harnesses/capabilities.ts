import type { HarnessCanonicalName, HarnessName } from './registry.js';
import { resolveHarnessName } from './registry.js';
import { harnessAdapters } from './adapters/index.js';

export type ReasoningCapability = {
  supported: boolean;
  levels?: string[];
  mode?: 'effort' | 'thinking_tokens' | 'level' | 'unknown';
  notes?: string;
};

export type HarnessCapability = {
  supports_model: boolean;
  model_notes?: string;
  model_examples?: string[];
  reasoning?: ReasoningCapability;
};

/** Derived from the adapter list — each adapter declares its own capabilities. */
export const HARNESS_CAPABILITIES: Record<HarnessCanonicalName, HarnessCapability> =
  Object.fromEntries(
    harnessAdapters.map((adapter) => [adapter.name, adapter.capabilities]),
  ) as Record<HarnessCanonicalName, HarnessCapability>;

export function getHarnessCapability(name: HarnessName): HarnessCapability | undefined {
  const canonical = resolveHarnessName(name);
  if (!canonical) return undefined;
  return HARNESS_CAPABILITIES[canonical];
}

export function listHarnessCapabilities(): Array<{ name: HarnessCanonicalName; capabilities: HarnessCapability }> {
  return Object.entries(HARNESS_CAPABILITIES).map(([name, capabilities]) => ({
    name: name as HarnessCanonicalName,
    capabilities,
  }));
}

import type { HarnessName } from '../registry.js';
import type { HarnessAdapter } from './types.js';
import { claudeAdapter, mclaudeAdapter } from './claude.js';
import { zaiAdapter } from './zai.js';
import { geminiAdapter } from './gemini.js';
import { codeAdapter, codexAdapter } from './code.js';
import { piAdapter } from './pi.js';
import type { ReasoningEffort } from '../../types/harness.js';
import { mapReasoningForMode } from './reasoning.js';

/**
 * Canonical adapter list — the single source of truth for harness
 * definitions. Order matters: `HARNESS_NAMES`, `HARNESS_CANONICAL_NAMES`,
 * `HARNESS_REGISTRY`, and `HARNESS_CAPABILITIES` are all derived from it.
 */
export const harnessAdapters: HarnessAdapter[] = [
  mclaudeAdapter,
  claudeAdapter,
  zaiAdapter,
  geminiAdapter,
  codeAdapter,
  codexAdapter,
  piAdapter,
];

const registry = new Map<HarnessName, HarnessAdapter>();
for (const adapter of harnessAdapters) {
  registry.set(adapter.name, adapter);
  if (adapter.aliases) {
    for (const alias of adapter.aliases) {
      registry.set(alias, adapter);
    }
  }
}

export function resolveHarnessAdapter(name: HarnessName): HarnessAdapter | undefined {
  return registry.get(name);
}

export function mapReasoningEffort(
  harness: HarnessName,
  effort?: ReasoningEffort | string,
): string | undefined {
  const adapter = registry.get(harness);
  if (!adapter) return undefined;
  return mapReasoningForMode(adapter.reasoningMode, effort);
}

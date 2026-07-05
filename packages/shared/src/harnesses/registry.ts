import * as path from 'node:path';
import { listHarnessConfigVariants, resolveHarnessConfigRoot } from './config.js';
import { harnessAdapters } from './adapters/index.js';

export type HarnessCanonicalName =
  | 'mclaude'
  | 'claude'
  | 'zai'
  | 'gemini'
  | 'code'
  | 'codex'
  | 'pi';

export type HarnessName = HarnessCanonicalName | 'coder';

/** All accepted harness names (canonical + aliases), aliases directly after their canonical name. */
export const HARNESS_NAMES: readonly HarnessName[] = harnessAdapters.flatMap(
  (adapter) => [adapter.name, ...(adapter.aliases ?? [])],
);

/** Canonical harness names only. */
export const HARNESS_CANONICAL_NAMES: readonly HarnessCanonicalName[] = harnessAdapters.map(
  (adapter) => adapter.name,
);

export type HarnessVariant = {
  name: string;
  description: string;
  source?: 'default' | 'config';
};

export type HarnessInfo = {
  name: HarnessCanonicalName;
  aliases?: HarnessName[];
  description: string;
};

const DEFAULT_VARIANT: HarnessVariant = {
  name: 'default',
  description: 'Default harness configuration',
  source: 'default',
};

export const HARNESS_REGISTRY: HarnessInfo[] = harnessAdapters.map((adapter) => ({
  name: adapter.name,
  ...(adapter.aliases ? { aliases: adapter.aliases } : {}),
  description: adapter.description,
}));

export function listHarnesses(): HarnessInfo[] {
  return [...HARNESS_REGISTRY];
}

export function resolveHarnessName(name: string): HarnessCanonicalName | undefined {
  const normalized = name.trim().toLowerCase();
  for (const harness of HARNESS_REGISTRY) {
    if (harness.name === normalized) return harness.name;
    if (harness.aliases?.includes(normalized as HarnessName)) {
      return harness.name;
    }
  }
  return undefined;
}

export function getHarnessInfo(name: string): HarnessInfo | undefined {
  const canonical = resolveHarnessName(name);
  if (!canonical) return undefined;
  return HARNESS_REGISTRY.find((harness) => harness.name === canonical);
}

export function listHarnessVariants(
  harness: HarnessInfo,
  options?: { repoPath?: string; env?: NodeJS.ProcessEnv },
): HarnessVariant[] {
  const variants: HarnessVariant[] = [DEFAULT_VARIANT];
  const variantNames = listHarnessConfigVariants({
    harness: harness.name,
    repoPath: options?.repoPath ?? process.cwd(),
    env: options?.env,
  });
  for (const variant of variantNames) {
    const { root } = resolveHarnessConfigRoot({
      harness: harness.name,
      repoPath: options?.repoPath ?? process.cwd(),
      env: options?.env,
    });
    const variantDir = path.join(root, 'variants');
    variants.push({
      name: variant,
      description: `Config override at ${path.join(variantDir, variant)}`,
      source: 'config',
    });
  }
  return variants;
}

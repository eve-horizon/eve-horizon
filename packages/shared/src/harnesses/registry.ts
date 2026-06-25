import * as path from 'node:path';
import { listHarnessConfigVariants, resolveHarnessConfigRoot } from './config.js';

export const HARNESS_NAMES = [
  'mclaude',
  'claude',
  'zai',
  'gemini',
  'code',
  'coder',
  'codex',
  'pi',
] as const;

export const HARNESS_CANONICAL_NAMES = [
  'mclaude',
  'claude',
  'zai',
  'gemini',
  'code',
  'codex',
  'pi',
] as const;

export type HarnessName = (typeof HARNESS_NAMES)[number];
export type HarnessCanonicalName = (typeof HARNESS_CANONICAL_NAMES)[number];

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

export const HARNESS_REGISTRY: HarnessInfo[] = [
  {
    name: 'mclaude',
    description: 'Claude Code via cc-mirror (Anthropic).',
  },
  {
    name: 'claude',
    description: 'Claude Code CLI (direct).',
  },
  {
    name: 'zai',
    description: 'Z.ai via cc-mirror.',
  },
  {
    name: 'gemini',
    description: 'Gemini CLI harness.',
  },
  {
    name: 'code',
    aliases: ['coder'],
    description: 'just-every/code fork of codex.',
  },
  {
    name: 'codex',
    description: 'OpenAI Codex CLI harness.',
  },
  {
    name: 'pi',
    description: 'pi coding agent — multi-provider, extensible.',
  },
];

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

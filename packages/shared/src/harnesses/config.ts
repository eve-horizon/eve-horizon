import * as fs from 'node:fs';
import * as path from 'node:path';

export type HarnessConfigSource = 'env' | 'repo' | 'default';

export type HarnessConfigOptions = {
  harness: string;
  variant?: string;
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
};

export type HarnessConfigResult = {
  configDir: string;
  baseDir: string;
  hasVariant: boolean;
  source: HarnessConfigSource;
};

export function resolveHarnessConfigRoot(options: HarnessConfigOptions): {
  root: string;
  source: HarnessConfigSource;
} {
  const env = options.env ?? process.env;
  const envRoot = env.EVE_HARNESS_CONFIG_ROOT;
  if (envRoot) {
    return { root: path.join(envRoot, options.harness), source: 'env' };
  }

  const repoPath = options.repoPath ?? process.cwd();
  return {
    root: path.join(repoPath, '.agent', 'harnesses', options.harness),
    source: options.repoPath ? 'repo' : 'default',
  };
}

export function resolveHarnessConfig(options: HarnessConfigOptions): HarnessConfigResult {
  const { root, source } = resolveHarnessConfigRoot(options);
  if (!options.variant) {
    return {
      configDir: root,
      baseDir: root,
      hasVariant: false,
      source,
    };
  }

  const variantDir = path.join(root, 'variants', options.variant);
  const hasVariant = fs.existsSync(variantDir);
  return {
    configDir: hasVariant ? variantDir : root,
    baseDir: root,
    hasVariant,
    source,
  };
}

export function resolveClaudeConfigDir(
  harness: 'claude' | 'mclaude' | 'zai',
  variant?: string,
  options?: { repoPath?: string; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  const existing = env.CLAUDE_CONFIG_DIR;
  if (existing) {
    if (!variant) return existing;
    const normalized = existing.replace(/\/+$/, '');
    const marker = `${path.sep}variants${path.sep}`;
    if (normalized.includes(marker)) {
      return existing;
    }
    return path.join(normalized, 'variants', variant);
  }

  return resolveHarnessConfig({
    harness,
    variant,
    repoPath: options?.repoPath,
    env,
  }).configDir;
}

export function resolveCodeConfigDir(
  harness: 'code' | 'codex',
  variant?: string,
  options?: { repoPath?: string; env?: NodeJS.ProcessEnv },
): string {
  const env = options?.env ?? process.env;
  const existing = env.CODEX_HOME;
  if (existing) {
    if (!variant) return existing;
    const normalized = existing.replace(/\/+$/, '');
    const marker = `${path.sep}variants${path.sep}`;
    if (normalized.includes(marker)) {
      return existing;
    }
    return path.join(normalized, 'variants', variant);
  }

  return resolveHarnessConfig({
    harness,
    variant,
    repoPath: options?.repoPath,
    env,
  }).configDir;
}

export function listHarnessConfigVariants(options: {
  harness: string;
  repoPath?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const { root } = resolveHarnessConfigRoot({
    harness: options.harness,
    repoPath: options.repoPath,
    env: options.env,
  });
  const variantDir = path.join(root, 'variants');
  if (!fs.existsSync(variantDir)) return [];
  try {
    return fs
      .readdirSync(variantDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

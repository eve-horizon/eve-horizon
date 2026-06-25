import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { FlagValue } from '../lib/args';
import { getGitRoot } from '../lib/git.js';

// ============================================================================
// Types
// ============================================================================

interface PackEntry {
  source: string;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleMigrate(
  subcommand: string | undefined,
  _rest: string[],
  _flags: Record<string, FlagValue>,
): Promise<void> {
  switch (subcommand) {
    case 'skills-to-packs':
      await migrateSkillsToPacks();
      return;
    default:
      console.log('Usage: eve migrate <subcommand>');
      console.log('');
      console.log('Subcommands:');
      console.log('  skills-to-packs  Generate AgentPack config from skills.txt');
      return;
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * Read skills.txt and generate a suggested x-eve.packs YAML fragment
 * for migration to AgentPacks.
 */
async function migrateSkillsToPacks(): Promise<void> {
  const repoRoot = getGitRoot();
  if (!repoRoot) {
    throw new Error('Not in a git repository. Run this from your project root.');
  }

  const skillsTxtPath = join(repoRoot, 'skills.txt');
  if (!existsSync(skillsTxtPath)) {
    console.log('No skills.txt found at repository root. Nothing to migrate.');
    return;
  }

  const content = readFileSync(skillsTxtPath, 'utf-8');
  const lines = content.split('\n');

  const localSources: string[] = [];
  const remoteSources: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    // Skip glob patterns -- they need manual review
    if (line.includes('*')) {
      console.log(`  [skip] Glob pattern needs manual review: ${line}`);
      continue;
    }

    const sourceType = classifySource(line);
    if (sourceType === 'local') {
      localSources.push(line);
    } else {
      remoteSources.push(line);
    }
  }

  if (localSources.length === 0 && remoteSources.length === 0) {
    console.log('skills.txt is empty or contains only comments/globs. Nothing to migrate.');
    return;
  }

  // Build the packs array
  const packs: PackEntry[] = [];

  for (const source of remoteSources) {
    packs.push({ source: normalizeRemoteSource(source) });
  }

  for (const source of localSources) {
    packs.push({ source });
  }

  // Build the YAML fragment
  const fragment = {
    'x-eve': {
      packs,
    },
  };

  console.log('# Suggested AgentPack configuration for .eve/manifest.yaml');
  console.log('# Review and merge into your existing manifest under the x-eve key.');
  console.log('#');
  if (localSources.length > 0) {
    console.log('# Local paths are kept as-is. Consider publishing them as packs.');
  }
  console.log('');
  console.log(stringifyYaml(fragment, { indent: 2 }).trimEnd());
  console.log('');
  console.log('# After adding packs to your manifest:');
  console.log('#   1. Run: eve project sync');
  console.log('#   2. Delete skills.txt from your repo');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Classify a skills.txt line as local or remote.
 */
function classifySource(line: string): 'local' | 'remote' {
  // URLs
  if (line.startsWith('https://') || line.startsWith('http://')) {
    return 'remote';
  }

  // Explicit GitHub prefix
  if (line.startsWith('github:')) {
    return 'remote';
  }

  // Local paths: absolute, home-relative, or dot-relative
  if (line.startsWith('/') || line.startsWith('~') || line.startsWith('./') || line.startsWith('../')) {
    return 'local';
  }

  // GitHub shorthand: owner/repo (single slash, no spaces)
  if (line.includes('/') && !line.includes(' ') && !line.startsWith('.')) {
    return 'remote';
  }

  // Default: treat as local
  return 'local';
}

/**
 * Normalize remote source references for pack config.
 * - `github:owner/repo` -> `owner/repo`
 * - GitHub URLs -> `owner/repo`
 * - owner/repo -> owner/repo (pass through)
 */
function normalizeRemoteSource(source: string): string {
  // Strip github: prefix
  if (source.startsWith('github:')) {
    return source.slice(7);
  }

  // Extract owner/repo from GitHub URL
  const ghMatch = source.match(/github\.com\/([^/]+\/[^/]+)/);
  if (ghMatch) {
    return ghMatch[1].replace(/\.git$/, '');
  }

  return source;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { PackYamlSchema } from '../schemas/pack.js';
import type { PackEntry, ResolvedPack, GatewayPolicy } from '../schemas/pack.js';

const CACHE_ROOT = path.join(os.homedir(), '.eve', 'cache', 'packs');

/**
 * Resolve a single pack entry into its full metadata.
 */
export async function resolvePack(
  entry: PackEntry,
  projectSlug: string,
  repoRoot?: string,
): Promise<ResolvedPack> {
  const packDir = await fetchPackSource(entry, repoRoot);
  const packYamlPath = path.join(packDir, 'eve', 'pack.yaml');
  const eveDir = path.join(packDir, 'eve');

  // Case 1: Full AgentPack with pack.yaml
  if (fs.existsSync(packYamlPath)) {
    const raw = fs.readFileSync(packYamlPath, 'utf-8');
    const parsed = PackYamlSchema.parse(parseYaml(raw));

    const agents = loadYamlMap(path.join(packDir, parsed.imports.agents));
    const teams = parsed.imports.teams
      ? loadYamlMap(path.join(packDir, parsed.imports.teams))
      : { version: 1, teams: {} };
    const workflows = parsed.imports.workflows
      ? loadYamlMap(path.join(packDir, parsed.imports.workflows))
      : null;
    const chat = parsed.imports.chat
      ? loadYamlMap(path.join(packDir, parsed.imports.chat))
      : null;
    const xEve = parsed.imports.x_eve
      ? loadYamlMap(path.join(packDir, parsed.imports.x_eve))
      : null;

    // Apply slug prefixing to agent entries
    const prefixedAgents = prefixAgentSlugs(agents, projectSlug);

    // Resolve effective gateway policy per agent from pack default
    const packDefaultPolicy = parsed.gateway?.default_policy ?? 'none';
    const gatewayResolvedAgents = resolveAgentGatewayPolicies(prefixedAgents, packDefaultPolicy);

    const skillPaths = discoverSkillPaths(packDir);

    return {
      id: parsed.id,
      source: entry.source,
      ref: entry.ref ?? resolveLocalRef(packDir),
      rootPath: packDir,
      agents: gatewayResolvedAgents,
      teams,
      workflows,
      chat,
      xEve,
      skillPaths,
    };
  }

  // Case 2: eve/ directory exists but no pack.yaml -- error
  if (fs.existsSync(eveDir)) {
    throw new Error(
      `Pack "${entry.source}" has eve/ directory but no pack.yaml. ` +
      `Add eve/pack.yaml or remove the eve/ directory.`,
    );
  }

  // Case 3: Simple pack (convention-based discovery) or SkillPack (skills only)
  // Look for agents.yaml, teams.yaml, chat.yaml at the pack root before
  // falling back to skills-only. This supports "simple packs" that don't
  // need the full eve/pack.yaml indirection.
  const skillPaths = discoverSkillPaths(packDir);
  const packId = path.basename(packDir);
  const packRef = entry.ref ?? resolveLocalRef(packDir);

  const agentsPath = path.join(packDir, 'agents.yaml');
  const teamsPath = path.join(packDir, 'teams.yaml');
  const chatPath = path.join(packDir, 'chat.yaml');

  let agents: Record<string, unknown> = {};
  let teams: Record<string, unknown> = {};
  let chat: Record<string, unknown> | null = null;

  if (fs.existsSync(agentsPath)) {
    agents = loadYamlMap(agentsPath);
    agents = prefixAgentSlugs(agents, projectSlug);
    agents = resolveAgentGatewayPolicies(agents, 'none');
  }
  if (fs.existsSync(teamsPath)) {
    teams = loadYamlMap(teamsPath);
  }
  if (fs.existsSync(chatPath)) {
    chat = loadYamlMap(chatPath);
  }

  return {
    id: packId,
    source: entry.source,
    ref: packRef,
    rootPath: packDir,
    agents,
    teams,
    workflows: null,
    chat,
    xEve: null,
    skillPaths,
  };
}

/**
 * Fetch the pack source to a local directory.
 * Local paths: resolve relative to repoRoot.
 * Remote sources: shallow clone at ref to cache.
 */
async function fetchPackSource(entry: PackEntry, repoRoot?: string): Promise<string> {
  const { source, ref } = entry;

  // Local path
  if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/')) {
    const base = repoRoot ?? process.cwd();
    const resolved = path.resolve(base, source);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Local pack source not found: ${resolved}`);
    }
    return resolved;
  }

  // Remote source -- must have ref
  if (!ref) {
    throw new Error(`Remote pack source "${source}" requires a ref (40-char SHA)`);
  }

  const cacheDir = path.join(CACHE_ROOT, ref);

  // Return cached if exists
  if (fs.existsSync(cacheDir)) {
    return cacheDir;
  }

  // Clone at ref
  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    const gitUrl = resolveGitUrl(source);
    execSync(
      `git init ${JSON.stringify(cacheDir)}`,
      { stdio: 'pipe', timeout: 60_000 },
    );
    execSync(
      `git -C ${JSON.stringify(cacheDir)} remote add origin ${JSON.stringify(gitUrl)}`,
      { stdio: 'pipe', timeout: 30_000 },
    );
    execSync(
      `git -C ${JSON.stringify(cacheDir)} fetch --depth 1 origin ${JSON.stringify(ref)}`,
      { stdio: 'pipe', timeout: 60_000 },
    );
    execSync(
      `git -C ${JSON.stringify(cacheDir)} checkout --detach FETCH_HEAD`,
      { stdio: 'pipe', timeout: 30_000 },
    );
  } catch (err) {
    // Clean up failed clone
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw new Error(`Failed to clone pack "${source}" at ref ${ref}: ${err}`);
  }

  return cacheDir;
}

/**
 * Resolve a source string to a git URL.
 */
function resolveGitUrl(source: string): string {
  if (source.startsWith('https://') || source.startsWith('http://') || source.startsWith('file://') || source.startsWith('git@')) {
    return source;
  }
  if (source.startsWith('github:')) {
    return `https://github.com/${source.slice(7)}.git`;
  }
  // Assume GitHub shorthand (owner/repo)
  if (source.includes('/') && !source.includes(' ')) {
    return `https://github.com/${source}.git`;
  }
  return source;
}

/**
 * Load a YAML file and return it as a plain object.
 */
function loadYamlMap(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pack import file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Pack import file must be a YAML map: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Extract the inner map from a YAML config that may use nested format.
 * Handles both `{ version: 1, agents: { ... } }` and flat `{ agent_a: { ... } }`.
 */
export function extractInnerMap(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = config[key] as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') return nested;
  // Flat format: filter out non-map keys like 'version'
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'version' || k === 'default_route') continue;
    result[k] = v;
  }
  return result;
}

/**
 * Apply automatic slug prefixing to agent entries.
 *
 * Rules:
 * 1. If agent has explicit `slug`: prefix it -> `{projectSlug}-{slug}`
 * 2. If agent has no `slug`: generate from ID -> `{projectSlug}-{id}` (underscores to hyphens)
 * 3. Never prefix agent IDs (map keys). IDs are pack-local references.
 * 4. Never prefix references in teams/routes -- those reference agent IDs, not slugs.
 *
 * Handles both nested `{ version: 1, agents: { ... } }` and flat formats.
 */
function prefixAgentSlugs(
  agentsConfig: Record<string, unknown>,
  projectSlug: string,
): Record<string, unknown> {
  const agentsMap = extractInnerMap(agentsConfig, 'agents');
  const result: Record<string, unknown> = {};
  const normalizedPrefix = projectSlug.toLowerCase().replace(/_/g, '-');

  for (const [id, entry] of Object.entries(agentsMap)) {
    if (typeof entry !== 'object' || entry === null) {
      result[id] = entry;
      continue;
    }

    const agent = { ...(entry as Record<string, unknown>) };
    const existingSlug = agent.slug as string | undefined;

    if (existingSlug) {
      agent.slug = `${normalizedPrefix}-${existingSlug}`;
    } else {
      agent.slug = `${normalizedPrefix}-${id.replace(/_/g, '-')}`;
    }

    result[id] = agent;
  }

  // Preserve the original structure
  if (agentsConfig.agents) {
    return { ...agentsConfig, agents: result };
  }
  return result;
}

/**
 * Resolve effective gateway policy for each agent entry.
 * If the agent has an explicit gateway.policy, use it.
 * Otherwise, apply the pack's default_policy.
 */
function resolveAgentGatewayPolicies(
  agentsConfig: Record<string, unknown>,
  packDefaultPolicy: GatewayPolicy,
): Record<string, unknown> {
  const agentsMap = extractInnerMap(agentsConfig, 'agents');
  const result: Record<string, unknown> = {};

  for (const [id, entry] of Object.entries(agentsMap)) {
    if (typeof entry !== 'object' || entry === null) {
      result[id] = entry;
      continue;
    }

    const agent = { ...(entry as Record<string, unknown>) };
    const gateway = agent.gateway as { policy?: string; clients?: string[] } | undefined | null;

    if (gateway === null) {
      // Explicit `gateway: null` → revert to pack default
      agent.gateway = { policy: packDefaultPolicy };
    } else if (!gateway?.policy) {
      // No explicit policy → apply pack default
      agent.gateway = { ...(gateway ?? {}), policy: packDefaultPolicy };
    }

    result[id] = agent;
  }

  // Preserve the original structure
  if (agentsConfig.agents) {
    return { ...agentsConfig, agents: result };
  }
  return result;
}

/**
 * Discover skill directories (subdirs containing SKILL.md).
 */
export function discoverSkillPaths(packDir: string): string[] {
  const paths: string[] = [];
  const skillsDir = path.join(packDir, 'skills');

  if (!fs.existsSync(skillsDir)) {
    return paths;
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
        paths.push(fullPath);
      }
      walk(fullPath);
    }
  };

  walk(skillsDir);
  return paths;
}

/**
 * Get the current HEAD SHA for a local directory.
 */
function resolveLocalRef(dir: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return 'local';
  }
}

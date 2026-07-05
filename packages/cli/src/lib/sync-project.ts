/**
 * Unified project sync logic — syncs manifest + agents config in one shot.
 *
 * Used by `eve project sync` (primary) and `eve agents sync` (deprecated alias).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  resolvePack,
  extractInnerMap,
  mergeMapConfig,
  mergeChatConfig,
  mergeXEve,
  expandManifestReferences,
} from '@eve/shared';
import type { PackEntry, ResolvedPack, PackLock } from '@eve/shared';
import type { FlagValue } from './args';
import { getBooleanFlag, getStringFlag, toBoolean } from './args';
import type { ResolvedContext } from './context';
import { requestJson } from './client';
import { outputJson } from './output';
import {
  getGitBranch,
  getGitRoot,
  isGitDirty,
  resolveGitBranch,
  resolveGitRef,
} from './git.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestSyncResult {
  id: string;
  manifest_hash: string;
  parsed_defaults?: Record<string, unknown> | null;
  secret_validation?: { missing: Array<{ key: string }> };
  warnings?: string[];
  created_at: string;
}

export interface AgentsSyncResult {
  synced: boolean;
  packs?: Array<{ id: string; source: string; ref: string }>;
  agents_count?: number;
  skipped?: boolean;
  skip_reason?: string;
}

export interface UnifiedSyncResult {
  manifest: ManifestSyncResult;
  agents?: AgentsSyncResult;
  project_id: string;
  git_sha?: string;
  branch?: string;
}

interface PackResolutionResult {
  agentsYaml: string;
  teamsYaml: string;
  chatYaml: string;
  xEveYaml: string | null;
  workflowsYaml: string | null;
  packRefs: Array<{ id: string; source: string; ref: string }>;
}

export type RunUnifiedSyncOptions = {
  localCliImages?: Record<string, string>;
  quiet?: boolean;
};

export interface ResolvedConfigPath {
  path: string;
  explicit: boolean;
}

export interface ResolvedAgentsConfigPaths {
  agents: ResolvedConfigPath;
  teams: ResolvedConfigPath;
  chat: ResolvedConfigPath;
}

export const DEFAULT_TEAMS_YAML = 'version: 1\nteams: {}\n';
export const DEFAULT_CHAT_YAML = 'version: 1\nroutes: []\n';

// ---------------------------------------------------------------------------
// Helpers (moved from agents.ts)
// ---------------------------------------------------------------------------

function readYamlFile(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }
  return parsed;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function resolveConfigPath(
  repoRoot: string,
  explicitPath: string | undefined,
  candidates: string[],
): ResolvedConfigPath {
  if (explicitPath) {
    return { path: resolve(repoRoot, explicitPath), explicit: true };
  }

  for (const candidate of candidates) {
    const candidatePath = resolve(repoRoot, candidate);
    if (existsSync(candidatePath)) {
      return { path: candidatePath, explicit: false };
    }
  }

  return { path: resolve(repoRoot, candidates[0]!), explicit: false };
}

export function resolveAgentsConfigPaths(
  repoRoot: string,
  manifest: Record<string, unknown>,
): ResolvedAgentsConfigPaths {
  const xEve =
    (manifest['x-eve'] as Record<string, unknown> | undefined) ||
    (manifest['x_eve'] as Record<string, unknown> | undefined) ||
    {};
  const agentsBlock = (xEve['agents'] as Record<string, unknown> | undefined) || {};
  const chatBlock = (xEve['chat'] as Record<string, unknown> | undefined) || {};
  const manifestChat = (manifest['chat'] as Record<string, unknown> | undefined) || {};

  const agentsPath = resolveConfigPath(
    repoRoot,
    pickString(agentsBlock.config_path),
    ['agents/agents.yaml', 'eve/agents.yaml'],
  );
  const teamsPath = resolveConfigPath(
    repoRoot,
    pickString(agentsBlock.teams_path),
    ['agents/teams.yaml', 'eve/teams.yaml'],
  );
  const chatPath = resolveConfigPath(
    repoRoot,
    pickString(chatBlock.config_path) ?? pickString(manifestChat.config_path),
    ['agents/chat.yaml', 'eve/chat.yaml'],
  );

  return { agents: agentsPath, teams: teamsPath, chat: chatPath };
}

function resolveXEveConfigPath(repoRoot: string): string | null {
  for (const candidate of ['eve/x-eve.yaml', '.eve/x-eve.yaml']) {
    const candidatePath = resolve(repoRoot, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function ensureFileExists(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label} at ${path}. Update manifest config_path or add the file.`);
  }
  return path;
}

function ensureRequiredOrSkip(pathInfo: ResolvedConfigPath, label: string): string | null {
  if (existsSync(pathInfo.path)) {
    return pathInfo.path;
  }
  if (pathInfo.explicit) {
    return ensureFileExists(pathInfo.path, label);
  }
  return null;
}

function loadOrDefault(pathInfo: ResolvedConfigPath, defaultYaml: string, label: string): string {
  if (existsSync(pathInfo.path)) {
    return readFileSync(pathInfo.path, 'utf-8');
  }
  if (pathInfo.explicit) {
    return readFileSync(ensureFileExists(pathInfo.path, label), 'utf-8');
  }
  return defaultYaml;
}

function isLocalApiUrl(apiUrl: string): boolean {
  try {
    const url = new URL(apiUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.lvh.me') ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function validateEffectiveConfig(
  agents: Record<string, unknown>,
  teams: Record<string, unknown>,
  chat: Record<string, unknown>,
): void {
  const agentsMap = extractInnerMap(agents, 'agents');
  const teamsMap = extractInnerMap(teams, 'teams');

  // Check slug uniqueness
  const slugs = new Set<string>();
  for (const [, entry] of Object.entries(agentsMap)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const agent = entry as Record<string, unknown>;
    const slug = agent.slug as string | undefined;
    if (slug) {
      if (slugs.has(slug)) {
        throw new Error(`Duplicate agent slug "${slug}" in effective config. Slugs must be unique.`);
      }
      slugs.add(slug);
    }
  }

  // Check team references
  const agentIds = new Set(Object.keys(agentsMap));
  for (const [teamId, entry] of Object.entries(teamsMap)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const team = entry as Record<string, unknown>;
    const lead = team.lead as string | undefined;
    if (lead && !agentIds.has(lead)) {
      throw new Error(`Team "${teamId}" references unknown agent "${lead}" as lead.`);
    }
    const members = (team.members ?? []) as string[];
    for (const member of members) {
      if (!agentIds.has(member)) {
        throw new Error(`Team "${teamId}" references unknown agent "${member}" as member.`);
      }
    }
  }

  // Check route targets
  const teamIds = new Set(Object.keys(teamsMap));
  const routes = ((chat as { routes?: Array<{ id: string; target?: string }> }).routes ?? []);
  for (const route of routes) {
    if (!route.target) continue;
    let targetId = route.target;
    if (targetId.startsWith('team:')) {
      targetId = targetId.slice(5);
      if (!teamIds.has(targetId)) {
        throw new Error(`Route "${route.id}" targets unknown team "${route.target}".`);
      }
    } else if (targetId.startsWith('agent:')) {
      targetId = targetId.slice(6);
      if (!agentIds.has(targetId)) {
        throw new Error(`Route "${route.id}" targets unknown agent "${route.target}".`);
      }
    } else if (!agentIds.has(targetId) && !teamIds.has(targetId)) {
      throw new Error(`Route "${route.id}" targets unknown agent/team "${route.target}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pack resolution
// ---------------------------------------------------------------------------

async function resolvePacksAndMerge(
  repoRoot: string,
  manifest: Record<string, unknown>,
  projectSlug: string,
): Promise<PackResolutionResult | null> {
  const xEve = (manifest['x-eve'] ?? manifest['x_eve']) as Record<string, unknown> | undefined;
  const packs = (xEve?.packs ?? []) as PackEntry[];

  if (packs.length === 0) return null;

  console.log(`Resolving ${packs.length} pack(s)...`);

  // 1. Resolve all packs
  const resolvedPacks: ResolvedPack[] = [];
  for (const entry of packs) {
    const resolved = await resolvePack(entry, projectSlug, repoRoot);
    resolvedPacks.push(resolved);
    console.log(`  ✓ ${resolved.id} (${resolved.skillPaths.length} skills)`);
  }

  // 2. Check for agent ID collisions across packs
  const seenAgentIds = new Map<string, string>();
  for (const pack of resolvedPacks) {
    const packAgents = extractInnerMap(pack.agents, 'agents');
    for (const agentId of Object.keys(packAgents)) {
      if (seenAgentIds.has(agentId)) {
        throw new Error(
          `Agent ID collision: "${agentId}" defined in both pack "${seenAgentIds.get(agentId)}" and "${pack.id}". ` +
          `Agent IDs must be unique across all packs.`,
        );
      }
      seenAgentIds.set(agentId, pack.id);
    }
  }

  // 3. Merge pack bases in listed order
  let mergedAgents: Record<string, unknown> = { version: 1, agents: {} };
  let mergedTeams: Record<string, unknown> = { version: 1, teams: {} };
  let mergedWorkflows: Record<string, unknown> | null = null;
  let mergedChat: Record<string, unknown> = { version: 1, routes: [] };
  const xEveFragments: Record<string, unknown>[] = [];

  for (const pack of resolvedPacks) {
    mergedAgents = mergeMapConfig(mergedAgents, pack.agents);
    mergedTeams = mergeMapConfig(mergedTeams, pack.teams);
    if (pack.workflows) {
      const packWorkflows = extractInnerMap(pack.workflows, 'workflows');
      if (Object.keys(packWorkflows).length > 0) {
        mergedWorkflows = mergedWorkflows ?? {};
        Object.assign(mergedWorkflows, packWorkflows);
      }
    }
    if (pack.chat) {
      mergedChat = mergeChatConfig(
        mergedChat as { routes?: Array<{ id: string; [k: string]: unknown }> },
        pack.chat as { routes?: Array<{ id: string; [k: string]: unknown }> },
      );
    }
    if (pack.xEve) {
      xEveFragments.push(pack.xEve);
    }
  }

  // 4. Load project overlay files and merge on top
  const configPaths = resolveAgentsConfigPaths(repoRoot, manifest);

  const agentsPath = ensureRequiredOrSkip(configPaths.agents, 'agents config');
  if (agentsPath) {
    const projectAgents = parseYaml(readFileSync(agentsPath, 'utf-8')) ?? {};
    mergedAgents = mergeMapConfig(mergedAgents, projectAgents as Record<string, unknown>);
  }
  const teamsPath = ensureRequiredOrSkip(configPaths.teams, 'teams config');
  if (teamsPath) {
    const projectTeams = parseYaml(readFileSync(teamsPath, 'utf-8')) ?? {};
    mergedTeams = mergeMapConfig(mergedTeams, projectTeams as Record<string, unknown>);
  }
  const chatPath = ensureRequiredOrSkip(configPaths.chat, 'chat config');
  if (chatPath) {
    const projectChat = parseYaml(readFileSync(chatPath, 'utf-8')) ?? {};
    mergedChat = mergeChatConfig(
      mergedChat as { routes?: Array<{ id: string; [k: string]: unknown }> },
      projectChat as { routes?: Array<{ id: string; [k: string]: unknown }> },
    );
  }

  // 5. Merge x-eve (strip packs + install_agents from project overlay)
  const projectXEve = (xEve ?? {}) as Record<string, unknown>;
  const { packs: _p, install_agents: _ia, ...projectXEveRest } = projectXEve;
  const mergedXEve = mergeXEve(xEveFragments, projectXEveRest);

  // 6. Validate effective config
  validateEffectiveConfig(mergedAgents, mergedTeams, mergedChat);

  // 7. Write lockfile
  const lockfile: PackLock = {
    resolved_at: new Date().toISOString(),
    project_slug: projectSlug,
    packs: resolvedPacks.map((p) => ({
      id: p.id,
      source: p.source,
      ref: p.ref,
      pack_version: 1,
    })),
    effective: {
      agents_count: Object.keys(extractInnerMap(mergedAgents, 'agents')).length,
      teams_count: Object.keys(extractInnerMap(mergedTeams, 'teams')).length,
      routes_count: ((mergedChat as { routes?: unknown[] }).routes ?? []).length,
      profiles_count: Object.keys(((mergedXEve as Record<string, unknown>)?.agents as Record<string, unknown> | undefined)?.profiles ?? {}).length,
      agents_hash: simpleHash(JSON.stringify(mergedAgents)),
      teams_hash: simpleHash(JSON.stringify(mergedTeams)),
      chat_hash: simpleHash(JSON.stringify(mergedChat)),
    },
  };

  const eveDir = join(repoRoot, '.eve');
  mkdirSync(eveDir, { recursive: true });
  const lockfilePath = join(eveDir, 'packs.lock.yaml');
  writeFileSync(lockfilePath, stringifyYaml(lockfile), 'utf-8');
  console.log(`  ✓ Lockfile written: .eve/packs.lock.yaml`);

  // 8. Return effective config as YAML strings
  const packRefs = resolvedPacks.map((p) => ({ id: p.id, source: p.source, ref: p.ref }));

  return {
    agentsYaml: stringifyYaml(mergedAgents),
    teamsYaml: stringifyYaml(mergedTeams),
    chatYaml: stringifyYaml(mergedChat),
    xEveYaml: Object.keys(mergedXEve).length > 0 ? stringifyYaml(mergedXEve) : null,
    workflowsYaml: mergedWorkflows ? stringifyYaml({
      workflows: mergedWorkflows,
      ...(Object.keys(mergedXEve).length > 0 ? { x_eve: mergedXEve } : {}),
      ...(manifest.services ? { services: manifest.services } : {}),
      ...(manifest.environments ? { environments: manifest.environments } : {}),
    }) : null,
    packRefs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a project has any agents config to sync.
 * Returns true if there are packs OR if the agents config files exist.
 */
function hasAgentsConfig(repoRoot: string, manifest: Record<string, unknown>): boolean {
  const xEve = (manifest['x-eve'] ?? manifest['x_eve']) as Record<string, unknown> | undefined;
  const packs = (xEve?.packs ?? []) as PackEntry[];
  if (packs.length > 0) return true;

  const configPaths = resolveAgentsConfigPaths(repoRoot, manifest);
  return configPaths.agents.explicit || existsSync(configPaths.agents.path);
}

/**
 * Run the unified project sync: manifest POST + agents sync POST.
 *
 * Flags accepted:
 *   --dir             Working directory (default: cwd)
 *   --project         Project ID override
 *   --ref             Git ref for agents sync (default: HEAD)
 *   --local           Dev-mode local sync
 *   --allow-dirty     Allow dirty working tree
 *   --force-nonlocal  Allow --local against non-local API
 *   --validate-secrets
 *   --strict
 *   --json
 */
export async function runUnifiedSync(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  options: RunUnifiedSyncOptions = {},
): Promise<UnifiedSyncResult> {
  const json = Boolean(flags.json);
  const dir = getStringFlag(flags, ['dir']) ?? process.cwd();
  const repoRoot = resolve(dir);
  const manifestPath = join(repoRoot, '.eve', 'manifest.yaml');

  // -----------------------------------------------------------------------
  // Read manifest
  // -----------------------------------------------------------------------
  let yaml: string;
  try {
    yaml = readFileSync(manifestPath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read manifest at ${manifestPath}: ${(error as Error).message}`);
  }

  const expandedManifest = expandManifestReferences(yaml, { repoRoot, manifestPath });
  yaml = expandedManifest.yaml;

  const manifest = expandedManifest.manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid YAML in ${manifestPath}`);
  }

  // -----------------------------------------------------------------------
  // Resolve project ID
  // -----------------------------------------------------------------------
  const projectIdFromFlag = getStringFlag(flags, ['project']) ?? context.projectId;
  const projectIdFromManifest = typeof manifest.project === 'string' ? manifest.project : undefined;
  const projectId = projectIdFromFlag ?? projectIdFromManifest;

  if (!projectId) {
    throw new Error(
      'Missing project id. Provide --project or set a profile default, or add "project: proj_xxx" to manifest.',
    );
  }

  // -----------------------------------------------------------------------
  // Early pack resolution — merge pack workflows into manifest YAML so
  // there is a single manifest POST containing everything (repo manifest
  // + pack workflows).  Previously this was a fragile two-POST approach
  // that created separate manifest records in the DB.
  // -----------------------------------------------------------------------
  let cachedPackResult: PackResolutionResult | null = null;

  if (hasAgentsConfig(repoRoot, manifest)) {
    // Resolve project slug for pack prefix (best-effort API lookup)
    let projectSlugForPrefix =
      (typeof manifest.project === 'string' ? manifest.project : null) ??
      projectId.replace(/^proj_/, '');
    try {
      const project = await requestJson<Record<string, unknown>>(
        context,
        `/projects/${projectId}`,
        { method: 'GET' },
      );
      const slug = project?.slug;
      if (typeof slug === 'string' && slug.length > 0) {
        projectSlugForPrefix = slug;
      }
    } catch {
      // Best-effort: fall back to manifest/projectId-derived slug.
    }

    cachedPackResult = await resolvePacksAndMerge(repoRoot, manifest, projectSlugForPrefix);

    if (cachedPackResult?.workflowsYaml) {
      // Merge pack workflows into the manifest so the Phase 1 POST
      // carries everything in a single record.
      const packParsed = parseYaml(cachedPackResult.workflowsYaml) as Record<string, unknown>;
      if (packParsed?.workflows && typeof packParsed.workflows === 'object') {
        const manifestObj = parseYaml(yaml) as Record<string, unknown>;
        // Pack workflows overlay repo-manifest workflows
        manifestObj.workflows = {
          ...(typeof manifestObj.workflows === 'object'
            ? (manifestObj.workflows as Record<string, unknown>)
            : {}),
          ...(packParsed.workflows as Record<string, unknown>),
        };
        yaml = stringifyYaml(manifestObj);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Git info (basic — for manifest sync)
  // -----------------------------------------------------------------------
  const validateSecretsFlag = flags['validate-secrets'] ?? flags.validate_secrets;
  const validateSecrets = toBoolean(validateSecretsFlag) ?? false;
  const strict = toBoolean(flags.strict) ?? false;

  let gitSha: string | undefined;
  let branch: string | undefined;
  try {
    gitSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
    branch = execSync('git branch --show-current', { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    // Git info is optional for manifest sync
  }

  // -----------------------------------------------------------------------
  // Phase 1: Manifest sync
  // -----------------------------------------------------------------------
  const manifestResponse = await requestJson<ManifestSyncResult>(
    context,
    `/projects/${projectId}/manifest`,
    {
      method: 'POST',
      body: {
        yaml,
        git_sha: gitSha,
        branch,
        validate_secrets: validateSecrets || strict,
        strict,
        ...(options.localCliImages && Object.keys(options.localCliImages).length > 0
          ? {
              local_cli_registry: 'local',
              local_cli_images: options.localCliImages,
            }
          : {}),
      },
    },
  );

  // -----------------------------------------------------------------------
  // Phase 2: Agents sync (if config exists)
  // -----------------------------------------------------------------------
  let agentsResult: AgentsSyncResult | undefined;

  if (hasAgentsConfig(repoRoot, manifest)) {
    agentsResult = await syncAgentsConfig(repoRoot, manifest, projectId, flags, context, cachedPackResult);
  }

  // -----------------------------------------------------------------------
  // Output
  // -----------------------------------------------------------------------
  const result: UnifiedSyncResult = {
    manifest: manifestResponse,
    project_id: projectId,
    git_sha: gitSha,
    branch,
  };
  if (agentsResult) {
    result.agents = agentsResult;
  }

  if (json) {
    outputJson(result, json);
    return result;
  }

  if (options.quiet) {
    return result;
  }

  // Human-readable output
  console.log(`✓ Manifest synced to ${projectId}`);
  console.log(`  Hash: ${manifestResponse.manifest_hash.substring(0, 12)}...`);
  if (gitSha) console.log(`  Git SHA: ${gitSha.substring(0, 8)}`);
  if (branch) console.log(`  Branch: ${branch}`);

  if (manifestResponse.parsed_defaults && Object.keys(manifestResponse.parsed_defaults).length > 0) {
    console.log('\nParsed defaults.env:');
    Object.entries(manifestResponse.parsed_defaults).forEach(([key, value]) => {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    });
  }
  if (manifestResponse.warnings && manifestResponse.warnings.length > 0) {
    console.log('\nWarnings:');
    manifestResponse.warnings.forEach((warning) => {
      console.log(`  - ${warning}`);
    });
  }

  if (agentsResult && agentsResult.synced) {
    console.log(`✓ Agents config synced`);
    if (agentsResult.packs && agentsResult.packs.length > 0) {
      console.log(`  Packs: ${agentsResult.packs.map((p) => p.id).join(', ')}`);
    }
    if (agentsResult.agents_count !== undefined) {
      console.log(`  Agents: ${agentsResult.agents_count}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: agents config sync
// ---------------------------------------------------------------------------

async function syncAgentsConfig(
  repoRoot: string,
  manifest: Record<string, unknown>,
  projectId: string,
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  cachedPackResult?: PackResolutionResult | null,
): Promise<AgentsSyncResult> {
  const ref = getStringFlag(flags, ['ref']);
  const local = getBooleanFlag(flags, ['local']) ?? false;
  const allowDirty = getBooleanFlag(flags, ['allow-dirty', 'allow_dirty']) ?? false;
  const forceNonlocal = getBooleanFlag(flags, ['force-nonlocal', 'force_nonlocal']) ?? false;

  if (local && ref) {
    throw new Error('Use either --local or --ref, not both.');
  }

  // Default mode: auto-detect from HEAD (neither --local nor --ref required)
  const autoMode = !local && !ref;

  if (local && !forceNonlocal && !isLocalApiUrl(context.apiUrl)) {
    throw new Error(
      `--local sync is only allowed for local API URLs (localhost or *.lvh.me). ` +
      `Current API: ${context.apiUrl}. Use --force-nonlocal to override.`,
    );
  }

  const gitRoot = getGitRoot(repoRoot);
  if (!gitRoot) {
    throw new Error('Not a git repository. Run from the repo root or pass --dir <path>.');
  }

  const dirty = isGitDirty(gitRoot);
  if (dirty && !allowDirty && !autoMode) {
    throw new Error('Working tree is dirty. Commit changes or pass --allow-dirty to sync anyway.');
  }

  // Use the cached pack result from early resolution (already merged into
  // the Phase 1 manifest POST).  This avoids re-resolving packs and
  // eliminates the fragile separate workflow POST.
  const packResult = cachedPackResult ?? null;

  let agentsYaml: string;
  let teamsYaml: string;
  let chatYaml: string;
  let xEveYaml: string | undefined;
  let packRefs: Array<{ id: string; source: string; ref: string }> | undefined;

  if (packResult) {
    agentsYaml = packResult.agentsYaml;
    teamsYaml = packResult.teamsYaml;
    chatYaml = packResult.chatYaml;
    xEveYaml = packResult.xEveYaml ?? undefined;
    packRefs = packResult.packRefs;
    // Pack workflows were already merged into the manifest YAML before the
    // Phase 1 POST in runUnifiedSync().  No separate POST needed.
  } else {
    // No packs — load from individual files
    const configPaths = resolveAgentsConfigPaths(repoRoot, manifest);

    // If no agents file exists (and no packs), skip agents sync silently
    const agentsPath = ensureRequiredOrSkip(configPaths.agents, 'agents config');
    if (!agentsPath) {
      return { synced: false, skipped: true, skip_reason: 'no agents config found' };
    }

    agentsYaml = readFileSync(agentsPath, 'utf-8');
    teamsYaml = loadOrDefault(configPaths.teams, DEFAULT_TEAMS_YAML, 'teams config');
    chatYaml = loadOrDefault(configPaths.chat, DEFAULT_CHAT_YAML, 'chat config');

    const xEvePath = resolveXEveConfigPath(repoRoot);
    if (xEvePath) {
      xEveYaml = readFileSync(xEvePath, 'utf-8');
    }
  }

  // Resolve git ref
  let gitSha: string | undefined;
  let branch: string | undefined;
  let gitRef: string;

  if (ref) {
    gitSha = await resolveGitRef(context, projectId, ref, repoRoot);
    branch = resolveGitBranch(gitRoot, ref) ?? undefined;
    gitRef = ref;
  } else if (local) {
    gitSha = execSync('git rev-parse HEAD', { cwd: gitRoot, encoding: 'utf-8' }).trim();
    branch = getGitBranch(gitRoot) ?? undefined;
    gitRef = 'local';
  } else {
    // Auto mode: use HEAD
    gitSha = execSync('git rev-parse HEAD', { cwd: gitRoot, encoding: 'utf-8' }).trim();
    branch = getGitBranch(gitRoot) ?? undefined;
    gitRef = branch ?? 'HEAD';
  }

  if (dirty) {
    gitRef = `dirty:${gitRef}`;
  }

  const response = await requestJson<Record<string, unknown>>(
    context,
    `/projects/${projectId}/agents/sync`,
    {
      method: 'POST',
      body: {
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        ...(xEveYaml ? { x_eve_yaml: xEveYaml } : {}),
        git_sha: gitSha,
        branch,
        git_ref: gitRef,
        pack_refs: packRefs,
      },
    },
  );

  // Count agents from the response or from the YAML
  const agentsCount =
    typeof (response as Record<string, unknown>).agents_count === 'number'
      ? (response as Record<string, unknown>).agents_count as number
      : undefined;

  return {
    synced: true,
    packs: packRefs,
    agents_count: agentsCount,
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { extractInnerMap, HARNESS_CAPABILITIES } from '@eve/shared';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import {
  DEFAULT_CHAT_YAML,
  DEFAULT_TEAMS_YAML,
  resolveAgentsConfigPaths,
  runUnifiedSync,
} from '../lib/sync-project';
import type { ResolvedConfigPath } from '../lib/sync-project';

type HarnessVariantResponse = {
  name: string;
  description: string;
  source?: string;
};

type HarnessAuthStatusResponse = {
  available: boolean;
  reason: string;
  instructions: string[];
};

type HarnessInfoResponse = {
  name: string;
  aliases?: string[];
  description: string;
  variants: HarnessVariantResponse[];
  auth: HarnessAuthStatusResponse;
};

type HarnessListResponse = {
  data: HarnessInfoResponse[];
};

type AgentRuntimePod = {
  org_id: string;
  pod_name: string;
  status: string;
  capacity: number;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
  stale?: boolean;
  active_jobs?: number;
};

type AgentRuntimeStatusResponse = {
  pods: AgentRuntimePod[];
};


type PolicySource =
  | { type: 'manifest'; path: string }
  | { type: 'none' };

type AgentsConfigResult = {
  source: PolicySource;
  policy: Record<string, unknown> | null;
  manifest_defaults?: Record<string, unknown> | null;
  agents: AgentSummary[];
  teams: TeamSummary[];
  chat_routes: RouteSummary[];
};

type AgentSummary = {
  id: string;
  slug: string | null;
  harness_profile: string | null;
  workflow: string | null;
  gateway_policy: string;
};

type TeamSummary = {
  id: string;
  lead: string | null;
  members: string[];
};

type RouteSummary = {
  id: string;
  match: string;
  target: string;
};

function parseYamlMap(raw: string, source: string): Record<string, unknown> {
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid YAML in ${source}`);
  }
  return parsed;
}

function readYamlFile(filePath: string): Record<string, unknown> {
  return parseYamlMap(readFileSync(filePath, 'utf-8'), filePath);
}

function readConfigYaml(
  pathInfo: ResolvedConfigPath,
  label: string,
  defaultYaml?: string,
): Record<string, unknown> | null {
  if (existsSync(pathInfo.path)) {
    return readYamlFile(pathInfo.path);
  }
  if (pathInfo.explicit) {
    throw new Error(`Missing ${label} at ${pathInfo.path}. Update manifest config_path or add the file.`);
  }
  return defaultYaml ? parseYamlMap(defaultYaml, label) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function summarizeAgents(config: Record<string, unknown> | null): AgentSummary[] {
  if (!config) return [];
  const agents = extractInnerMap(config, 'agents');
  return Object.entries(agents)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([id, value]) => {
      const agent = value as Record<string, unknown>;
      const gateway = agent.gateway as Record<string, unknown> | undefined;
      return {
        id,
        slug: optionalString(agent.slug),
        harness_profile: optionalString(agent.harness_profile),
        workflow: optionalString(agent.workflow),
        gateway_policy: optionalString(gateway?.policy) ?? 'none',
      };
    });
}

function summarizeTeams(config: Record<string, unknown> | null): TeamSummary[] {
  if (!config) return [];
  const teams = extractInnerMap(config, 'teams');
  return Object.entries(teams)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([id, value]) => {
      const team = value as Record<string, unknown>;
      const members = Array.isArray(team.members)
        ? team.members.filter((member): member is string => typeof member === 'string')
        : [];
      return {
        id,
        lead: optionalString(team.lead),
        members,
      };
    });
}

function summarizeRoutes(config: Record<string, unknown> | null): RouteSummary[] {
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  return routes
    .filter((route): route is Record<string, unknown> => route !== null && typeof route === 'object' && !Array.isArray(route))
    .map((route) => ({
      id: optionalString(route.id) ?? '',
      match: optionalString(route.match) ?? '',
      target: optionalString(route.target) ?? '',
    }))
    .filter((route) => route.id.length > 0);
}

function loadAgentsConfig(repoRoot: string): AgentsConfigResult {
  const eveDir = join(repoRoot, '.eve');
  const manifestPath = join(eveDir, 'manifest.yaml');
  if (existsSync(manifestPath)) {
    const manifest = readYamlFile(manifestPath);
    const xEve =
      (manifest['x-eve'] as Record<string, unknown> | undefined) ||
      (manifest['x_eve'] as Record<string, unknown> | undefined) ||
      {};
    const policy = (xEve['agents'] as Record<string, unknown> | undefined) || null;
    const defaults = (xEve['defaults'] as Record<string, unknown> | undefined) || null;
    const configPaths = resolveAgentsConfigPaths(repoRoot, manifest);
    const agents = readConfigYaml(configPaths.agents, 'agents config');
    const teams = readConfigYaml(configPaths.teams, 'teams config', DEFAULT_TEAMS_YAML);
    const chat = readConfigYaml(configPaths.chat, 'chat config', DEFAULT_CHAT_YAML);
    return {
      source: { type: 'manifest', path: manifestPath },
      policy,
      manifest_defaults: defaults,
      agents: summarizeAgents(agents),
      teams: summarizeTeams(teams),
      chat_routes: summarizeRoutes(chat),
    };
  }

  return { source: { type: 'none' }, policy: null, agents: [], teams: [], chat_routes: [] };
}

export async function handleAgents(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const command = subcommand ?? 'config';
  const json = Boolean(flags.json);
  const includeHarnesses = !(getBooleanFlag(flags, ['no-harnesses']) ?? false);
  const repoRoot = resolve(getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir', 'path']) ?? process.cwd());

  switch (command) {
    case 'config': {
      const result = loadAgentsConfig(repoRoot);
      const response: Record<string, unknown> = {
        repo_root: repoRoot,
        source: result.source,
        policy: result.policy,
        agents: result.agents,
        teams: result.teams,
        chat_routes: result.chat_routes,
      };

      if (result.manifest_defaults) {
        response.manifest_defaults = result.manifest_defaults;
      }

      if (includeHarnesses) {
        const harnesses = await requestJson<HarnessListResponse>(context, '/harnesses');
        response.harnesses = harnesses.data;
        response.capabilities = HARNESS_CAPABILITIES;
      }

      if (json) {
        outputJson(response, json);
        return;
      }

      console.log(`Agents config source: ${result.source.type}`);
      if ('path' in result.source) {
        console.log(`Path: ${result.source.path}`);
      }
      if (!result.policy) {
        console.log('No policy found. Add x-eve.agents to .eve/manifest.yaml.');
      } else {
        const profiles = (result.policy.profiles as Record<string, unknown> | undefined) || {};
        const profileNames = Object.keys(profiles);
        console.log(`Profiles: ${profileNames.length ? profileNames.join(', ') : 'none'}`);
      }
      const agentNames = result.agents.map((agent) => agent.slug ?? agent.id);
      console.log(`Agents: ${result.agents.length}${agentNames.length ? ` (${agentNames.join(', ')})` : ''}`);
      console.log(`Teams: ${result.teams.length}`);
      console.log(`Routes: ${result.chat_routes.length}`);

      if (includeHarnesses) {
        const harnesses = response.harnesses as HarnessInfoResponse[] | undefined;
        if (harnesses?.length) {
          const ready = harnesses.filter((h) => h.auth.available).length;
          console.log(`Harnesses: ${harnesses.length} (${ready} ready)`);
        }
      }
      return;
    }
    case 'sync': {
      // Deprecated — delegate to unified project sync
      console.warn('⚠ Deprecated: use "eve project sync" instead.');

      // Map --repo-dir / --path to --dir for the unified sync
      const dir = getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir', 'path']);
      const unifiedFlags = { ...flags };
      if (dir) {
        unifiedFlags.dir = dir;
      }

      await runUnifiedSync(unifiedFlags, context);
      return;
    }
    case 'runtime-status': {
      const orgId = getStringFlag(flags, ['org']) ?? context.orgId;
      if (!orgId) {
        throw new Error('Missing org id. Provide --org or set a profile default.');
      }

      const response = await requestJson<AgentRuntimeStatusResponse>(
        context,
        `/orgs/${orgId}/agent-runtime/status`,
      );

      if (json) {
        outputJson(response, json);
        return;
      }

      formatAgentRuntimeStatus(response, orgId);
      return;
    }
    case 'delete': {
      const slug = positionals[0];
      if (!slug) {
        throw new Error('Usage: eve agents delete <slug> [--project <id>]');
      }
      const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      if (!projectId) {
        throw new Error('Missing project id. Provide --project or set a profile default.');
      }
      await requestRaw(context, `/projects/${projectId}/agents/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
      outputJson({ slug, deleted: true }, json, `Agent ${slug} deleted`);
      return;
    }
    case 'delete-team': {
      const teamId = positionals[0];
      if (!teamId) {
        throw new Error('Usage: eve agents delete-team <team_id> [--project <id>]');
      }
      const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      if (!projectId) {
        throw new Error('Missing project id. Provide --project or set a profile default.');
      }
      await requestRaw(context, `/projects/${projectId}/teams/${encodeURIComponent(teamId)}`, {
        method: 'DELETE',
      });
      outputJson({ id: teamId, deleted: true }, json, `Team ${teamId} deleted`);
      return;
    }
    default:
      throw new Error('Usage: eve agents <config|sync|runtime-status|delete|delete-team>');
  }
}

function formatAgentRuntimeStatus(response: AgentRuntimeStatusResponse, orgId: string): void {
  console.log(`Agent Runtime Status: ${orgId}`);

  if (response.pods.length === 0) {
    console.log('');
    console.log('No agent runtime pods found.');
    return;
  }

  const nameWidth = Math.max(7, ...response.pods.map((pod) => pod.pod_name.length));
  const statusDisplayWidth = Math.max(6, ...response.pods.map((pod) => {
    const staleTag = pod.stale ? ' (stale)' : '';
    return (pod.status + staleTag).length;
  }));
  const capacityWidth = Math.max(8, ...response.pods.map((pod) => String(pod.capacity).length));
  const ageWidth = Math.max(3, ...response.pods.map((pod) => formatAgeSeconds(pod.last_heartbeat_at).length));

  console.log('');
  const header = [
    padRight('Pod', nameWidth),
    padRight('Status', statusDisplayWidth),
    padRight('Capacity', capacityWidth),
    padRight('Age', ageWidth),
    'Last Heartbeat',
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const pod of response.pods) {
    const age = formatAgeSeconds(pod.last_heartbeat_at);
    const staleIndicator = pod.stale ? ' (stale)' : '';
    const activeJobs = pod.active_jobs != null ? `  [${pod.active_jobs} active]` : '';
    console.log([
      padRight(pod.pod_name, nameWidth),
      padRight(pod.status + staleIndicator, statusDisplayWidth),
      padRight(String(pod.capacity), capacityWidth),
      padRight(age, ageWidth),
      pod.last_heartbeat_at + activeJobs,
    ].join('  '));
  }

  console.log('');
  const healthyCount = response.pods.filter((p) => !p.stale).length;
  const staleCount = response.pods.filter((p) => p.stale).length;
  console.log(`Summary: ${healthyCount} healthy, ${staleCount} stale`);
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function formatAgeSeconds(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (!Number.isFinite(timestamp)) {
    return '-';
  }
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}h`;
}

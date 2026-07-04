import { spawnSync } from 'node:child_process';
import { toK8sName } from '@eve/shared';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { expandManifestReferences } from '@eve/shared';
import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag, getStringFlags, toBoolean } from '../lib/args';
import { requestJson, requestRaw } from '../lib/client';
import { loadCredentials } from '../lib/config';
import type { ResolvedContext } from '../lib/context';
import { loadRepoProfiles, resolveContextForProfile } from '../lib/context';
import { buildCliImage } from '../lib/cli-image-builder';
import {
  addProjectToWorkspace,
  createWorkspace,
  getActiveWorkspaceName,
  listWorkspaces,
  loadWorkspace,
  setActiveWorkspaceName,
  workspacePathForName,
  type ResolvedLocalMeshProject,
  type ResolvedLocalMeshWorkspace,
} from '../lib/local-mesh-workspace';
import { outputJson } from '../lib/output';
import { runUnifiedSync, type UnifiedSyncResult } from '../lib/sync-project';

type ProjectResponse = {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  repo_url?: string;
  branch?: string;
};

type ProjectListResponse = {
  data: ProjectResponse[];
};

type OrgResponse = {
  id: string;
  name: string;
  slug: string;
};

type EnvironmentResponse = {
  id: string;
  project_id: string;
  name: string;
  namespace: string | null;
  deploy_status?: string;
  current_release_id?: string | null;
};

type DeploymentResponse = {
  environment: EnvironmentResponse;
  deployment_status?: {
    state?: string;
    k8s_status?: {
      available_replicas: number;
      desired_replicas: number;
    } | null;
  };
};

type AppLinkGrant = {
  id: string;
  producer_project_id: string;
  export_kind: 'api' | 'events';
  export_name: string;
  consumer_project_id: string;
  api_scopes: string[];
  event_types: string[];
  envs: string[];
  service_name: string | null;
  cli_name: string | null;
  cli_image?: string | null;
  revoked_at: string | null;
};

type AppLinkSubscription = {
  id: string;
  consumer_project_id: string;
  local_alias: string;
  api_grant_id: string | null;
  event_grant_id: string | null;
  requested_scopes: string[];
  event_types: string[];
  environment_strategy: 'same' | 'fixed';
  producer_env_name: string | null;
  inject_into_services: string[];
  inject_into_jobs: boolean;
  last_token_minted_at: string | null;
};

type AppLinksListResponse = {
  project_id: string;
  exports: AppLinkGrant[];
  consumes: AppLinkSubscription[];
  grants_to_project: AppLinkGrant[];
};

type AppLinksExplainResponse = {
  status: 'OK' | 'MISSING' | 'REVOKED' | 'INVALID';
  diagnostics: Array<{ level: 'ok' | 'warning' | 'error'; message: string }>;
  grant: AppLinkGrant | null;
  subscription: AppLinkSubscription | null;
};

type EnvLogStreamEvent = {
  timestamp?: string;
  line?: string;
  pod?: string;
  pod_name?: string;
  container?: string;
};

type MeshProjectState = {
  workspaceProject: ResolvedLocalMeshProject;
  manifest: Record<string, unknown>;
  dependencies: string[];
  cliExports: Array<{ exportName: string; serviceName: string; cliName: string; image: string }>;
  project?: ProjectResponse;
};

type MeshStepResult = {
  project: string;
  action: 'sync' | 'deploy' | 'undeploy' | 'delete' | 'status' | 'diagnose';
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  project_id?: string;
  namespace?: string | null;
  env_status?: string;
  links?: Array<{ alias: string; status: string; message?: string }>;
};

const PROJECT_SLUG_RE = /^[A-Za-z][A-Za-z0-9]{3,7}$/;
const LOCAL_API_RE = /^(http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?|http:\/\/.*\.lvh\.me)$/;

export async function handleLocalMesh(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const command = positionals[0];
  const rest = positionals.slice(1);
  const json = Boolean(flags.json);

  switch (command) {
    case 'init':
      return handleInit(rest, flags, json);
    case 'add':
      return handleAdd(rest, flags, json);
    case 'use':
      return handleUse(rest, json);
    case 'list':
      return handleList(json);
    case 'show':
      return handleShow(flags, json);
    case 'up':
      return handleUp(rest, flags, context, json);
    case 'redeploy':
      return handleRedeploy(rest, flags, context, json);
    case 'down':
      return handleDown(flags, context, json);
    case 'status':
      return handleStatus(flags, context, json);
    case 'logs':
      return handleLogs(rest, flags, context);
    case 'diagnose':
      return handleDiagnose(flags, context, json);
    default:
      throw new Error(
        'Usage: eve local mesh <init|add|use|list|show|up|down|redeploy|status|logs|diagnose> [options]',
      );
  }
}

function handleInit(rest: string[], flags: Record<string, FlagValue>, json: boolean): void {
  const name = rest[0];
  if (!name) {
    throw new Error('Usage: eve local mesh init <name> [--org <slug-or-id>] [--env local] [--profile <profile>] [--force]');
  }
  const workspace = createWorkspace({
    name,
    org: getStringFlag(flags, ['org']),
    env: getStringFlag(flags, ['env']) ?? 'local',
    profile: getStringFlag(flags, ['profile']),
    force: getBooleanFlag(flags, ['force']) ?? false,
  });
  outputJson(workspace, json, `✓ Local mesh workspace created: ${workspace.name}\n  ${workspace.path}`);
}

function handleAdd(rest: string[], flags: Record<string, FlagValue>, json: boolean): void {
  const name = rest[0];
  const path = getStringFlag(flags, ['path']) ?? rest[1];
  if (!name || !path) {
    throw new Error('Usage: eve local mesh add <project> --path <path> [--role producer|consumer] [--workspace <name>]');
  }

  const workspace = addProjectToWorkspace(getStringFlag(flags, ['workspace']), {
    name,
    path,
    ...(getStringFlag(flags, ['role']) ? { role: getStringFlag(flags, ['role']) } : {}),
  });
  outputJson(workspace, json, `✓ Added ${name} to workspace ${workspace.name}`);
}

function handleUse(rest: string[], json: boolean): void {
  const name = rest[0];
  if (!name) {
    throw new Error('Usage: eve local mesh use <name>');
  }
  const path = workspacePathForName(name);
  if (!existsSync(path)) {
    throw new Error(`Workspace not found: ${path}`);
  }
  setActiveWorkspaceName(name);
  outputJson({ active: name, path }, json, `✓ Active local mesh workspace: ${name}`);
}

function handleList(json: boolean): void {
  const workspaces = listWorkspaces();
  if (json) {
    outputJson({ active: getActiveWorkspaceName(), workspaces }, json);
    return;
  }
  if (workspaces.length === 0) {
    console.log('No local mesh workspaces found.');
    return;
  }
  for (const workspace of workspaces) {
    console.log(`${workspace.active ? '*' : ' '} ${workspace.name}  ${workspace.path}`);
  }
}

function handleShow(flags: Record<string, FlagValue>, json: boolean): void {
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  if (json) {
    outputJson(workspace, json);
    return;
  }
  console.log(`${workspace.name}`);
  console.log(`  Path: ${workspace.path}`);
  console.log(`  Org:  ${workspace.org ?? '(profile default)'}`);
  console.log(`  Env:  ${workspace.env}`);
  if (workspace.profile) console.log(`  Profile: ${workspace.profile}`);
  console.log('');
  console.log('Projects:');
  for (const project of workspace.projects) {
    console.log(`  ${project.name}  ${project.resolvedPath}${project.role ? `  role=${project.role}` : ''}`);
  }
}

async function handleUp(
  _rest: string[],
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const selected = parseOnly(flags);
  const results = await executeMeshUp(workspace, context, flags, selected, selected);
  finishResults(results, json, 'Local mesh up complete.');
}

async function handleRedeploy(
  rest: string[],
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const project = rest[0];
  if (!project) {
    throw new Error('Usage: eve local mesh redeploy <project> [--workspace <name>] [--skip-cli-build]');
  }
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const results = await executeMeshUp(workspace, context, flags, [project], [project]);
  finishResults(results, json, `Local mesh redeploy complete: ${project}`);
}

async function executeMeshUp(
  workspace: ResolvedLocalMeshWorkspace,
  context: ResolvedContext,
  flags: Record<string, FlagValue>,
  onlyProjects: string[],
  deployProjects: string[],
): Promise<MeshStepResult[]> {
  assertWorkspaceHasProjects(workspace);
  assertLocalApi(context);
  const states = prepareMeshProjects(workspace);
  const order = toposort(states);
  const selected = onlyProjects.length > 0
    ? dependencyClosure(states, onlyProjects)
    : new Set(order);
  const deploySet = deployProjects.length > 0
    ? new Set(deployProjects)
    : new Set(order);
  const results: MeshStepResult[] = [];

  if (workspace.defaults.pre_check && !(getBooleanFlag(flags, ['skip-pre-check', 'skip_pre_check']) ?? false)) {
    await runPrecheck(context, Boolean(flags.json));
  }

  const org = await resolveOrg(context, workspace.org);
  for (const projectName of order) {
    const state = states.get(projectName)!;
    state.project = await ensureProject(context, org.id, state);
  }

  const failed = new Set<string>();
  for (const projectName of order) {
    const state = states.get(projectName)!;
    if (!selected.has(projectName)) continue;

    const failedDependency = state.dependencies.find((dependency) => failed.has(dependency));
    if (failedDependency) {
      results.push({
        project: projectName,
        action: 'sync',
        status: 'skipped',
        message: `producer ${failedDependency} failed`,
        project_id: state.project?.id,
      });
      failed.add(projectName);
      continue;
    }

    try {
      const localCliImages = shouldBuildCliImages(workspace, flags)
        ? buildProjectCliImages(state, flags, Boolean(flags.json))
        : {};
      const syncResult = await runUnifiedSync(
        {
          project: state.project!.id,
          dir: state.workspaceProject.resolvedPath,
        },
        context,
        { localCliImages, quiet: Boolean(flags.json) },
      );
      results.push({
        project: projectName,
        action: 'sync',
        status: 'ok',
        project_id: state.project!.id,
        message: syncResult.manifest.manifest_hash,
      });

      if (deploySet.has(projectName)) {
        const deployment = await deployProject(context, workspace, state, syncResult);
        results.push({
          project: projectName,
          action: 'deploy',
          status: 'ok',
          project_id: state.project!.id,
          namespace: deployment.environment.namespace,
          env_status: deployment.deployment_status?.state ?? deployment.environment.deploy_status,
        });
      }
    } catch (error) {
      failed.add(projectName);
      results.push({
        project: projectName,
        action: deploySet.has(projectName) ? 'deploy' : 'sync',
        status: 'failed',
        project_id: state.project?.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function handleDown(
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const states = prepareMeshProjects(workspace);
  const order = toposort(states).reverse();
  const org = await resolveOrg(context, workspace.org);
  const deleteProjects = getBooleanFlag(flags, ['delete-projects', 'delete_projects']) ?? false;
  const results: MeshStepResult[] = [];

  for (const projectName of order) {
    const state = states.get(projectName)!;
    const project = await findProject(context, org.id, projectName);
    if (!project) {
      results.push({ project: projectName, action: 'undeploy', status: 'skipped', message: 'project not found' });
      continue;
    }

    const undeploy = await requestRaw(context, `/projects/${project.id}/envs/${workspace.env}/undeploy`, {
      method: 'POST',
      body: { force: true },
      allowError: true,
    });
    results.push({
      project: projectName,
      action: 'undeploy',
      status: undeploy.ok ? 'ok' : 'failed',
      project_id: project.id,
      message: undeploy.ok ? undefined : formatResponseError(undeploy),
    });

    if (deleteProjects && undeploy.ok) {
      const deleted = await requestRaw(context, `/projects/${project.id}?force=true`, {
        method: 'DELETE',
        allowError: true,
      });
      results.push({
        project: projectName,
        action: 'delete',
        status: deleted.ok ? 'ok' : 'failed',
        project_id: project.id,
        message: deleted.ok ? undefined : formatResponseError(deleted),
      });
    }
  }

  finishResults(results, json, 'Local mesh down complete.');
}

async function handleStatus(
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const org = await resolveOrg(context, workspace.org);
  const results: MeshStepResult[] = [];

  for (const project of workspace.projects) {
    const record = await findProject(context, org.id, project.name);
    if (!record) {
      results.push({ project: project.name, action: 'status', status: 'skipped', message: 'project not found' });
      continue;
    }
    const env = await requestRaw(context, `/projects/${record.id}/envs/${workspace.env}`, { allowError: true });
    const links = await requestRaw(context, `/projects/${record.id}/app-links`, { allowError: true });
    const subscriptions = links.ok ? ((links.data as AppLinksListResponse).consumes ?? []) : [];
    results.push({
      project: project.name,
      action: 'status',
      status: env.ok ? 'ok' : 'failed',
      project_id: record.id,
      namespace: env.ok ? (env.data as EnvironmentResponse).namespace : null,
      env_status: env.ok ? ((env.data as EnvironmentResponse).deploy_status ?? 'unknown') : 'missing',
      message: env.ok ? undefined : formatResponseError(env),
      links: subscriptions.map((subscription) => ({
        alias: subscription.local_alias,
        status: subscription.api_grant_id || subscription.event_grant_id ? 'declared' : 'missing-grant',
      })),
    });
  }

  if (json) {
    outputJson({ workspace: workspace.name, env: workspace.env, results }, json);
    return;
  }
  printStatus(results);
}

async function handleLogs(
  rest: string[],
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
): Promise<void> {
  const target = rest[0];
  if (!target) {
    throw new Error('Usage: eve local mesh logs <project>[/<component>] [--workspace <name>] [--follow] [--since <duration>] [--tail <n>]');
  }
  const [projectName, component] = target.split('/');
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const org = await resolveOrg(context, workspace.org);
  const project = await findProject(context, org.id, projectName);
  if (!project) {
    throw new Error(`Project not found in local mesh: ${projectName}`);
  }
  if (!component) {
    throw new Error('Component is required for logs. Use: eve local mesh logs <project>/<component>');
  }

  const query = buildQuery({
    since: getStringFlag(flags, ['since']),
    tail: getStringFlag(flags, ['tail']) ?? '100',
    previous: toBoolean(flags.previous) ? 'true' : undefined,
  });

  const follow = toBoolean(flags.follow) ?? toBoolean(flags.f) ?? false;
  if (follow) {
    await streamMeshLogs(context, project.id, workspace.env, component, query);
    return;
  }

  const response = await requestJson<{ logs: Array<{ timestamp: string; line: string; pod?: string }> }>(
    context,
    `/projects/${project.id}/envs/${workspace.env}/services/${component}/logs${query}`,
  );
  for (const entry of response.logs) {
    console.log(`${entry.timestamp} ${entry.pod ? `${entry.pod} ` : ''}${entry.line}`);
  }
}

async function streamMeshLogs(
  context: ResolvedContext,
  projectId: string,
  envName: string,
  service: string,
  query: string,
): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const response = await fetch(
    `${context.apiUrl}/projects/${projectId}/envs/${envName}/services/${service}/logs/stream${query}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  if (!response.body) {
    throw new Error('No response body received');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let eventData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim();
      } else if (line === '' && eventData) {
        printMeshLogEvent(eventType, eventData);
        eventType = '';
        eventData = '';
      }
    }
  }
}

function printMeshLogEvent(eventType: string, dataStr: string): void {
  if (eventType === 'heartbeat') return;
  if (eventType === 'pod_changed') {
    try {
      const data = JSON.parse(dataStr) as EnvLogStreamEvent;
      console.log(`--- attached to ${data.pod_name ?? data.pod ?? 'unknown'} ---`);
    } catch {
      // Ignore malformed stream events.
    }
    return;
  }
  if (eventType !== 'log') return;

  try {
    const data = JSON.parse(dataStr) as EnvLogStreamEvent;
    const timestamp = data.timestamp ?? new Date().toISOString();
    const pod = data.pod_name ?? data.pod;
    const prefix = [pod, data.container].filter(Boolean).join('/');
    console.log(`[${timestamp}]${prefix ? ` ${prefix}` : ''} ${data.line ?? ''}`);
  } catch {
    // Ignore malformed stream events.
  }
}

async function handleDiagnose(
  flags: Record<string, FlagValue>,
  baseContext: ResolvedContext,
  json: boolean,
): Promise<void> {
  const workspace = loadWorkspace(getStringFlag(flags, ['workspace']));
  const context = resolveMeshContext(workspace, baseContext);
  const org = await resolveOrg(context, workspace.org);
  const projectFilter = getStringFlag(flags, ['project']);
  const probe = getBooleanFlag(flags, ['probe']) ?? false;
  const results: MeshStepResult[] = [];

  for (const workspaceProject of workspace.projects) {
    if (projectFilter && workspaceProject.name !== projectFilter) continue;
    const project = await findProject(context, org.id, workspaceProject.name);
    if (!project) {
      results.push({ project: workspaceProject.name, action: 'diagnose', status: 'skipped', message: 'project not found' });
      continue;
    }
    const links = await requestRaw(context, `/projects/${project.id}/app-links`, { allowError: true });
    if (!links.ok) {
      results.push({
        project: workspaceProject.name,
        action: 'diagnose',
        status: 'failed',
        project_id: project.id,
        message: formatResponseError(links),
      });
      continue;
    }

    const consumes = (links.data as AppLinksListResponse).consumes ?? [];
    const linkResults: Array<{ alias: string; status: string; message?: string }> = [];
    for (const subscription of consumes) {
      const explain = await requestJson<AppLinksExplainResponse>(
        context,
        `/projects/${project.id}/app-links/explain`,
        { method: 'POST', body: { alias: subscription.local_alias, env: workspace.env } },
      );
      const probeResult = probe
        ? await probeSubscription(context, workspace, subscription, project)
        : null;
      linkResults.push({
        alias: subscription.local_alias,
        status: probeResult ? `${explain.status}/${probeResult.status}` : explain.status,
        message: probeResult?.message ?? explain.diagnostics.find((item) => item.level !== 'ok')?.message,
      });
    }

    results.push({
      project: workspaceProject.name,
      action: 'diagnose',
      status: linkResults.some((link) => link.status.includes('failed') || link.status.includes('INVALID') || link.status.includes('MISSING')) ? 'failed' : 'ok',
      project_id: project.id,
      links: linkResults,
    });
  }

  if (json) {
    outputJson({ workspace: workspace.name, env: workspace.env, results }, json);
    return;
  }
  printStatus(results);
}

function resolveMeshContext(workspace: ResolvedLocalMeshWorkspace, context: ResolvedContext): ResolvedContext {
  if (!workspace.profile || workspace.profile === context.profileName) {
    return context;
  }
  const repoProfiles = loadRepoProfiles();
  const profile = repoProfiles.profiles[workspace.profile];
  if (!profile) {
    throw new Error(`Workspace profile "${workspace.profile}" was not found in .eve/profile.yaml.`);
  }
  return resolveContextForProfile(workspace.profile, profile, loadCredentials());
}

async function runPrecheck(context: ResolvedContext, quiet = false): Promise<void> {
  const health = await requestRaw(context, '/health', { allowError: true });
  if (!health.ok) {
    throw new Error(`Local Eve API is not healthy at ${context.apiUrl}. Start it with: ./bin/eh k8s start && ./bin/eh k8s deploy`);
  }
  const me = await requestRaw(context, '/auth/me', { allowError: true });
  if (!me.ok) {
    throw new Error(`Not authenticated against ${context.apiUrl}. Run: eve auth login`);
  }
  const user = me.data as { email?: string; user_id?: string };
  if (!quiet) {
    console.log(`Using ${context.profileName} against ${context.apiUrl}${user.email ? ` as ${user.email}` : ''}`);
  }
}

function prepareMeshProjects(workspace: ResolvedLocalMeshWorkspace): Map<string, MeshProjectState> {
  const names = new Set(workspace.projects.map((project) => project.name));
  const states = new Map<string, MeshProjectState>();
  for (const project of workspace.projects) {
    assertProjectSlug(project.name);
    const manifest = readManifest(project);
    if (!manifest.environments || typeof manifest.environments !== 'object' || !(workspace.env in manifest.environments)) {
      throw new Error(`Project ${project.name} manifest must declare environments.${workspace.env}`);
    }
    const dependencies = collectDependencies(project.name, manifest, names);
    states.set(project.name, {
      workspaceProject: project,
      manifest,
      dependencies,
      cliExports: collectCliExports(manifest),
    });
  }
  return states;
}

function readManifest(project: ResolvedLocalMeshProject): Record<string, unknown> {
  const manifestPath = join(project.resolvedPath, '.eve', 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    throw new Error(`Project ${project.name} is missing .eve/manifest.yaml at ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, 'utf-8');
  const expanded = expandManifestReferences(raw, {
    repoRoot: project.resolvedPath,
    manifestPath,
  });
  if (!expanded.manifest || typeof expanded.manifest !== 'object') {
    throw new Error(`Invalid manifest YAML: ${manifestPath}`);
  }
  return expanded.manifest as Record<string, unknown>;
}

function collectDependencies(projectName: string, manifest: Record<string, unknown>, workspaceNames: Set<string>): string[] {
  const consumes = getAppLinks(manifest)?.consumes ?? {};
  const dependencies = new Set<string>();
  for (const [alias, consume] of Object.entries(consumes)) {
    if (!consume || typeof consume !== 'object') continue;
    const producer = (consume as Record<string, unknown>).project;
    if (typeof producer !== 'string' || !producer.trim()) continue;
    if (!workspaceNames.has(producer)) {
      throw new Error(`Project ${projectName} consumes ${alias} from ${producer}; add producer "${producer}" to this mesh.`);
    }
    dependencies.add(producer);
  }
  return [...dependencies];
}

function collectCliExports(manifest: Record<string, unknown>): Array<{ exportName: string; serviceName: string; cliName: string; image: string }> {
  const exports = getAppLinks(manifest)?.exports;
  const apis = exports && typeof exports === 'object' ? (exports as Record<string, unknown>).apis : undefined;
  if (!apis || typeof apis !== 'object') return [];
  const services = manifest.services && typeof manifest.services === 'object'
    ? manifest.services as Record<string, Record<string, unknown>>
    : {};
  const result: Array<{ exportName: string; serviceName: string; cliName: string; image: string }> = [];
  for (const [exportName, value] of Object.entries(apis as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const apiExport = value as Record<string, unknown>;
    if (typeof apiExport.cli !== 'string' || typeof apiExport.service !== 'string') continue;
    const service = services[apiExport.service];
    const serviceXeve = getServiceXeve(service);
    const cli = serviceXeve?.cli;
    if (!cli || typeof cli !== 'object') continue;
    const cliRecord = cli as Record<string, unknown>;
    if (cliRecord.name !== apiExport.cli || typeof cliRecord.image !== 'string') continue;
    result.push({
      exportName,
      serviceName: apiExport.service,
      cliName: apiExport.cli,
      image: cliRecord.image,
    });
  }
  return result;
}

function toposort(states: Map<string, MeshProjectState>): string[] {
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string, stack: string[]): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...stack, name].join(' -> ');
      throw new Error(`Local mesh app-link cycle detected: ${cycle}`);
    }
    visiting.add(name);
    const state = states.get(name);
    if (!state) throw new Error(`Unknown project in mesh graph: ${name}`);
    for (const dependency of state.dependencies) {
      visit(dependency, [...stack, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const name of states.keys()) {
    visit(name, []);
  }
  return order;
}

function dependencyClosure(states: Map<string, MeshProjectState>, selected: string[]): Set<string> {
  const result = new Set<string>();
  const visit = (name: string): void => {
    const state = states.get(name);
    if (!state) {
      throw new Error(`Project "${name}" is not declared in this local mesh workspace.`);
    }
    if (result.has(name)) return;
    for (const dependency of state.dependencies) {
      visit(dependency);
    }
    result.add(name);
  };
  selected.forEach(visit);
  return result;
}

function shouldBuildCliImages(workspace: ResolvedLocalMeshWorkspace, flags: Record<string, FlagValue>): boolean {
  if (getBooleanFlag(flags, ['skip-cli-build', 'skip_cli_build']) ?? false) return false;
  return workspace.defaults.cli_image_registry === 'local';
}

function buildProjectCliImages(state: MeshProjectState, flags: Record<string, FlagValue>, quiet: boolean): Record<string, string> {
  const images: Record<string, string> = {};
  const seen = new Set<string>();
  for (const cliExport of state.cliExports) {
    if (seen.has(cliExport.cliName)) continue;
    seen.add(cliExport.cliName);
    const result = buildCliImage({
      projectSlug: state.workspaceProject.name,
      repoDir: state.workspaceProject.resolvedPath,
      dockerfile: getStringFlag(flags, ['dockerfile']),
      importToK3d: true,
      quiet,
    });
    images[cliExport.cliName] = result.image;
    images[cliExport.serviceName] = result.image;
    images[cliExport.exportName] = result.image;
  }
  return images;
}

async function resolveOrg(context: ResolvedContext, orgRef: string | undefined): Promise<OrgResponse> {
  if (orgRef?.startsWith('org_')) {
    return requestJson<OrgResponse>(context, `/orgs/${orgRef}`);
  }
  if (!orgRef && context.orgId) {
    return requestJson<OrgResponse>(context, `/orgs/${context.orgId}`);
  }
  if (!orgRef) {
    throw new Error('Workspace is missing org and the active profile has no default org.');
  }

  const listed = await requestJson<{ data: OrgResponse[] }>(context, '/orgs?limit=100');
  const existing = listed.data.find((org) => org.slug === orgRef || org.name === orgRef);
  if (existing) return existing;

  return requestJson<OrgResponse>(context, '/orgs/ensure', {
    method: 'POST',
    body: {
      id: normalizeOrgId(orgRef),
      name: orgRef,
      slug: normalizeOrgSlug(orgRef),
    },
  });
}

async function ensureProject(
  context: ResolvedContext,
  orgId: string,
  state: MeshProjectState,
): Promise<ProjectResponse> {
  const branch = getGitBranch(state.workspaceProject.resolvedPath) ?? 'main';
  return requestJson<ProjectResponse>(context, '/projects/ensure', {
    method: 'POST',
    body: {
      org_id: orgId,
      name: state.workspaceProject.name,
      slug: state.workspaceProject.name,
      repo_url: pathToFileURL(state.workspaceProject.resolvedPath).toString(),
      branch,
      force: true,
    },
  });
}

async function findProject(
  context: ResolvedContext,
  orgId: string,
  projectName: string,
): Promise<ProjectResponse | null> {
  const query = buildQuery({ org_id: orgId, name: projectName, limit: '100', include_deleted: 'true' });
  const byName = await requestJson<ProjectListResponse>(context, `/projects${query}`);
  const exact = byName.data.find((project) => project.name === projectName || project.slug === projectName);
  if (exact) return exact;

  const all = await requestJson<ProjectListResponse>(context, `/projects${buildQuery({ org_id: orgId, limit: '100', include_deleted: 'true' })}`);
  return all.data.find((project) => project.name === projectName || project.slug === projectName) ?? null;
}

async function deployProject(
  context: ResolvedContext,
  workspace: ResolvedLocalMeshWorkspace,
  state: MeshProjectState,
  syncResult: UnifiedSyncResult,
): Promise<DeploymentResponse> {
  return requestJson<DeploymentResponse>(
    context,
    `/projects/${state.project!.id}/envs/${workspace.env}/deploy`,
    {
      method: 'POST',
      body: {
        ...(syncResult.git_sha ? { git_sha: syncResult.git_sha } : {}),
        manifest_hash: syncResult.manifest.manifest_hash,
        direct: workspace.defaults.direct,
      },
    },
  );
}

async function probeSubscription(
  context: ResolvedContext,
  workspace: ResolvedLocalMeshWorkspace,
  subscription: AppLinkSubscription,
  project: ProjectResponse,
): Promise<{ status: 'ok' | 'failed' | 'skipped'; message?: string }> {
  if (subscription.inject_into_services.length === 0) {
    return { status: 'skipped', message: 'not injected into services' };
  }
  const env = await requestRaw(context, `/projects/${project.id}/envs/${workspace.env}`, { allowError: true });
  if (!env.ok) {
    return { status: 'failed', message: formatResponseError(env) };
  }
  const namespace = (env.data as EnvironmentResponse).namespace;
  if (!namespace) {
    return { status: 'failed', message: 'environment has no namespace' };
  }

  const serviceName = subscription.inject_into_services[0]!;
  const deploymentName = toK8sName(`${workspace.env}-${serviceName}`, 'deployment');
  const deployment = kubectl(['-n', namespace, 'get', 'deployment', deploymentName, '-o', 'json'], undefined, true);
  if (deployment.status !== 0) {
    return { status: 'failed', message: deployment.stderr || deployment.stdout || `deployment/${deploymentName} not found` };
  }

  const parsed = JSON.parse(deployment.stdout) as { spec?: { template?: { spec?: { containers?: Array<{ env?: unknown[] }> } } } };
  const envVars = parsed.spec?.template?.spec?.containers?.[0]?.env;
  const prefix = appLinkEnvPrefix(subscription.local_alias);
  const clonedEnv = Array.isArray(envVars)
    ? envVars.filter((entry) => {
        const name = (entry as { name?: unknown }).name;
        return typeof name === 'string' && name.startsWith(`${prefix}_`);
      })
    : [];
  if (clonedEnv.length === 0) {
    return { status: 'failed', message: `deployment/${deploymentName} has no ${prefix}_* env vars` };
  }

  const jobName = toK8sName(`eve-link-probe-${subscription.local_alias}-${Date.now().toString(36)}`, 'job');
  const command = `curl -fsS -H "Authorization: Bearer $${prefix}_TOKEN" "$${prefix}_API_URL/health"`;
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 60,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'probe',
              image: 'curlimages/curl:8.8.0',
              env: clonedEnv,
              command: ['/bin/sh', '-c', command],
            },
          ],
        },
      },
    },
  };
  const applied = kubectl(['-n', namespace, 'apply', '-f', '-'], stringifyYaml(job), true);
  if (applied.status !== 0) {
    return { status: 'failed', message: applied.stderr || applied.stdout };
  }
  const waited = kubectl(['-n', namespace, 'wait', '--for=condition=complete', `job/${jobName}`, '--timeout=45s'], undefined, true);
  const logs = kubectl(['-n', namespace, 'logs', `job/${jobName}`], undefined, true);
  kubectl(['-n', namespace, 'delete', 'job', jobName, '--ignore-not-found=true'], undefined, true);
  if (waited.status !== 0) {
    return { status: 'failed', message: logs.stderr || logs.stdout || waited.stderr || waited.stdout };
  }
  return { status: 'ok', message: logs.stdout.trim() || 'probe passed' };
}

function kubectl(args: string[], input?: string, quiet = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.env.KUBECTL || 'kubectl', args, {
    input,
    encoding: 'utf-8',
    stdio: quiet ? 'pipe' : 'inherit',
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : result.error?.message ?? '',
  };
}

function getAppLinks(manifest: Record<string, unknown>): Record<string, unknown> | null {
  const xEve = (manifest['x-eve'] ?? manifest.x_eve) as Record<string, unknown> | undefined;
  const appLinks = xEve?.app_links;
  return appLinks && typeof appLinks === 'object' ? appLinks as Record<string, unknown> : null;
}

function getServiceXeve(service: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const xEve = (service?.['x-eve'] ?? service?.x_eve) as Record<string, unknown> | undefined;
  return xEve && typeof xEve === 'object' ? xEve : null;
}

function parseOnly(flags: Record<string, FlagValue>): string[] {
  const raw = getStringFlags(flags, ['only']);
  return raw.flatMap((entry) => entry.split(',').map((part) => part.trim()).filter(Boolean));
}

function assertWorkspaceHasProjects(workspace: ResolvedLocalMeshWorkspace): void {
  if (workspace.projects.length === 0) {
    throw new Error(`Workspace ${workspace.name} has no projects. Add one with: eve local mesh add <project> --path <path>`);
  }
}

function assertProjectSlug(value: string): void {
  if (!PROJECT_SLUG_RE.test(value)) {
    throw new Error(`Local mesh project "${value}" must be the Eve project slug: 4-8 alphanumeric characters starting with a letter.`);
  }
}

function assertLocalApi(context: ResolvedContext): void {
  if (!LOCAL_API_RE.test(context.apiUrl)) {
    throw new Error(`eve local mesh is k3d-only. Current API URL is ${context.apiUrl}. Use a local profile or set EVE_API_URL=http://api.eve.lvh.me`);
  }
}

function getGitBranch(cwd: string): string | null {
  const result = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf-8' });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function normalizeOrgId(value: string): string {
  const suffix = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `org_${suffix || 'localmesh'}`;
}

function normalizeOrgSlug(value: string): string {
  let slug = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) slug = 'localmesh';
  if (!/^[a-z]/.test(slug)) slug = `o${slug}`;
  return slug.slice(0, 12);
}

function appLinkEnvPrefix(alias: string): string {
  return `EVE_APP_LINK_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

function formatResponseError(response: { status: number; data: unknown; text: string }): string {
  if (typeof response.data === 'object' && response.data !== null) {
    const payload = response.data as { message?: unknown; error?: unknown };
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.error === 'string') return payload.error;
  }
  return response.text || `HTTP ${response.status}`;
}

function finishResults(results: MeshStepResult[], json: boolean, message: string): void {
  if (json) {
    outputJson({ results }, json);
  } else {
    printStatus(results);
  }
  const failed = results.find((result) => result.status === 'failed');
  if (failed) {
    throw new Error(`${failed.project} ${failed.action} failed${failed.message ? `: ${failed.message}` : ''}`);
  }
  if (!json) {
    console.log(message);
  }
}

function printStatus(results: MeshStepResult[]): void {
  if (results.length === 0) {
    console.log('No mesh rows.');
    return;
  }
  for (const result of results) {
    const bits = [
      result.status.toUpperCase().padEnd(7),
      result.project.padEnd(8),
      result.action.padEnd(8),
      result.env_status ? `env=${result.env_status}` : null,
      result.namespace ? `ns=${result.namespace}` : null,
      result.message,
    ].filter(Boolean);
    console.log(bits.join('  '));
    for (const link of result.links ?? []) {
      console.log(`         link ${link.alias}: ${link.status}${link.message ? ` (${link.message})` : ''}`);
    }
  }
}

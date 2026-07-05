import type { FlagValue } from '../lib/args';
import { getStringFlag, getStringFlags, toBoolean } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { formatDate } from '../lib/format';
import { resolveGitRef, getGitBranch } from '../lib/git.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { expandManifestReferences } from '@eve/shared';

// ============================================================================
// Types
// ============================================================================

interface Environment {
  id: string;
  project_id: string;
  name: string;
  type: 'persistent' | 'temporary';
  namespace: string | null;
  db_ref: string | null;
  overrides: Record<string, unknown> | null;
  ingress_aliases?: Array<{
    alias: string;
    service_name: string;
  }>;
  current_release_id: string | null;
  last_failed_release_id?: string | null;
  last_applied_release_id?: string | null;
  last_deploy_failure?: {
    kind?: string;
    service?: string;
    pod?: string;
    message?: string;
    namespace?: string;
    at?: string;
    [key: string]: unknown;
  } | null;
  deploy_status?: string;
  created_at: string;
  updated_at: string;
}

interface EnvironmentListResponse {
  data: Environment[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

interface ProjectManifest {
  id: string;
  project_id: string;
  manifest_yaml: string;
  manifest_hash: string;
  git_sha: string | null;
  branch: string | null;
  parsed_defaults: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentResponse {
  release?: {
    id: string;
    project_id: string;
    git_sha: string;
    manifest_hash: string;
    image_digests: Record<string, string> | null;
    version?: string | null;
    tag?: string | null;
    created_by: string | null;
    created_at: string;
  };
  pipeline_run?: PipelineRunDetail;
  environment: Environment;
  deployment_status?: DeploymentStatus;
  warnings?: string[];
  poll_url?: string;
}

interface PipelineRunDetail {
  run: {
    id: string;
    pipeline_name: string;
    env_name: string | null;
    git_sha: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  };
  steps: Array<{
    id: string;
    step_name: string;
    status: string;
  }>;
}

interface DeploymentStatus {
  env_id: string;
  current_release_id?: string | null;
  state: 'pending' | 'deploying' | 'ready' | 'failed' | 'unknown';
  message?: string | null;
  namespace?: string | null;
  k8s_status?: {
    ready: boolean;
    available_replicas: number;
    desired_replicas: number;
    conditions: Array<{ type: string; status: string; message?: string }>;
  } | null;
}

interface EnvHealthResponse {
  project_id: string;
  env_name: string;
  namespace: string | null;
  status: 'ready' | 'deploying' | 'degraded' | 'unknown';
  ready: boolean;
  deployment?: {
    ready: boolean;
    available_replicas: number;
    desired_replicas: number;
    conditions: Array<{ type: string; status: string; message?: string }>;
  } | null;
  warnings?: string[];
  checked_at: string;
  k8s_available: boolean;
}

interface EnvDiagnoseResponse {
  project_id: string;
  env_name: string;
  namespace: string | null;
  status: 'ready' | 'deploying' | 'degraded' | 'unknown';
  ready: boolean;
  k8s_available: boolean;
  deployments: Array<{
    name: string;
    ready: boolean;
    available_replicas: number;
    desired_replicas: number;
    conditions: Array<{ type: string; status: string; message?: string }>;
  }>;
  pods: Array<{
    name: string;
    namespace: string;
    phase: string;
    ready: boolean;
    restarts: number;
    age: string;
    labels: Record<string, string>;
  }>;
  events: Array<{
    type: string;
    reason: string | null;
    message: string | null;
    timestamp: string | null;
    involved_object: {
      kind: string;
      name: string;
      namespace: string;
    };
  }>;
  storage_buckets?: Array<{
    service_name: string;
    name: string;
    physical_name: string;
    visibility: 'private' | 'public';
    cors_json?: Record<string, unknown>;
    isolation_mode?: string | null;
    iam_role_arn?: string | null;
    iam_role_name?: string | null;
    service_account?: {
      name?: string | null;
      namespace?: string | null;
    } | null;
  }>;
  recent_email_delivery_events?: Array<{
    id: string;
    recipient: string;
    ses_message_id: string | null;
    rfc_message_id: string | null;
    event_type: string;
    bounce_type: string | null;
    bounce_subtype: string | null;
    diagnostic: string | null;
    received_at: string;
  }>;
  tcp_ingress?: Array<{
    service: string;
    provider: 'none' | 'aws-nlb' | 'klipper' | string;
    hostname?: string | null;
    external_hostname?: string | null;
    external_ip?: string | null;
    listeners: Array<{
      name: string;
      port: number;
      state: 'pending' | 'provisioning' | 'ready' | string;
      node_target_port?: number | null;
    }>;
  }>;
  http_ingress?: Array<{
    service: string;
    hosts: string[];
    controller_flavor: 'nginx' | 'traefik' | 'unknown' | string;
    requested_timeout_seconds: number | null;
    requested_max_body_size: string | null;
    effective_timeout_seconds: number | null;
    effective_max_body_size: string | null;
    timeout_source: 'manifest' | 'platform_default' | 'unsupported_controller' | 'missing' | string;
    max_body_size_source: 'manifest' | 'platform_default' | 'unsupported_controller' | 'missing' | string;
  }>;
  warnings?: string[];
  checked_at: string;
}

interface EnvRequestDiagnoseResponse {
  project_id: string;
  env_name: string;
  namespace: string | null;
  request_id: string;
  request_window: {
    first_seen: string | null;
    last_seen: string | null;
    searched_seconds: number;
  };
  deploy_at_request_time: {
    release_id: string | null;
    git_sha: string | null;
    manifest_hash: string | null;
    deployed_at: string | null;
  } | null;
  logs: Array<{ timestamp: string; service: string; line: string; pod?: string; container?: string }>;
  k8s_events: EnvDiagnoseResponse['events'];
  traces: {
    trace_id?: string | null;
    available: boolean;
    store?: string;
    hint?: string;
    spans?: Array<Record<string, unknown>>;
  };
  audit_log_entries?: Array<Record<string, unknown>>;
  warnings?: string[];
  checked_at: string;
}

interface EnvServiceSummary {
  name: string;
  pods_total: number;
  pods_ready: number;
  restarts: number;
  phases: string[];
}

interface EnvLogStreamEvent {
  timestamp?: string;
  line?: string;
  pod?: string;
  pod_name?: string;
  container?: string;
  service?: string;
  type?: string;
}

// ============================================================================
// Main Handler
// ============================================================================

export async function handleEnv(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'list':
      return handleList(positionals, flags, context, json);

    case 'show':
      return handleShow(positionals, flags, context, json);

    case 'create':
      return handleCreate(positionals, flags, context, json);

    case 'deploy':
      return handleDeploy(positionals, flags, context, json);

    case 'logs':
      return handleLogs(positionals, flags, context, json);

    case 'diagnose':
      return handleDiagnose(positionals, flags, context, json);

    case 'services':
      return handleServices(positionals, flags, context, json);

    case 'delete':
      return handleDelete(positionals, flags, context, json);

    case 'undeploy':
      return handleUndeploy(positionals, flags, context, json);

    case 'rollback':
      return handleRollback(positionals, flags, context, json);

    case 'reset':
      return handleReset(positionals, flags, context, json);

    case 'recover':
      return handleRecover(positionals, flags, context, json);

    case 'suspend':
      return handleSuspend(positionals, flags, context, json);

    case 'resume':
      return handleResume(positionals, flags, context, json);

    default:
      throw new Error(
        'Usage: eve env <list|show|create|deploy|undeploy|logs|diagnose|services|delete|rollback|reset|recover|suspend|resume>\n' +
        '  list [project]                          - list environments for a project\n' +
        '  show <project> <name>                   - show details of an environment\n' +
        '  create <name> --type=<type> [options]   - create an environment\n' +
        '  deploy <env> (--ref <sha>|--release-tag <tag>) [--direct] [--inputs <json>] [--repo-dir <path>] [--skip-preflight] - deploy to an environment\n' +
        '  undeploy <env> [--project=<id>] [--force] - tear down K8s resources, keep environment config\n' +
        '  logs <project> <env> <service> [--follow] [--since <seconds>] [--tail <n>] [--grep <text>] [--filter k=v] - get service logs\n' +
        '  diagnose <project> <env> [--request <id>] - diagnose deployment health, events, or one request\n' +
        '  services <project> <env>                - show per-service pod status summary\n' +
        '  delete <name> [--project=<id>] [--force] [--danger-delete-production] - delete an environment\n' +
        '  rollback <env> --release <id|tag|previous> [--project=<id>] [--skip-preflight] - rollback to a release\n' +
        '  reset <env> [--release <id|tag|previous>] [--project=<id>] [--force] [--danger-reset-production] [--skip-preflight] - teardown and redeploy\n' +
        '  recover <project> <env>                 - analyze environment and suggest recovery action\n' +
        '  suspend <project> <env> --reason "..."  - suspend an environment\n' +
        '  resume <project> <env>                  - resume a suspended environment',
      );
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * eve env list [project]
 * List environments for a project
 */
async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve env list [project] [--project=<id>]');
  }

  const query = buildQuery({
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<EnvironmentListResponse>(
    context,
    `/projects/${projectId}/envs${query}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.data.length === 0) {
      console.log('No environments found.');
      return;
    }
    formatEnvironmentsTable(response.data);
  }
}

/**
 * eve env show <project> <name>
 * Show details of an environment
 */
async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['name']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env show <project> <name> [--project=<id>] [--name=<name>]');
  }

  const response = await requestJson<Environment>(
    context,
    `/projects/${projectId}/envs/${envName}`,
  );

  const health = await requestJson<EnvHealthResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/health`,
  );

  if (json) {
    outputJson({ ...response, health }, json);
  } else {
    formatEnvironmentDetails(response, health);
  }
}

/**
 * eve env create <name> --type=<type> [--namespace=<ns>] [--db-ref=<ref>]
 * Create an environment
 */
async function handleCreate(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const name = positionals[0] ?? getStringFlag(flags, ['name']);
  const type = getStringFlag(flags, ['type']) as 'persistent' | 'temporary' | undefined;

  if (!projectId) {
    throw new Error('Usage: eve env create <name> --type=<type> [--project=<id>]');
  }

  if (!name) {
    throw new Error('Usage: eve env create <name> --type=<type>');
  }

  if (!type || !['persistent', 'temporary'].includes(type)) {
    throw new Error('--type must be either "persistent" or "temporary"');
  }

  const body: {
    name: string;
    type: 'persistent' | 'temporary';
    namespace?: string | null;
    db_ref?: string | null;
    overrides?: Record<string, unknown> | null;
  } = {
    name,
    type,
  };

  const namespace = getStringFlag(flags, ['namespace']);
  if (namespace) {
    body.namespace = namespace;
  }

  const dbRef = getStringFlag(flags, ['db-ref', 'dbRef']);
  if (dbRef) {
    body.db_ref = dbRef;
  }

  const response = await requestJson<Environment>(
    context,
    `/projects/${projectId}/envs`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`✓ Environment created: ${response.name} (${response.id})`);
    console.log(`  Type:      ${response.type}`);
    console.log(`  Namespace: ${response.namespace || '(none)'}`);
    console.log(`  DB Ref:    ${response.db_ref || '(none)'}`);
  }
}

/**
 * eve env deploy [project] <name> (--ref <sha>|--release-tag <tag>) [--direct] [--inputs <json>] [--image-tag <tag>]
 * Deploy to an environment
 * If project is in profile, can use: eve env deploy <name> --ref <sha>
 */
async function handleDeploy(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  // Smart positional parsing:
  // - 2 positionals: [project, envName]
  // - 1 positional + project in context: envName
  // - 1 positional + no project in context: assume it's project, error for missing name
  let projectId: string | undefined;
  let envName: string | undefined;

  const flagProject = getStringFlag(flags, ['project']);
  const flagName = getStringFlag(flags, ['name']);

  if (positionals.length >= 2) {
    projectId = positionals[0];
    envName = positionals[1];
  } else if (positionals.length === 1) {
    if (flagProject || context.projectId) {
      // Single positional is the env name
      projectId = flagProject ?? context.projectId;
      envName = positionals[0];
    } else {
      // Single positional must be project, no env name
      projectId = positionals[0];
    }
  } else {
    projectId = flagProject ?? context.projectId;
    envName = flagName;
  }

  if (!projectId || !envName) {
    throw new Error(
      'Usage: eve env deploy <env> (--ref <sha>|--release-tag <tag>) [--direct] [--inputs <json>] [--image-tag <tag>] [--repo-dir <path>] [--skip-preflight] [--project=<id>]',
    );
  }

  const ref = getStringFlag(flags, ['ref']);
  const releaseTag = getStringFlag(flags, ['release-tag', 'release_tag', 'releaseTag']);
  if ((ref && releaseTag) || (!ref && !releaseTag)) {
    throw new Error(
      'Usage: eve env deploy <env> (--ref <sha>|--release-tag <tag>) [options]\n\nProvide exactly one of --ref or --release-tag.',
    );
  }

  const repoDir = getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir']);
  let gitSha: string | undefined;
  let manifestHash: string | undefined;
  if (ref) {
    gitSha = await resolveGitRef(context, projectId, ref, repoDir);
    if (!json && ref !== gitSha) {
      console.log(`Resolved ref '${ref}' → ${gitSha.substring(0, 8)}...`);
    }

    if (!json) {
      console.log(`Deploying commit ${gitSha.substring(0, 8)} to ${envName}...`);
    }

    // Resolve manifest hash — sync from local repo if available, otherwise fetch from server
    if (repoDir) {
      const repoRoot = resolve(repoDir);
      const manifestPath = join(repoRoot, '.eve', 'manifest.yaml');
      if (existsSync(manifestPath)) {
        const rawManifestYaml = readFileSync(manifestPath, 'utf-8');
        const manifestYaml = expandManifestReferences(rawManifestYaml, {
          repoRoot,
          manifestPath,
        }).yaml;
        const branch = getGitBranch(repoRoot);
        const syncResponse = await requestJson<ProjectManifest>(
          context,
          `/projects/${projectId}/manifest`,
          {
            method: 'POST',
            body: {
              yaml: manifestYaml,
              git_sha: gitSha,
              branch,
            },
          },
        );
        manifestHash = syncResponse.manifest_hash;
        if (!json) {
          console.log(`Synced manifest ${manifestHash.substring(0, 8)}...`);
        }
      } else {
        const manifest = await requestJson<ProjectManifest>(
          context,
          `/projects/${projectId}/manifest`,
        );
        manifestHash = manifest.manifest_hash;
        if (!json) {
          console.log(`Using manifest ${manifestHash.substring(0, 8)}...`);
        }
      }
    } else {
      const manifest = await requestJson<ProjectManifest>(
        context,
        `/projects/${projectId}/manifest`,
      );
      manifestHash = manifest.manifest_hash;
      if (!json) {
        console.log(`Using manifest ${manifestHash.substring(0, 8)}...`);
      }
    }
  } else if (!json) {
    console.log(`Deploying release tag ${releaseTag} to ${envName}...`);
  }

  // Parse --direct flag (optional boolean)
  const direct = Boolean(flags.direct);

  // Parse --inputs flag (optional JSON)
  let inputs: Record<string, unknown> | undefined;
  const inputsString = getStringFlag(flags, ['inputs']);
  if (inputsString) {
    try {
      inputs = JSON.parse(inputsString);
      if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
        throw new Error('Inputs must be a JSON object');
      }
    } catch (error) {
      throw new Error(
        `Failed to parse --inputs JSON: ${error instanceof Error ? error.message : String(error)}\n` +
        'Example: --inputs \'{"release_id":"rel_xxx","smoke_test":false}\'',
      );
    }
  }

  // Parse --image-tag flag (optional)
  const imageTag = getStringFlag(flags, ['image-tag', 'image_tag', 'imageTag']);
  const skipPreflight = toBoolean(flags['skip-preflight']) ?? toBoolean(flags.skip_preflight) ?? false;

  // POST deployment
  const body: {
    git_sha?: string;
    manifest_hash?: string;
    release_tag?: string;
    skip_preflight?: boolean;
    direct?: boolean;
    inputs?: Record<string, unknown>;
    image_tag?: string;
  } = {
    ...(gitSha ? { git_sha: gitSha } : {}),
    ...(manifestHash ? { manifest_hash: manifestHash } : {}),
    ...(releaseTag ? { release_tag: releaseTag } : {}),
  };

  if (direct) {
    body.direct = true;
  }

  if (inputs) {
    body.inputs = inputs;
  }
  if (imageTag) {
    body.image_tag = imageTag;
  }
  if (skipPreflight) {
    body.skip_preflight = true;
  }

  const response = await requestJson<DeploymentResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/deploy`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.pipeline_run) {
      console.log('');
      console.log('Pipeline deployment started.');
      console.log(`  Pipeline Run: ${response.pipeline_run.run.id}`);
      console.log(`  Pipeline:     ${response.pipeline_run.run.pipeline_name}`);
      console.log(`  Status:       ${response.pipeline_run.run.status}`);
      console.log(`  Environment:  ${response.environment.name}`);

      const watchFlag = toBoolean(flags.watch);
      const shouldWatch = watchFlag ?? true;  // default: watch
      if (shouldWatch) {
        const timeoutRaw = getStringFlag(flags, ['timeout']);
        const timeoutSeconds = timeoutRaw ? parseInt(timeoutRaw, 10) : 300;  // 5 min default for pipeline
        const pipelineResult = await watchPipelineRun(
          context,
          projectId,
          response.pipeline_run.run.pipeline_name,
          response.pipeline_run.run.id,
          Number.isFinite(timeoutSeconds) ? timeoutSeconds : 300,
        );

        // After pipeline completes, watch deployment health if it succeeded
        if (pipelineResult === 'succeeded') {
          await watchDeploymentStatus(context, projectId, envName, 120);
        }
      }
      return;
    }

    console.log('');
    console.log(`Deployment submitted.`);
    if (response.release) {
      console.log(`  Release ID:  ${response.release.id}`);
    }
    console.log(`  Environment: ${response.environment.name}`);
    console.log(`  Namespace:   ${response.environment.namespace || '(none)'}`);

    if (response.deployment_status?.k8s_status) {
      const status = response.deployment_status.k8s_status;
      const readiness = `${status.available_replicas}/${status.desired_replicas}`;
      console.log(`  Status:      ${response.deployment_status.state} (${readiness} ready)`);
    } else if (response.deployment_status?.state) {
      console.log(`  Status:      ${response.deployment_status.state}`);
    }

    const warnings = response.warnings ?? getDeploymentWarnings(response.deployment_status);
    if (warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
    }

    const watchFlag = toBoolean(flags.watch);
    const shouldWatch = (watchFlag ?? true)
      && response.deployment_status?.state !== 'ready';
    if (shouldWatch) {
      const timeoutRaw = getStringFlag(flags, ['timeout']);
      const timeoutSeconds = timeoutRaw ? parseInt(timeoutRaw, 10) : 120;
      await watchDeploymentStatus(context, projectId, envName, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 120);
    }
  }
}

/**
 * eve env logs <project> <env> <service>
 * Fetch logs for a service in an environment (k8s-only)
 */
async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env', 'name']);
  const service = positionals[2] ?? getStringFlag(flags, ['service']);

  if (!projectId || !envName || !service) {
    throw new Error(
      'Usage: eve env logs <project> <env> <service> [--follow] [--since <seconds>] [--tail <n>] [--grep <text>] [--filter k=v] [--pod <name>] [--container <name>] [--previous] [--all-pods]',
    );
  }

  const filters = getStringFlags(flags, ['filter']);
  validateLogFilters(filters);
  const query = buildQuery({
    since: getStringFlag(flags, ['since']),
    tail: getStringFlag(flags, ['tail']),
    grep: getStringFlag(flags, ['grep']),
    filter: filters,
    pod: getStringFlag(flags, ['pod']),
    container: getStringFlag(flags, ['container']),
    previous: toBoolean(flags.previous) ?? undefined,
    all_pods: toBoolean(flags['all-pods']) ?? toBoolean(flags.all_pods) ?? undefined,
  });

  const follow = toBoolean(flags.follow) ?? toBoolean(flags.f) ?? false;
  if (follow) {
    await streamEnvLogs(context, projectId, envName, service, query, {
      showPodPrefix: toBoolean(flags['all-pods']) ?? toBoolean(flags.all_pods) ?? false,
    });
    return;
  }

  const response = await requestJson<{ logs: Array<{ timestamp: string; line: string; pod?: string; container?: string }> }>(
    context,
    `/projects/${projectId}/envs/${envName}/services/${service}/logs${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (!response.logs.length) {
    console.log('No logs found.');
    return;
  }

  for (const entry of response.logs) {
    const prefixParts = [];
    if (entry.pod) prefixParts.push(entry.pod);
    if (entry.container) prefixParts.push(entry.container);
    const prefix = prefixParts.length > 0 ? ` ${prefixParts.join('/')}` : '';
    console.log(`[${entry.timestamp}]${prefix} ${entry.line}`);
  }
}

/**
 * eve env diagnose <project> <env>
 * Diagnose deployment health for an environment (k8s-only)
 */
async function handleDiagnose(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env', 'name']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env diagnose <project> <env> [--events <n>] [--request <id>] [--window <seconds>]');
  }

  const query = buildQuery({
    events: getStringFlag(flags, ['events']),
    request_id: getStringFlag(flags, ['request', 'request-id']),
    window_seconds: getStringFlag(flags, ['window']),
  });

  const response = await requestJson<EnvDiagnoseResponse | EnvRequestDiagnoseResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/diagnose${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if ('request_id' in response) {
    formatEnvRequestDiagnose(response);
  } else {
    formatEnvDiagnose(response);
  }
}

/**
 * eve env services <project> <env>
 * Show a per-service summary using env diagnose data.
 */
async function handleServices(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env services <project> <env>');
  }

  const response = await requestJson<EnvDiagnoseResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/diagnose`,
  );

  const services = buildServiceSummaries(response);

  if (json) {
    outputJson(
      {
        project_id: response.project_id,
        env_name: response.env_name,
        namespace: response.namespace,
        status: response.status,
        ready: response.ready,
        checked_at: response.checked_at,
        services,
        deployments: response.deployments,
        warnings: response.warnings,
      },
      json,
    );
    return;
  }

  formatEnvServices(response, services);
}

/**
 * eve env delete <name> [--project=<id>] [--force] [--danger-delete-production]
 * Delete an environment
 */
async function handleDelete(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[0] ?? getStringFlag(flags, ['name']);
  const force = Boolean(flags.force);
  const dangerDeleteProduction = toBoolean(flags['danger-delete-production']) ?? toBoolean(flags.danger_delete_production) ?? false;

  if (!projectId || !envName) {
    throw new Error('Usage: eve env delete <name> [--project=<id>] [--force] [--danger-delete-production]');
  }

  const normalized = envName.trim().toLowerCase();
  if ((normalized === 'production' || normalized === 'prod') && !dangerDeleteProduction) {
    throw new Error('Deleting production requires --danger-delete-production');
  }

  // Prompt for confirmation unless --force is set
  if (!force) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
      const answer = await rl.question(`Are you sure you want to delete environment "${envName}"? [y/N]: `);
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log('Deletion cancelled.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  try {
    await requestJson<void>(
      context,
      `/projects/${projectId}/envs/${envName}`,
      {
        method: 'DELETE',
        ...(force ? { body: { force: true } } : {}),
      },
    );

    if (json) {
      outputJson({ success: true, environment: envName }, json);
    } else {
      console.log(`Environment "${envName}" deleted successfully.`);
    }
  } catch (error) {
    const err = error as Error;
    const message = err.message;

    // Handle specific error cases
    if (message.includes('404')) {
      throw new Error(`Environment "${envName}" not found in project ${projectId}`);
    } else if (message.includes('409')) {
      throw new Error(`Cannot delete environment "${envName}": environment has active deployments or resources`);
    } else {
      throw error;
    }
  }
}

/**
 * eve env undeploy <env> [--project=<id>] [--force]
 * Tear down K8s resources but keep environment configuration.
 */
async function handleUndeploy(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[0] ?? getStringFlag(flags, ['name', 'env']);
  const force = Boolean(flags.force);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env undeploy <env> [--project=<id>] [--force]');
  }

  const body: Record<string, unknown> = {};
  if (force) {
    body.force = true;
  }

  const response = await requestJson<Environment>(
    context,
    `/projects/${projectId}/envs/${envName}/undeploy`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`\u2713 Environment "${envName}" undeployed. Redeploy with: eve env deploy ${envName} --project ${projectId} ...`);
  }
}

/**
 * eve env rollback <env> --release <id|tag|previous> [--project=<id>]
 * Roll back an environment to a known release.
 */
async function handleRollback(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[0] ?? getStringFlag(flags, ['name', 'env']);
  const release = getStringFlag(flags, ['release']);
  const skipPreflight = toBoolean(flags['skip-preflight']) ?? toBoolean(flags.skip_preflight) ?? false;

  if (!projectId || !envName || !release) {
    throw new Error('Usage: eve env rollback <env> --release <id|tag|previous> [--project=<id>] [--skip-preflight]');
  }

  const response = await requestJson<DeploymentResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/rollback`,
    {
      method: 'POST',
      body: {
        release,
        ...(skipPreflight ? { skip_preflight: true } : {}),
      },
    },
  );

  if (json) {
    outputJson(response, true);
    return;
  }

  console.log(`Rollback submitted for environment ${envName}.`);
  if (response.release) {
    console.log(`  Release ID:  ${response.release.id}`);
    if (response.release.tag) {
      console.log(`  Release Tag: ${response.release.tag}`);
    }
  }
  if (response.deployment_status?.state) {
    console.log(`  Status:      ${response.deployment_status.state}`);
  }
}

/**
 * eve env reset <env> [--release <id|tag|previous>] [--force]
 * Tear down environment workloads and redeploy.
 */
async function handleReset(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[0] ?? getStringFlag(flags, ['name', 'env']);
  const release = getStringFlag(flags, ['release']);
  const force = toBoolean(flags.force) ?? false;
  const dangerResetProduction = toBoolean(flags['danger-reset-production']) ?? toBoolean(flags.danger_reset_production) ?? false;
  const skipPreflight = toBoolean(flags['skip-preflight']) ?? toBoolean(flags.skip_preflight) ?? false;

  if (!projectId || !envName) {
    throw new Error('Usage: eve env reset <env> [--release <id|tag|previous>] [--project=<id>] [--force] [--danger-reset-production] [--skip-preflight]');
  }

  const response = await requestJson<DeploymentResponse>(
    context,
    `/projects/${projectId}/envs/${envName}/reset`,
    {
      method: 'POST',
      body: {
        ...(release ? { release } : {}),
        ...(force ? { force: true } : {}),
        ...(dangerResetProduction ? { danger_reset_production: true } : {}),
        ...(skipPreflight ? { skip_preflight: true } : {}),
      },
    },
  );

  if (json) {
    outputJson(response, true);
    return;
  }

  console.log(`Environment reset completed for ${envName}.`);
  if (response.release) {
    console.log(`  Release ID:  ${response.release.id}`);
    if (response.release.tag) {
      console.log(`  Release Tag: ${response.release.tag}`);
    }
  }
  if (response.deployment_status?.state) {
    console.log(`  Status:      ${response.deployment_status.state}`);
  }
}

/**
 * eve env recover <project> <env>
 * Analyze environment state and suggest a recovery command.
 */
async function handleRecover(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env', 'name']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env recover <project> <env>');
  }

  const response = await requestJson<{
    project_id: string;
    env_name: string;
    active_pipeline_run_id: string | null;
    current_release_id: string | null;
    last_failed_release_id: string | null;
    suggested_command: string;
    summary: string;
    diagnose?: EnvDiagnoseResponse;
  }>(
    context,
    `/projects/${projectId}/envs/${envName}/recover`,
  );

  if (json) {
    outputJson(response, true);
    return;
  }

  console.log(`Recovery analysis for ${envName}`);
  console.log(`  Summary:          ${response.summary}`);
  console.log(`  Active Run:       ${response.active_pipeline_run_id ?? '(none)'}`);
  console.log(`  Current Release:  ${response.current_release_id ?? '(none)'}`);
  console.log(`  Last Failed:      ${response.last_failed_release_id ?? '(none)'}`);
  console.log('');
  console.log(`Suggested next step:`);
  console.log(`  ${response.suggested_command}`);
}

/**
 * eve env suspend <project> <env> --reason "..."
 * Suspend an environment (admin/org-owner)
 */
async function handleSuspend(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env', 'name']);
  const reason = getStringFlag(flags, ['reason']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env suspend <project> <env> --reason "..."');
  }

  if (!reason) {
    throw new Error('--reason is required for suspension');
  }

  const response = await requestJson<{
    id: string;
    name: string;
    status: string;
    suspended_at: string | null;
    suspension_reason: string | null;
  }>(
    context,
    `/projects/${projectId}/envs/${envName}/suspend`,
    {
      method: 'POST',
      body: { reason },
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Environment "${response.name}" suspended.`);
    console.log(`  Status:  ${response.status}`);
    console.log(`  Reason:  ${response.suspension_reason}`);
    if (response.suspended_at) {
      console.log(`  Since:   ${formatDate(response.suspended_at)}`);
    }
  }
}

/**
 * eve env resume <project> <env>
 * Resume a suspended environment (admin/org-owner)
 */
async function handleResume(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const envName = positionals[1] ?? getStringFlag(flags, ['env', 'name']);

  if (!projectId || !envName) {
    throw new Error('Usage: eve env resume <project> <env>');
  }

  const response = await requestJson<{
    id: string;
    name: string;
    status: string;
    suspended_at: string | null;
    suspension_reason: string | null;
  }>(
    context,
    `/projects/${projectId}/envs/${envName}/resume`,
    {
      method: 'POST',
      body: {},
    },
  );

  if (json) {
    outputJson(response, json);
  } else {
    console.log(`Environment "${response.name}" resumed.`);
    console.log(`  Status: ${response.status}`);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build query string from parameters
 */
function buildQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== '') {
          search.append(key, String(item));
        }
      }
      return;
    }
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

function validateLogFilters(filters: string[]): void {
  for (const filter of filters) {
    const eqIndex = filter.indexOf('=');
    if (eqIndex <= 0) {
      throw new Error('--filter must use k=v syntax');
    }
    const key = filter.slice(0, eqIndex).trim();
    if (!key) {
      throw new Error('--filter key must not be empty');
    }
  }
}

async function streamEnvLogs(
  context: ResolvedContext,
  projectId: string,
  envName: string,
  service: string,
  query: string,
  options: { showPodPrefix: boolean },
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const url = `${context.apiUrl}/projects/${projectId}/envs/${envName}/services/${service}/logs/stream${query}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
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
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.slice(5).trim();
      } else if (line === '' && eventData) {
        processEnvLogSseEvent(eventType, eventData, options);
        eventType = '';
        eventData = '';
      }
    }
  }
}

function processEnvLogSseEvent(
  eventType: string,
  dataStr: string,
  options: { showPodPrefix: boolean },
): void {
  let data: EnvLogStreamEvent;
  try {
    data = JSON.parse(dataStr) as EnvLogStreamEvent;
  } catch {
    return;
  }

  if (eventType === 'heartbeat') {
    return;
  }
  if (eventType === 'pod_changed') {
    const pod = data.pod_name ?? data.pod ?? 'unknown';
    console.log(`--- attached to ${pod} ---`);
    return;
  }
  if (eventType !== 'log') {
    return;
  }

  const timestamp = data.timestamp ?? new Date().toISOString();
  const pod = data.pod_name ?? data.pod;
  const prefixParts = [];
  if (options.showPodPrefix && pod) prefixParts.push(pod);
  if (data.container) prefixParts.push(data.container);
  const prefix = prefixParts.length > 0 ? ` ${prefixParts.join('/')}` : '';
  console.log(`[${timestamp}]${prefix} ${data.line ?? ''}`);
}

/**
 * Format environments as a human-readable table
 */
function formatEnvironmentsTable(environments: Environment[]): void {
  if (environments.length === 0) {
    console.log('No environments found.');
    return;
  }

  // Calculate column widths
  const nameWidth = Math.max(4, ...environments.map((e) => e.name.length));
  const typeWidth = Math.max(4, ...environments.map((e) => e.type.length));
  const namespaceWidth = Math.max(9, ...environments.map((e) => e.namespace?.length ?? 0));

  // Header
  const header = [
    padRight('Name', nameWidth),
    padRight('Type', typeWidth),
    padRight('Namespace', namespaceWidth),
    'Current Release',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const env of environments) {
    const releaseDisplay = env.current_release_id
      ? env.current_release_id.substring(0, 12) + '...'
      : '-';

    const row = [
      padRight(env.name, nameWidth),
      padRight(env.type, typeWidth),
      padRight(env.namespace || '-', namespaceWidth),
      releaseDisplay,
    ].join('  ');

    console.log(row);
  }

  console.log('');
  console.log(`Total: ${environments.length} environment(s)`);
}

/**
 * Format a single environment's details
 */
function formatEnvironmentDetails(env: Environment, health?: EnvHealthResponse): void {
  console.log(`Environment: ${env.name}`);
  console.log('');
  console.log(`  ID:              ${env.id}`);
  console.log(`  Project:         ${env.project_id}`);
  console.log(`  Type:            ${env.type}`);
  console.log(`  Namespace:       ${env.namespace || '(none)'}`);
  console.log(`  Database Ref:    ${env.db_ref || '(none)'}`);
  console.log(`  Current Release: ${env.current_release_id || '(none)'}${env.current_release_id ? ' (last ready)' : ''}`);
  if (env.last_applied_release_id && env.last_applied_release_id !== env.current_release_id) {
    console.log(`  Last Applied:    ${env.last_applied_release_id} (DRIFT — cluster differs from last-ready)`);
  } else if (env.last_applied_release_id) {
    console.log(`  Last Applied:    ${env.last_applied_release_id}`);
  }
  console.log(`  Last Failed:     ${env.last_failed_release_id || '(none)'}`);
  if (env.last_deploy_failure) {
    const f = env.last_deploy_failure;
    const when = f.at ? ` (${f.at})` : '';
    const what = f.service ? ` on ${f.service}${f.pod ? `/${f.pod}` : ''}` : '';
    console.log(`  Last Failure:    ${f.kind ?? 'unknown'}${what}${when}`);
    if (f.message) {
      console.log(`    ${f.message}`);
    }
    console.log(`    Run \`eve env diagnose ${env.project_id} ${env.name}\` for details.`);
  }
  if (env.deploy_status) {
    console.log(`  Deploy Status:   ${env.deploy_status}`);
  }
  if (env.ingress_aliases && env.ingress_aliases.length > 0) {
    console.log('  Ingress Aliases:');
    for (const entry of env.ingress_aliases) {
      console.log(`    ${entry.alias} -> ${entry.service_name}`);
    }
  }

  if (health) {
    console.log('');
    console.log(`  Deployment Status: ${health.status}`);
    if (health.deployment) {
      console.log(
        `  Deployment Ready:  ${health.deployment.available_replicas}/${health.deployment.desired_replicas}`
      );
    }
    if (health.warnings && health.warnings.length > 0) {
      console.log('  Warnings:');
      for (const warning of health.warnings) {
        console.log(`    - ${warning}`);
      }
    }
  }

  if (env.overrides && Object.keys(env.overrides).length > 0) {
    console.log('');
    console.log('  Overrides:');
    for (const [key, value] of Object.entries(env.overrides)) {
      console.log(`    ${key}: ${JSON.stringify(value)}`);
    }
  }

  console.log('');
  console.log(`  Created:         ${formatDate(env.created_at)}`);
  console.log(`  Updated:         ${formatDate(env.updated_at)}`);
}

function buildServiceSummaries(report: EnvDiagnoseResponse): EnvServiceSummary[] {
  const summaries = new Map<string, EnvServiceSummary>();

  for (const pod of report.pods) {
    const component = getPodComponent(pod.labels);
    const existing = summaries.get(component) ?? {
      name: component,
      pods_total: 0,
      pods_ready: 0,
      restarts: 0,
      phases: [],
    };

    existing.pods_total += 1;
    if (pod.ready) {
      existing.pods_ready += 1;
    }
    existing.restarts += pod.restarts;
    if (!existing.phases.includes(pod.phase)) {
      existing.phases.push(pod.phase);
    }

    summaries.set(component, existing);
  }

  return Array.from(summaries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function formatEnvServices(report: EnvDiagnoseResponse, services: EnvServiceSummary[]): void {
  console.log(`Environment Services: ${report.env_name}`);
  console.log('');
  console.log(`  Namespace: ${report.namespace || '(none)'}`);
  console.log(`  Status:    ${report.status}`);
  console.log(`  Ready:     ${report.ready ? 'yes' : 'no'}`);
  console.log(`  K8s:       ${report.k8s_available ? 'available' : 'unavailable'}`);

  if (report.warnings && report.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (services.length === 0) {
    console.log('');
    console.log('No service pods found.');
  } else {
    console.log('');
    console.log('Services (from pods):');
    const nameWidth = Math.max(7, ...services.map((s) => s.name.length));
    const totalWidth = Math.max(4, ...services.map((s) => String(s.pods_total).length));
    const readyWidth = Math.max(5, ...services.map((s) => String(s.pods_ready).length));
    const restartsWidth = Math.max(8, ...services.map((s) => String(s.restarts).length));
    const phasesWidth = Math.max(6, ...services.map((s) => s.phases.join(', ').length));
    const header = [
      padRight('Service', nameWidth),
      padRight('Pods', totalWidth),
      padRight('Ready', readyWidth),
      padRight('Restarts', restartsWidth),
      padRight('Phases', phasesWidth),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const service of services) {
      console.log([
        padRight(service.name, nameWidth),
        padRight(String(service.pods_total), totalWidth),
        padRight(String(service.pods_ready), readyWidth),
        padRight(String(service.restarts), restartsWidth),
        padRight(service.phases.join(', '), phasesWidth),
      ].join('  '));
    }
  }

  if (report.deployments.length > 0) {
    console.log('');
    console.log('Deployments:');
    const nameWidth = Math.max(4, ...report.deployments.map((d) => d.name.length));
    const readyWidth = Math.max(5, ...report.deployments.map((d) => `${d.available_replicas}/${d.desired_replicas}`.length));
    const header = [
      padRight('Name', nameWidth),
      padRight('Ready', readyWidth),
      'Status',
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const deployment of report.deployments) {
      const readiness = `${deployment.available_replicas}/${deployment.desired_replicas}`;
      const status = deployment.ready ? 'ready' : 'not-ready';
      console.log([
        padRight(deployment.name, nameWidth),
        padRight(readiness, readyWidth),
        status,
      ].join('  '));
    }
  }
}

function getPodComponent(labels: Record<string, string>): string {
  return (
    labels['eve.component'] ||
    labels['app.kubernetes.io/name'] ||
    labels['app'] ||
    labels['component'] ||
    'unknown'
  );
}

function summarizeIngressTuningSource(timeoutSource: string, bodySource: string): string {
  if (timeoutSource === bodySource) {
    return timeoutSource;
  }
  return `timeout:${timeoutSource},body:${bodySource}`;
}

function formatEnvDiagnose(report: EnvDiagnoseResponse): void {
  console.log(`Environment Diagnose: ${report.env_name}`);
  console.log('');
  console.log(`  Namespace: ${report.namespace || '(none)'}`);
  console.log(`  Status:    ${report.status}`);
  console.log(`  Ready:     ${report.ready ? 'yes' : 'no'}`);
  console.log(`  K8s:       ${report.k8s_available ? 'available' : 'unavailable'}`);

  if (report.warnings && report.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (report.deployments.length > 0) {
    console.log('');
    console.log('Deployments:');
    const nameWidth = Math.max(4, ...report.deployments.map((d) => d.name.length));
    const readyWidth = Math.max(5, ...report.deployments.map((d) => `${d.available_replicas}/${d.desired_replicas}`.length));
    const header = [
      padRight('Name', nameWidth),
      padRight('Ready', readyWidth),
      'Status',
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const deployment of report.deployments) {
      const readiness = `${deployment.available_replicas}/${deployment.desired_replicas}`;
      const status = deployment.ready ? 'ready' : 'not-ready';
      console.log([
        padRight(deployment.name, nameWidth),
        padRight(readiness, readyWidth),
        status,
      ].join('  '));
    }
  }

  if (report.pods.length > 0) {
    console.log('');
    console.log('Pods:');
    const nameWidth = Math.max(4, ...report.pods.map((p) => p.name.length));
    const phaseWidth = Math.max(5, ...report.pods.map((p) => p.phase.length));
    const restartsWidth = Math.max(8, ...report.pods.map((p) => String(p.restarts).length));
    const header = [
      padRight('Name', nameWidth),
      padRight('Phase', phaseWidth),
      padRight('Restarts', restartsWidth),
      'Ready',
      'Age',
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const pod of report.pods) {
      console.log([
        padRight(pod.name, nameWidth),
        padRight(pod.phase, phaseWidth),
        padRight(String(pod.restarts), restartsWidth),
        pod.ready ? 'yes' : 'no',
        pod.age,
      ].join('  '));
    }
  }

  if (report.storage_buckets && report.storage_buckets.length > 0) {
    console.log('');
    console.log('Storage Buckets:');
    const serviceWidth = Math.max(7, ...report.storage_buckets.map((b) => b.service_name.length));
    const nameWidth = Math.max(4, ...report.storage_buckets.map((b) => b.name.length));
    const physicalWidth = Math.max(8, ...report.storage_buckets.map((b) => b.physical_name.length));
    const isolationWidth = Math.max(9, ...report.storage_buckets.map((b) => (b.isolation_mode ?? '').length));
    const header = [
      padRight('Service', serviceWidth),
      padRight('Name', nameWidth),
      padRight('Physical', physicalWidth),
      padRight('Isolation', isolationWidth),
      'Visibility',
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const bucket of report.storage_buckets) {
      console.log([
        padRight(bucket.service_name, serviceWidth),
        padRight(bucket.name, nameWidth),
        padRight(bucket.physical_name, physicalWidth),
        padRight(bucket.isolation_mode ?? '-', isolationWidth),
        bucket.visibility,
      ].join('  '));
    }
  }

  if (report.http_ingress && report.http_ingress.length > 0) {
    console.log('');
    console.log('HTTP Ingress:');
    const rows = report.http_ingress.map((entry) => ({
      service: entry.service,
      controller: entry.controller_flavor,
      hosts: entry.hosts.length > 0 ? entry.hosts.join(', ') : '(none)',
      timeout: entry.effective_timeout_seconds == null
        ? '-'
        : `${entry.effective_timeout_seconds}s`,
      body: entry.effective_max_body_size ?? '-',
      source: summarizeIngressTuningSource(entry.timeout_source, entry.max_body_size_source),
    }));
    const serviceWidth = Math.max(7, ...rows.map((r) => r.service.length));
    const controllerWidth = Math.max(10, ...rows.map((r) => r.controller.length));
    const timeoutWidth = Math.max(7, ...rows.map((r) => r.timeout.length));
    const bodyWidth = Math.max(8, ...rows.map((r) => r.body.length));
    const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));
    const hostWidth = Math.max(4, ...rows.map((r) => r.hosts.length));
    const header = [
      padRight('Service', serviceWidth),
      padRight('Controller', controllerWidth),
      padRight('Timeout', timeoutWidth),
      padRight('MaxBody', bodyWidth),
      padRight('Source', sourceWidth),
      padRight('Host', hostWidth),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const row of rows) {
      console.log([
        padRight(row.service, serviceWidth),
        padRight(row.controller, controllerWidth),
        padRight(row.timeout, timeoutWidth),
        padRight(row.body, bodyWidth),
        padRight(row.source, sourceWidth),
        padRight(row.hosts, hostWidth),
      ].join('  '));
    }
  }

  if (report.tcp_ingress && report.tcp_ingress.length > 0) {
    console.log('');
    console.log('TCP Ingress:');
    const rows = report.tcp_ingress.flatMap((entry) => {
      const host = entry.hostname ?? entry.external_hostname ?? entry.external_ip ?? '(pending)';
      return entry.listeners.map((listener) => ({
        service: entry.service,
        provider: entry.provider,
        host,
        listener: listener.name,
        port: String(listener.port),
        state: listener.state,
        nodePort: listener.node_target_port == null ? '-' : String(listener.node_target_port),
      }));
    });
    const serviceWidth = Math.max(7, ...rows.map((r) => r.service.length));
    const providerWidth = Math.max(8, ...rows.map((r) => r.provider.length));
    const hostWidth = Math.max(4, ...rows.map((r) => r.host.length));
    const listenerWidth = Math.max(8, ...rows.map((r) => r.listener.length));
    const portWidth = Math.max(4, ...rows.map((r) => r.port.length));
    const stateWidth = Math.max(5, ...rows.map((r) => r.state.length));
    const nodePortWidth = Math.max(8, ...rows.map((r) => r.nodePort.length));
    const header = [
      padRight('Service', serviceWidth),
      padRight('Provider', providerWidth),
      padRight('Host', hostWidth),
      padRight('Listener', listenerWidth),
      padRight('Port', portWidth),
      padRight('State', stateWidth),
      padRight('NodePort', nodePortWidth),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const row of rows) {
      console.log([
        padRight(row.service, serviceWidth),
        padRight(row.provider, providerWidth),
        padRight(row.host, hostWidth),
        padRight(row.listener, listenerWidth),
        padRight(row.port, portWidth),
        padRight(row.state, stateWidth),
        padRight(row.nodePort, nodePortWidth),
      ].join('  '));
    }
  }

  if (report.events.length > 0) {
    console.log('');
    console.log('Events:');
    for (const event of report.events) {
      const timestamp = event.timestamp ?? 'unknown';
      const reason = event.reason ?? 'Unknown';
      const message = event.message ?? '';
      console.log(`  [${timestamp}] ${event.type} ${reason}: ${message}`);
    }
  }

  if (report.recent_email_delivery_events && report.recent_email_delivery_events.length > 0) {
    console.log('');
    console.log('Recent Email Delivery Events (org members):');
    for (const ev of report.recent_email_delivery_events) {
      const summary = [ev.bounce_type, ev.bounce_subtype].filter(Boolean).join('/');
      console.log(`  [${ev.received_at}] ${ev.event_type}${summary ? ` (${summary})` : ''} → ${ev.recipient}`);
      if (ev.diagnostic) {
        console.log(`    ${ev.diagnostic.split('\n')[0].slice(0, 140)}`);
      }
    }
  }
}

function formatEnvRequestDiagnose(report: EnvRequestDiagnoseResponse): void {
  console.log(`Request Diagnose: ${report.request_id}`);
  console.log('');
  console.log(`  Environment: ${report.env_name}`);
  console.log(`  Namespace:   ${report.namespace || '(none)'}`);
  console.log(`  Window:      ${report.request_window.searched_seconds}s`);
  console.log(`  First Seen:  ${report.request_window.first_seen ?? '(not found)'}`);
  console.log(`  Last Seen:   ${report.request_window.last_seen ?? '(not found)'}`);

  if (report.deploy_at_request_time) {
    console.log('');
    console.log('Deploy:');
    console.log(`  Release: ${report.deploy_at_request_time.release_id ?? '(unknown)'}`);
    console.log(`  Git SHA: ${report.deploy_at_request_time.git_sha ?? '(unknown)'}`);
    console.log(`  At:      ${report.deploy_at_request_time.deployed_at ?? '(unknown)'}`);
  }

  if (report.warnings?.length) {
    console.log('');
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  console.log('');
  console.log(`Logs (${report.logs.length}):`);
  for (const entry of report.logs.slice(0, 100)) {
    const pod = entry.pod ? ` ${entry.pod}` : '';
    console.log(`  [${entry.timestamp}] ${entry.service}${pod} ${entry.line}`);
  }
  if (report.logs.length > 100) {
    console.log(`  ... ${report.logs.length - 100} more log line(s) omitted`);
  }

  console.log('');
  console.log(`K8s Events (${report.k8s_events.length}):`);
  for (const event of report.k8s_events.slice(0, 20)) {
    console.log(`  [${event.timestamp ?? 'unknown'}] ${event.type} ${event.reason ?? 'Unknown'}: ${event.message ?? ''}`);
  }

  console.log('');
  console.log('Traces:');
  console.log(`  Store:     ${report.traces.store ?? 'unknown'}`);
  console.log(`  Available: ${report.traces.available ? 'yes' : 'no'}`);
  if (report.traces.trace_id) {
    console.log(`  Trace ID:  ${report.traces.trace_id}`);
  }
  if (report.traces.hint) {
    console.log(`  Hint:      ${report.traces.hint}`);
  }
  if (report.traces.spans?.length) {
    console.log(`  Spans:     ${report.traces.spans.length}`);
  }

  if (report.audit_log_entries) {
    console.log('');
    console.log(`Audit Rows: ${report.audit_log_entries.length}`);
  }
}

function getDeploymentWarnings(status?: DeploymentStatus): string[] {
  if (!status) return [];
  const warnings: string[] = [];
  if (status.state !== 'ready') {
    warnings.push(`Deployment state: ${status.state}`);
  }
  if (status.k8s_status) {
    const { available_replicas, desired_replicas, ready, conditions } = status.k8s_status;
    if (!ready) {
      warnings.push(`Deployment replicas not ready (${available_replicas}/${desired_replicas})`);
    }
    for (const condition of conditions) {
      if (condition.status !== 'True' && condition.message) {
        warnings.push(`${condition.type}: ${condition.message}`);
      }
    }
  }
  return Array.from(new Set(warnings));
}

/**
 * Poll a pipeline run until it reaches a terminal status.
 * Returns the final status string.
 */
async function watchPipelineRun(
  context: ResolvedContext,
  projectId: string,
  pipelineName: string,
  runId: string,
  timeoutSeconds: number,
): Promise<string> {
  const start = Date.now();
  const pollIntervalMs = 3000;
  const terminalStatuses = ['succeeded', 'failed', 'cancelled'];

  console.log('');
  console.log('Watching pipeline run...');

  while ((Date.now() - start) / 1000 < timeoutSeconds) {
    const detail = await requestJson<PipelineRunDetail>(
      context,
      `/projects/${projectId}/pipelines/${pipelineName}/runs/${runId}`,
    );

    const elapsed = Math.floor((Date.now() - start) / 1000);
    const stepSummary = detail.steps
      .map(s => `${s.step_name}:${s.status}`)
      .join(', ');

    console.log(`  [${elapsed}s] ${detail.run.status} (${stepSummary || 'no steps'})`);

    if (terminalStatuses.includes(detail.run.status)) {
      if (detail.run.status === 'succeeded') {
        console.log('  Pipeline run succeeded.');
      } else if (detail.run.status === 'failed') {
        console.log(`  Pipeline run failed.`);
        // Show error from failed steps
        for (const step of detail.steps) {
          if (step.status === 'failed') {
            console.log(`    Step "${step.step_name}" failed.`);
          }
        }
      } else {
        console.log(`  Pipeline run ${detail.run.status}.`);
      }
      return detail.run.status;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.log(`  Pipeline run did not complete within ${timeoutSeconds}s.`);
  console.log(`  Run "eve pipeline show-run ${pipelineName} ${runId}" to check status.`);
  return 'timeout';
}

async function watchDeploymentStatus(
  context: ResolvedContext,
  projectId: string,
  envName: string,
  timeoutSeconds: number,
): Promise<void> {
  const start = Date.now();
  const pollIntervalMs = 3000;
  console.log('');
  console.log('Watching deployment status...');
  while ((Date.now() - start) / 1000 < timeoutSeconds) {
    const health = await requestJson<EnvHealthResponse>(
      context,
      `/projects/${projectId}/envs/${envName}/health`,
    );
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const readiness = health.deployment
      ? `${health.deployment.available_replicas}/${health.deployment.desired_replicas}`
      : 'n/a';
    console.log(`  [${elapsed}s] ${health.status} (${readiness} ready)`);

    if (health.ready) {
      console.log('  Deployment is ready.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  console.log(`  Timeout after ${timeoutSeconds}s. Run "eve env diagnose ${projectId} ${envName}" for details.`);
}

/**
 * Pad a string to the right with spaces
 */
function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

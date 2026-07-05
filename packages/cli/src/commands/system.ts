import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { buildQuery } from '../lib/format';

// ============================================================================
// Types
// ============================================================================

interface HealthResponse {
  status: string;
  database?: string;
  version?: string;
  timestamp?: string;
}

interface ServiceStatus {
  status: string;
  ready: boolean;
  replicas?: number;
}

interface SystemStatusResponse {
  api: {
    status: string;
    version?: string;
  };
  orchestrator?: ServiceStatus;
  agent_runtime?: ServiceStatus;
  worker?: ServiceStatus;
  postgres?: {
    status: string;
    ready: boolean;
  };
  queue?: {
    ready: number;
    active: number;
    blocked: number;
  };
}

interface Job {
  id: string;
  project_id: string;
  title: string;
  phase: string;
  assignee?: string | null;
  priority: number;
  issue_type: string;
  created_at: string;
  updated_at: string;
}

interface JobListResponse {
  jobs: Job[];
  total?: number;
}

interface Environment {
  id: string;
  project_id: string;
  name: string;
  type: string;
  namespace?: string | null;
  current_release?: string | null;
  created_at: string;
  updated_at: string;
}

interface EnvironmentListResponse {
  environments: Environment[];
  total?: number;
}

interface LogEntry {
  timestamp: string;
  line: string;
}

interface PodInfo {
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  restarts: number;
  age: string;
  labels: Record<string, string>;
  component?: string;
  orgId?: string;
  projectId?: string;
  env?: string;
}

interface EventInfo {
  type: string;
  reason: string;
  message: string;
  timestamp: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace: string;
  };
}

interface ConfigSummary {
  namespace: string;
  clusterVersion?: string;
  nodeCount?: number;
  deployments: string[];
}

interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface OrchestratorStatusResponse {
  limit: number;
  inFlight: number;
  uptimeSeconds: number;
  lastChange: string;
  tuner?: {
    enabled: boolean;
    mode?: string;
    currentLimit?: number;
  };
}

interface EnvironmentCostRow {
  environment_id: string;
  org_id: string | null;
  project_id: string | null;
  environment_slug: string | null;
  amount_usd: string;
  shared_amount_usd: string | null;
  confidence: string;
  observed_at: string;
}

interface EnvironmentCostResponse {
  window: {
    month: string;
    start: string;
    end: string | null;
  };
  source: string;
  total_usd: string;
  env_total_usd: string;
  shared_usd: string;
  env_count: number;
  observed_at: string | null;
  stale: boolean;
  stale_after_hours: number;
  environments: EnvironmentCostRow[];
}

interface CloudCostResponse {
  window: {
    month: string;
    start: string;
    end: string | null;
    mtd_through: string | null;
  };
  provider: string | null;
  source: string | null;
  scope: {
    type: string;
    key: string;
    label: string | null;
  };
  amount: string | null;
  projected_amount: string | null;
  currency: string | null;
  confidence: string;
  coverage: string;
  observed_at: string | null;
  stale: boolean;
  stale_after_hours: number;
  filter: Record<string, unknown>;
  breakdown: Record<string, unknown>;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * System administration commands.
 *
 * NOTE: When auth is implemented, these commands should be restricted to
 * system administrators only - not regular org users.
 */
export async function handleSystem(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'status':
      return handleStatus(context, json);

    case 'health':
      return handleHealth(context, json);

    case 'jobs':
      return handleJobs(flags, context, json);

    case 'envs':
      return handleEnvs(flags, context, json);

    case 'logs':
      return handleLogs(positionals, flags, context, json);

    case 'pods':
      return handlePods(context, json);

    case 'events':
      return handleEvents(flags, context, json);

    case 'config':
      return handleConfig(context, json);

    case 'settings':
      return handleSettings(positionals, flags, context, json);

    case 'orchestrator':
      return handleOrchestrator(positionals, flags, context, json);

    case 'env-health':
      return handleEnvHealth(context, flags);

    case 'env-cost':
      return handleEnvCost(context, flags);

    case 'cloud-cost':
      return handleCloudCost(context, flags);

    default:
      throw new Error('Usage: eve system <status|health|jobs|envs|env-health|env-cost|cloud-cost|logs|pods|events|config|settings|orchestrator>');
  }
}

// ============================================================================
// Subcommand Handlers
// ============================================================================

/**
 * eve system status
 * Show comprehensive system status via API endpoint.
 *
 * Note: This calls GET /system/status on the API. The API is responsible for
 * aggregating health from internal services (orchestrator, worker, etc.).
 * The CLI only talks to the API - never directly to other services.
 */
async function handleStatus(
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  try {
    // Try the full system status endpoint first
    const status = await requestJson<SystemStatusResponse>(context, '/system/status');

    if (json) {
      outputJson(status, json);
    } else {
      formatStatus(status);
    }
  } catch (error) {
    // If /system/status is missing, fall back to basic health check
    const err = error as Error;
    if (err.message?.includes('HTTP 404')) {
      console.log('Note: /system/status not available on this API version.');
      console.log('Falling back to basic health check...');
      console.log('');
      return handleHealth(context, json);
    }
    throw error;
  }
}

/**
 * eve system health
 * Quick health check of the API.
 *
 * Note: This only checks the API's health endpoint. The API is the gateway -
 * if the API is healthy and connected to the database, the system is operational.
 */
async function handleHealth(
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  try {
    // Use allowError so we can read the response body on 503 (DB down)
    const response = await requestRaw(context, '/health', { allowError: true });
    const health = (response.data ?? {}) as HealthResponse;

    if (json) {
      outputJson(health, json);
    } else {
      const isHealthy = response.ok && (health.status === 'ok' || health.status === 'healthy');
      const icon = isHealthy ? '✓' : '✗';
      const statusLabel = isHealthy ? 'Healthy' : 'Degraded';

      console.log('System Health Check');
      console.log('═══════════════════════════════════════');
      console.log('');
      console.log(`  ${icon} API: ${statusLabel}`);
      if (health.database) {
        console.log(`      Database: ${health.database}`);
      }
      if (health.version) {
        console.log(`      Version: ${health.version}`);
      }
      console.log('');

      if (isHealthy) {
        console.log('API is operational.');
      } else {
        console.log('API is degraded. Check server logs and database connectivity.');
      }
    }
  } catch (error) {
    const err = error as Error;

    if (json) {
      outputJson({
        api: { healthy: false, error: err.message },
      }, json);
    } else {
      console.log('System Health Check');
      console.log('═══════════════════════════════════════');
      console.log('');
      console.log('  ✗ API: Unreachable');
      console.log(`      ${err.message}`);
      console.log('');
      console.log(`Make sure the API is running and EVE_API_URL is set correctly.`);
      console.log(`Current: ${context.apiUrl}`);
    }
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatStatus(status: SystemStatusResponse): void {
  console.log('╭────────────────────────────────────────────────────────────────╮');
  console.log('│                      System Status                             │');
  console.log('╰────────────────────────────────────────────────────────────────╯');
  console.log('');

  // Services
  const apiHealthy = status.api.status === 'healthy';
  const orchHealthy = status.orchestrator?.ready ?? false;
  const arHealthy = status.agent_runtime?.ready ?? true;
  const workerHealthy = status.worker?.ready ?? false;

  console.log('Services:');
  formatServiceHealth('  API', apiHealthy, status.api.version);
  if (status.orchestrator) {
    formatServiceHealth('  Orchestrator', orchHealthy);
  }
  if (status.agent_runtime) {
    formatServiceHealth('  Agent Runtime', arHealthy, undefined, status.agent_runtime.replicas);
  }
  if (status.worker) {
    formatServiceHealth('  Worker', workerHealthy);
  }
  console.log('');

  // Queue
  if (status.queue) {
    console.log('Job Queue:');
    console.log(`  Ready:    ${status.queue.ready}`);
    console.log(`  Active:   ${status.queue.active}`);
    console.log(`  Blocked:  ${status.queue.blocked}`);
    console.log('');
  }

  // Overall assessment
  const allHealthy = apiHealthy && orchHealthy && arHealthy && workerHealthy;
  if (allHealthy) {
    console.log('Status: All systems operational');
  } else {
    const unhealthy: string[] = [];
    if (!apiHealthy) unhealthy.push('API');
    if (!orchHealthy && status.orchestrator) unhealthy.push('Orchestrator');
    if (!arHealthy) unhealthy.push('Agent Runtime');
    if (!workerHealthy && status.worker) unhealthy.push('Worker');
    console.log(`Status: Issues detected with: ${unhealthy.join(', ')}`);
  }
}

function formatServiceHealth(
  name: string,
  healthy: boolean,
  version?: string,
  replicas?: number,
): void {
  const icon = healthy ? '✓' : '✗';
  const status = healthy ? 'healthy' : 'unhealthy';
  const versionStr = version ? ` (v${version})` : '';
  const replicasStr = replicas != null ? ` [${replicas} replica${replicas !== 1 ? 's' : ''}]` : '';
  console.log(`${name}: ${icon} ${status}${versionStr}${replicasStr}`);
}

/**
 * eve system jobs [--org=X] [--project=X] [--phase=X] [--limit=50] [--offset=0]
 * Admin view: list all jobs across all projects
 */
async function handleJobs(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const query = buildQuery({
    org_id: getStringFlag(flags, ['org']),
    project_id: getStringFlag(flags, ['project']),
    phase: getStringFlag(flags, ['phase']),
    limit: getStringFlag(flags, ['limit']) ?? '50',
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<JobListResponse>(
    context,
    `/jobs${query}`,
  );

  if (json) {
    outputJson(response, json);
  } else {
    if (response.jobs.length === 0) {
      console.log('No jobs found.');
      return;
    }
    console.log('System Jobs (admin view):');
    console.log('');
    formatJobsTable(response.jobs);
  }
}

/**
 * eve system envs [--org=X] [--project=X] [--limit=50] [--offset=0]
 * Admin view: list all environments across all projects
 */
async function handleEnvs(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const query = buildQuery({
    org_id: getStringFlag(flags, ['org']),
    project_id: getStringFlag(flags, ['project']),
    limit: getStringFlag(flags, ['limit']) ?? '50',
    offset: getStringFlag(flags, ['offset']),
  });

  try {
    const response = await requestJson<EnvironmentListResponse>(
      context,
      `/system/envs${query}`,
    );

    if (json) {
      outputJson(response, json);
    } else {
      if (response.environments.length === 0) {
        console.log('No environments found.');
        return;
      }
      console.log('System Environments (admin view):');
      console.log('');
      formatEnvsTable(response.environments);
    }
  } catch (error) {
    const err = error as Error;
    if (err.message?.includes('HTTP 404')) {
      console.error('Error: The /system/envs endpoint is not yet implemented.');
      console.error('Please use "eve env list" within a project context instead.');
      process.exit(1);
    }
    throw error;
  }
}

/**
 * eve system logs <service> [--tail=100]
 * Fetch recent logs for a service via API.
 */
async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const service = positionals[0] ?? getStringFlag(flags, ['service']);
  if (!service) {
    throw new Error('Usage: eve system logs <api|orchestrator|worker|agent-runtime|postgres> [--tail=<n>]');
  }

  const tail = getStringFlag(flags, ['tail']);
  const query = buildQuery({ tail: tail ?? '100' });

  const response = await requestJson<LogEntry[]>(
    context,
    `/system/logs/${service}${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.length === 0) {
    console.log('No logs found.');
    return;
  }

  for (const entry of response) {
    console.log(`[${entry.timestamp}] ${entry.line}`);
  }
}

/**
 * eve system pods
 * List pods via API.
 */
async function handlePods(
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const response = await requestJson<PodInfo[]>(
    context,
    '/system/pods',
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.length === 0) {
    console.log('No pods found.');
    return;
  }

  console.log('Pods:');
  console.log('');
  formatPodsTable(response);
}

/**
 * eve system events [--limit=50]
 * List recent cluster events via API.
 */
async function handleEvents(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const limit = getStringFlag(flags, ['limit']);
  const query = buildQuery({ limit: limit ?? '50' });

  const response = await requestJson<EventInfo[]>(
    context,
    `/system/events${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.length === 0) {
    console.log('No events found.');
    return;
  }

  console.log('Recent Events:');
  for (const event of response) {
    const target = `${event.involvedObject.kind}/${event.involvedObject.name}`;
    console.log(`[${event.timestamp}] ${event.type} ${event.reason} ${target} - ${event.message}`);
  }
}

/**
 * eve system config
 * Show cluster config summary via API.
 */
async function handleConfig(
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const response = await requestJson<ConfigSummary>(
    context,
    '/system/config',
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log('Cluster Config:');
  console.log(`  Namespace: ${response.namespace}`);
  if (response.clusterVersion) {
    console.log(`  Cluster Version: ${response.clusterVersion}`);
  }
  if (response.nodeCount !== undefined) {
    console.log(`  Node Count: ${response.nodeCount}`);
  }
  if (response.deployments.length > 0) {
    console.log('  Deployments:');
    response.deployments.forEach((deployment) => console.log(`    - ${deployment}`));
  }
}

/**
 * eve system orchestrator <status|set-concurrency>
 * Manage orchestrator concurrency settings
 */
async function handleOrchestrator(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const subcommand = positionals[0];

  if (subcommand === 'status') {
    const response = await requestOrchestratorJson<OrchestratorStatusResponse>(
      context,
      '/system/orchestrator/status',
    );

    if (json) {
      outputJson(response, json);
    } else {
      formatOrchestratorStatus(response);
    }
    return;
  }

  if (subcommand === 'set-concurrency') {
    const limitStr = positionals[1];
    if (!limitStr) {
      throw new Error('Usage: eve system orchestrator set-concurrency <n>');
    }

    const limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) {
      throw new Error('Concurrency limit must be a positive integer');
    }

    const response = await requestOrchestratorJson<OrchestratorStatusResponse>(
      context,
      '/system/orchestrator/concurrency',
      {
        method: 'POST',
        body: JSON.stringify({ limit }),
      },
    );

    if (json) {
      outputJson(response, json);
    } else {
      console.log(`Concurrency limit updated to ${limit}`);
      console.log('');
      formatOrchestratorStatus(response);
    }
    return;
  }

  throw new Error('Usage: eve system orchestrator <status|set-concurrency>');
}

/**
 * eve system settings [get <key>] [set <key> <value>]
 * Admin only: Get or set system settings
 */
async function handleSettings(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const action = positionals[0];

  if (action === 'set') {
    const key = positionals[1];
    const value = positionals[2];
    if (!key || !value) {
      throw new Error('Usage: eve system settings set <key> <value>');
    }

    const body = { value };
    const response = await requestJson<SystemSetting>(
      context,
      `/system/settings/${key}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );

    if (json) {
      outputJson(response, json);
    } else {
      console.log(`Setting '${key}' updated:`);
      console.log(`  Value: ${response.value}`);
      console.log(`  Updated: ${response.updated_at}`);
      console.log(`  By: ${response.updated_by}`);
    }
    return;
  }

  // Default: get all or get specific
  const key = positionals[0];
  if (key) {
    const response = await requestJson<SystemSetting>(
      context,
      `/system/settings/${key}`,
    );

    if (json) {
      outputJson(response, json);
    } else {
      console.log(`Setting: ${response.key}`);
      console.log(`  Value: ${response.value}`);
      if (response.description) {
        console.log(`  Description: ${response.description}`);
      }
      console.log(`  Updated: ${response.updated_at}`);
      console.log(`  By: ${response.updated_by}`);
    }
  } else {
    const response = await requestJson<SystemSetting[]>(
      context,
      '/system/settings',
    );

    if (json) {
      outputJson(response, json);
    } else {
      if (response.length === 0) {
        console.log('No system settings found.');
        return;
      }

      console.log('System Settings:');
      console.log('');
      for (const setting of response) {
        console.log(`  ${setting.key}:`);
        console.log(`    Value: ${setting.value}`);
        if (setting.description) {
          console.log(`    Description: ${setting.description}`);
        }
        console.log(`    Updated: ${setting.updated_at} by ${setting.updated_by}`);
        console.log('');
      }
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format jobs as a human-readable table
 */
function formatJobsTable(jobs: Job[]): void {
  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  // Calculate column widths
  const idWidth = Math.max(6, ...jobs.map((j) => j.id.length));
  const projectWidth = Math.max(10, ...jobs.map((j) => j.project_id.length));
  const phaseWidth = Math.max(5, ...jobs.map((j) => j.phase.length));
  const titleWidth = Math.min(40, Math.max(5, ...jobs.map((j) => j.title.length)));

  // Header
  const header = [
    padRight('Job ID', idWidth),
    padRight('Project', projectWidth),
    padRight('Phase', phaseWidth),
    padRight('P', 2),
    padRight('Title', titleWidth),
    'Assignee',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const job of jobs) {
    const title = job.title.length > titleWidth ? job.title.slice(0, titleWidth - 3) + '...' : job.title;
    const row = [
      padRight(job.id, idWidth),
      padRight(job.project_id, projectWidth),
      padRight(job.phase, phaseWidth),
      padRight(`P${job.priority}`, 2),
      padRight(title, titleWidth),
      job.assignee ?? '-',
    ].join('  ');

    console.log(row);
  }

  console.log('');
  console.log(`Total: ${jobs.length} job(s)`);
}

/**
 * Format environments as a human-readable table
 */
function formatEnvsTable(envs: Environment[]): void {
  if (envs.length === 0) {
    console.log('No environments found.');
    return;
  }

  // Calculate column widths
  const projectWidth = Math.max(10, ...envs.map((e) => e.project_id.length));
  const nameWidth = Math.max(12, ...envs.map((e) => e.name.length));
  const typeWidth = Math.max(4, ...envs.map((e) => e.type.length));
  const namespaceWidth = Math.max(9, ...envs.map((e) => (e.namespace ?? '-').length));
  const releaseWidth = Math.max(7, ...envs.map((e) => (e.current_release ?? '-').length));

  // Header
  const header = [
    padRight('Project', projectWidth),
    padRight('Environment', nameWidth),
    padRight('Type', typeWidth),
    padRight('Namespace', namespaceWidth),
    padRight('Release', releaseWidth),
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  // Rows
  for (const env of envs) {
    const row = [
      padRight(env.project_id, projectWidth),
      padRight(env.name, nameWidth),
      padRight(env.type, typeWidth),
      padRight(env.namespace ?? '-', namespaceWidth),
      padRight(env.current_release ?? '-', releaseWidth),
    ].join('  ');

    console.log(row);
  }

  console.log('');
  console.log(`Total: ${envs.length} environment(s)`);
}

function formatPodsTable(pods: PodInfo[]): void {
  if (pods.length === 0) {
    console.log('No pods found.');
    return;
  }

  const nameWidth = Math.max(8, ...pods.map((p) => p.name.length));
  const nsWidth = Math.max(8, ...pods.map((p) => p.namespace.length));
  const phaseWidth = Math.max(5, ...pods.map((p) => p.phase.length));
  const readyWidth = 5;
  const restartsWidth = Math.max(8, ...pods.map((p) => String(p.restarts).length));
  const ageWidth = Math.max(3, ...pods.map((p) => p.age.length));

  const header = [
    padRight('Name', nameWidth),
    padRight('Namespace', nsWidth),
    padRight('Phase', phaseWidth),
    padRight('Ready', readyWidth),
    padRight('Restarts', restartsWidth),
    padRight('Age', ageWidth),
    'Component',
    'Org',
    'Project',
    'Env',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const pod of pods) {
    console.log([
      padRight(pod.name, nameWidth),
      padRight(pod.namespace, nsWidth),
      padRight(pod.phase, phaseWidth),
      padRight(pod.ready ? 'yes' : 'no', readyWidth),
      padRight(String(pod.restarts), restartsWidth),
      padRight(pod.age, ageWidth),
      padRight(pod.component ?? '-', 10),
      padRight(pod.orgId ?? '-', 10),
      padRight(pod.projectId ?? '-', 10),
      padRight(pod.env ?? '-', 10),
    ].join('  '));
  }
}

/**
 * Pad a string to the right with spaces
 */
function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * Get orchestrator URL from context.
 * Derives from API URL by replacing the port with the orchestrator port.
 */
function getOrchestratorUrl(context: ResolvedContext): string {
  const envUrl = process.env.EVE_ORCHESTRATOR_URL;
  if (envUrl) {
    return envUrl;
  }

  // Derive from API URL by changing the port
  const orchPort = process.env.EVE_ORCHESTRATOR_PORT || '4802';
  const apiUrl = new URL(context.apiUrl);
  apiUrl.port = orchPort;
  return apiUrl.toString().replace(/\/$/, '');
}

/**
 * Request JSON from the orchestrator service.
 * Similar to requestJson but targets the orchestrator directly.
 */
async function requestOrchestratorJson<T>(
  context: ResolvedContext,
  path: string,
  options?: {
    method?: string;
    body?: string;
  },
): Promise<T> {
  const orchUrl = getOrchestratorUrl(context);
  const url = `${orchUrl}${path}`;

  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (context.token) {
    headers.Authorization = `Bearer ${context.token}`;
  }

  const response = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    body: options?.body,
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'string' ? data : text;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  return data as T;
}

/**
 * Format orchestrator status for human-readable output
 */
function formatOrchestratorStatus(status: OrchestratorStatusResponse): void {
  console.log('Orchestrator Concurrency Status');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log(`  Limit:          ${status.limit}`);
  console.log(`  In-Flight:      ${status.inFlight}`);
  console.log(`  Uptime:         ${formatUptime(status.uptimeSeconds)}`);
  console.log(`  Last Change:    ${status.lastChange}`);
  console.log('');
}

/**
 * Format uptime seconds to human-readable format
 */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

// ============================================================================
// Environment Health
// ============================================================================

interface EnvHealthIssue {
  type: string;
  pod: string;
  container?: string;
  restarts?: number;
  reason?: string;
  since?: string;
  image?: string;
}

interface EnvHealthEntry {
  environment_id: string;
  environment_slug: string;
  status: string;
  issues_json: EnvHealthIssue[] | null;
  pod_count: number;
  healthy_pod_count: number;
  degraded_since: string | null;
  consecutive_degraded_ticks: number;
  actions_taken_json: Array<{ type: string; deployment: string; at?: string }> | null;
  checked_at: string;
}

interface EnvHealthResponse {
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    critical: number;
  };
  environments: EnvHealthEntry[];
}

/**
 * eve system env-health [--status=X] [--limit=100] [--json]
 * Show environment health status across all orgs.
 */
async function handleEnvHealth(
  context: ResolvedContext,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const json = Boolean(flags.json);
  const status = getStringFlag(flags, ['status']);
  const limit = getStringFlag(flags, ['limit']) ?? '100';

  const query = buildQuery({ status, limit });
  const data = await requestJson<EnvHealthResponse>(context, `/system/env-health${query}`);

  if (json) {
    outputJson(data, true);
    return;
  }

  const s = data.summary;
  console.log('Environment Health Report');
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log(`  Total:    ${s.total}`);
  console.log(`  Healthy:  ${s.healthy}`);
  console.log(`  Degraded: ${s.degraded}`);
  console.log(`  Critical: ${s.critical}`);

  if (data.environments.length > 0) {
    console.log('');
    for (const env of data.environments) {
      const icon =
        env.status === 'healthy' ? '  ✅' :
        env.status === 'degraded' ? '  🟡' : '  🔴';
      console.log(`${icon} ${env.environment_slug} — ${env.status}`);
      const issues = typeof env.issues_json === 'string' ? JSON.parse(env.issues_json) : env.issues_json;
      if (issues && Array.isArray(issues)) {
        for (const issue of issues) {
          const restartInfo = issue.restarts ? ` (${issue.restarts} restarts)` : '';
          console.log(`     ${issue.type}: ${issue.pod}${restartInfo}`);
        }
      }
      const actions = typeof env.actions_taken_json === 'string' ? JSON.parse(env.actions_taken_json) : env.actions_taken_json;
      if (actions && Array.isArray(actions) && actions.length > 0) {
        for (const action of actions) {
          console.log(`     action: ${action.type} on ${action.deployment}`);
        }
      }
    }
  } else if (s.total === 0) {
    console.log('');
    console.log('No environments are being monitored yet.');
  }
}

/**
 * eve system env-cost [--all] [--month=YYYY-MM] [--source=opencost] [--json]
 * Show month-to-date OpenCost environment estimates. These are not bill-backed.
 */
async function handleEnvCost(
  context: ResolvedContext,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const json = Boolean(flags.json);
  const query = buildQuery({
    month: getStringFlag(flags, ['month']),
    source: getStringFlag(flags, ['source']),
  });

  const data = await requestJson<EnvironmentCostResponse>(context, `/admin/cost/environments${query}`);

  if (json) {
    outputJson(data, true);
    return;
  }

  const limit = flags.all ? data.environments.length : 20;
  const rows = data.environments.slice(0, limit);
  formatEnvCostTable(data, rows, Boolean(flags.all));
}

/**
 * eve system cloud-cost [--scope cluster] [--scope-key eve-cluster]
 *   [--provider aws] [--source aws_cost_explorer] [--month=YYYY-MM] [--json]
 * Show bill-backed cloud cost snapshots.
 */
async function handleCloudCost(
  context: ResolvedContext,
  flags: Record<string, FlagValue>,
): Promise<void> {
  const json = Boolean(flags.json);
  const query = buildQuery({
    scope_type: getStringFlag(flags, ['scope', 'scope-type']),
    scope_key: getStringFlag(flags, ['scope-key']),
    month: getStringFlag(flags, ['month']),
    provider: getStringFlag(flags, ['provider']),
    source: getStringFlag(flags, ['source']),
  });

  const data = await requestJson<CloudCostResponse>(context, `/admin/cost/cloud${query}`);

  if (json) {
    outputJson(data, true);
    return;
  }

  formatCloudCost(data);
}

function formatEnvCostTable(
  data: EnvironmentCostResponse,
  rows: EnvironmentCostRow[],
  showingAll: boolean,
): void {
  console.log('Environment Cost Estimates (OpenCost, not bill-backed)');
  console.log('═══════════════════════════════════════');
  console.log('');

  const status = data.observed_at
    ? data.stale
      ? `stale estimate (last observed ${data.observed_at})`
      : `fresh estimate (observed ${data.observed_at})`
    : 'unavailable (collector not reporting)';

  if (rows.length === 0) {
    console.log('No environment cost snapshots found.');
  } else {
    const costWidth = Math.max(8, ...rows.map((row) => formatUsd(row.amount_usd).length));
    const nameWidth = Math.max(
      'ORG / PROJECT / ENV'.length,
      ...rows.map((row) => formatEnvCostName(row).length),
    );
    const confidenceWidth = Math.max('CONFIDENCE'.length, ...rows.map((row) => row.confidence.length));

    const header = [
      padRight('COST', costWidth),
      padRight('ORG / PROJECT / ENV', nameWidth),
      padRight('CONFIDENCE', confidenceWidth),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const row of rows) {
      console.log([
        padRight(formatUsd(row.amount_usd), costWidth),
        padRight(formatEnvCostName(row), nameWidth),
        padRight(row.confidence, confidenceWidth),
      ].join('  '));
    }
  }

  console.log('');
  console.log(`Total: ${formatUsd(data.total_usd)} MTD (${data.env_count} env${data.env_count === 1 ? '' : 's'})`);
  console.log(`Shared overhead: ${formatUsd(data.shared_usd)}`);
  console.log(`Source: ${data.source} · window=${data.window.month} · ${status}`);
  if (!showingAll && data.environments.length > rows.length) {
    console.log(`Showing top ${rows.length} of ${data.environments.length}. Use --all for the full breakdown.`);
  }
}

function formatCloudCost(data: CloudCostResponse): void {
  console.log('Cloud Cost');
  console.log('═══════════════════════════════════════');
  console.log('');

  if (!data.amount) {
    console.log('No cloud cost snapshot found.');
    console.log(`Scope: ${data.scope.type}:${data.scope.key}`);
    console.log(`Window: ${data.window.month}`);
    return;
  }

  const staleLabel = data.stale && data.observed_at ? ' (stale)' : '';
  const label = data.scope.label ?? data.scope.key;
  const amount = `${formatUsd(data.amount)} MTD`;
  const projected = data.projected_amount ? `${formatUsd(data.projected_amount)} projected / ` : '';
  console.log(`Monthly ${label} cloud cost${staleLabel} — ${projected}${amount}`);
  console.log(`Source: ${formatCloudSource(data)}`);
  if (data.coverage !== 'complete') {
    console.log(`Coverage: ${formatCoverage(data.coverage)}`);
  }
  const caveat = readString(data.breakdown, 'projection_caveat');
  if (caveat) {
    console.log(`Projection: ${caveat}`);
  }
  const services = formatTopServices(data.breakdown, 5);
  if (services) {
    console.log(`Top services: ${services}`);
  }
  const observed = data.observed_at
    ? data.stale
      ? `stale, last observed ${data.observed_at}`
      : `observed ${data.observed_at}`
    : 'collector not reporting';
  console.log(`Window: ${data.window.month} · ${observed}`);
  console.log('Per-environment split: eve system env-cost --all (OpenCost estimate, not reconciled)');
}

function formatEnvCostName(row: EnvironmentCostRow): string {
  if (row.environment_slug && row.environment_slug.includes('/')) {
    return row.environment_slug;
  }
  return [
    row.org_id ?? '-',
    row.project_id ?? '-',
    row.environment_slug ?? row.environment_id,
  ].join(' / ');
}

function formatUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return `$${value}`;
  return `$${parsed.toFixed(2)}`;
}

function formatCloudSource(data: CloudCostResponse): string {
  const metric = readString(data.breakdown, 'metric') ?? 'UnblendedCost';
  const mtd = data.window.mtd_through ? ` | MTD through ${data.window.mtd_through}` : '';
  if (data.provider === 'aws' && data.source === 'aws_cost_explorer') {
    const tags = readRecord(data.filter, 'tags');
    const project = readString(tags, 'Project');
    const environment = readString(tags, 'Environment');
    const filters = [
      project ? `Project=${project}` : null,
      environment ? `Environment=${environment}` : null,
    ].filter(Boolean).join(' | ');
    return `AWS Cost Explorer ${metric}${filters ? ` | ${filters}` : ''}${mtd}`;
  }
  return `${data.source ?? 'unknown'}${mtd}`;
}

function formatCoverage(coverage: string): string {
  if (coverage === 'undercount') {
    return 'undercount until EKS node/NLB/EBS tag propagation is fixed';
  }
  return coverage;
}

function formatTopServices(breakdown: Record<string, unknown>, limit: number): string | null {
  const rows = Array.isArray(breakdown.by_service) ? breakdown.by_service : [];
  const formatted = rows
    .slice(0, limit)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const service = typeof record.service === 'string' ? record.service : null;
      const amount = typeof record.amount === 'number' || typeof record.amount === 'string'
        ? formatUsd(String(record.amount))
        : null;
      return service && amount ? `${shortAwsServiceName(service)} ${amount}` : null;
    })
    .filter((value): value is string => Boolean(value));
  return formatted.length > 0 ? formatted.join(' | ') : null;
}

function shortAwsServiceName(service: string): string {
  const known: Record<string, string> = {
    'Amazon Elastic Kubernetes Service': 'EKS',
    'EC2 - Other': 'EC2-Other',
    'Amazon Relational Database Service': 'RDS',
    'Amazon Elastic Compute Cloud - Compute': 'EC2',
    'Amazon Virtual Private Cloud': 'VPC',
    'Elastic Load Balancing': 'ELB',
  };
  return known[service] ?? service;
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const nested = value[key];
  return typeof nested === 'string' && nested.trim() ? nested : null;
}

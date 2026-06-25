import type { FlagValue } from '../lib/args';
import { getBooleanFlag, getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson } from '../lib/client';
import { outputJson } from '../lib/output';
import { parseEnvOverrideFlags } from '../lib/env-overrides';

interface WorkflowDefinition {
  steps?: unknown[];
  [key: string]: unknown;
}

interface WorkflowResponse {
  project_id: string;
  name: string;
  definition: WorkflowDefinition;
}

interface WorkflowListResponse {
  data: WorkflowResponse[];
}

interface WorkflowInvokeResponse {
  job_id: string;
  workflow_name: string;
  project_id: string;
  status: string;
  result?: unknown;
}

interface WorkflowRetryResponse {
  root_job_id: string;
  status: string;
  mode: 'failed' | 'from';
  from_step?: string;
  generation: number;
  retried_steps: Array<{
    step_name: string;
    previous_job_id: string;
    retry_job_id: string;
    depends_on?: string[];
  }>;
  superseded_job_ids: string[];
}

interface LogEntry {
  sequence: number;
  timestamp: string;
  type?: string;
  line: Record<string, unknown>;
}

interface LogsResponse {
  logs: LogEntry[];
}

export async function handleWorkflow(
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
    case 'run':
      return handleRun(positionals, flags, context, json);
    case 'invoke':
      return handleInvoke(positionals, flags, context, json);
    case 'retry':
      return handleRetry(positionals, flags, context, json);
    case 'logs':
      return handleLogs(positionals, flags, context, json);
    default:
      throw new Error(
        'Usage: eve workflow <list|show|run|invoke|retry|logs>\n' +
        '  list [project]                         - list workflows for a project\n' +
        '  show <project> <name>                  - show workflow definition\n' +
        '  run [project] <workflow-name>          - fire-and-forget workflow invocation\n' +
        '                                           Options: --input <json>, --env-override KEY=VALUE\n' +
        '  invoke [project] <workflow-name>       - invoke workflow and wait for result\n' +
        '                                           Options: --input <json>, --env-override KEY=VALUE, --no-wait\n' +
        '  retry <root-job-id>                    - retry failed or tail workflow steps\n' +
        '                                           Options: --failed or --from <step>\n' +
        '  logs <job-id>                          - show logs for a workflow job',
      );
  }
}

async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve workflow list [project] [--project=<id>]');
  }

  const response = await requestJson<WorkflowListResponse>(
    context,
    `/projects/${projectId}/workflows`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No workflows found.');
    return;
  }

  formatWorkflows(response.data);
}

async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;
  const name = positionals[1] ?? getStringFlag(flags, ['name']);

  if (!projectId || !name) {
    throw new Error('Usage: eve workflow show <project> <name> [--project=<id>] [--name=<name>]');
  }

  const response = await requestJson<WorkflowResponse>(
    context,
    `/projects/${projectId}/workflows/${name}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  formatWorkflow(response);
}

function formatWorkflows(workflows: WorkflowResponse[]): void {
  console.log('Workflows:');
  for (const workflow of workflows) {
    const stepCount = Array.isArray(workflow.definition?.steps)
      ? workflow.definition.steps.length
      : null;
    const suffix = stepCount === null ? '' : ` (${stepCount} steps)`;
    console.log(`- ${workflow.name}${suffix}`);
  }
}

function formatWorkflow(workflow: WorkflowResponse): void {
  console.log(`Workflow: ${workflow.name}`);
  console.log('Definition:');
  console.log(JSON.stringify(workflow.definition, null, 2));
}

/**
 * eve workflow run [project] <workflow-name> [--input=<json>] [--env-override KEY=VALUE]
 * Fire-and-forget workflow invocation (no waiting)
 */
async function handleRun(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  let projectId: string | undefined;
  let workflowName: string | undefined;

  // Parse positionals: either "workflow-name" or "project workflow-name"
  if (positionals.length === 1) {
    projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    workflowName = positionals[0];
  } else if (positionals.length >= 2) {
    projectId = positionals[0];
    workflowName = positionals[1];
  } else {
    projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    workflowName = getStringFlag(flags, ['workflow', 'name']);
  }

  if (!projectId || !workflowName) {
    throw new Error('Usage: eve workflow run [project] <workflow-name> [--input=<json>] [--env-override KEY=VALUE]');
  }

  // Parse input JSON
  const inputRaw = getStringFlag(flags, ['input', 'i']);
  let input: unknown;
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw);
    } catch (error) {
      throw new Error(`Invalid JSON for --input: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // Call invoke endpoint with wait=false
  const body: Record<string, unknown> = {};
  if (input) {
    body.input = input;
  }
  const envOverrides = parseEnvOverrideFlags(flags);
  if (envOverrides) {
    body.env_overrides = envOverrides;
  }

  const response = await requestJson<WorkflowInvokeResponse>(
    context,
    `/projects/${projectId}/workflows/${workflowName}/invoke?wait=false`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Workflow invoked: ${workflowName}`);
  console.log(`  Job ID:  ${response.job_id}`);
  console.log(`  Status:  ${response.status}`);
  console.log('');
  console.log(`Use 'eve workflow logs ${response.job_id}' to view logs`);
}

/**
 * eve workflow invoke [project] <workflow-name> [--input=<json>] [--env-override KEY=VALUE] [--no-wait]
 * Invoke workflow and wait for result (default behavior)
 */
async function handleInvoke(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  let projectId: string | undefined;
  let workflowName: string | undefined;

  // Parse positionals: either "workflow-name" or "project workflow-name"
  if (positionals.length === 1) {
    projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    workflowName = positionals[0];
  } else if (positionals.length >= 2) {
    projectId = positionals[0];
    workflowName = positionals[1];
  } else {
    projectId = getStringFlag(flags, ['project']) ?? context.projectId;
    workflowName = getStringFlag(flags, ['workflow', 'name']);
  }

  if (!projectId || !workflowName) {
    throw new Error('Usage: eve workflow invoke [project] <workflow-name> [--input=<json>] [--env-override KEY=VALUE] [--no-wait]');
  }

  // Parse input JSON
  const inputRaw = getStringFlag(flags, ['input', 'i']);
  let input: unknown;
  if (inputRaw) {
    try {
      input = JSON.parse(inputRaw);
    } catch (error) {
      throw new Error(`Invalid JSON for --input: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // Check if --no-wait is set (inverse logic: wait by default)
  const wait = !flags['no-wait'];

  // Call invoke endpoint
  const body: Record<string, unknown> = {};
  if (input) {
    body.input = input;
  }
  const envOverrides = parseEnvOverrideFlags(flags);
  if (envOverrides) {
    body.env_overrides = envOverrides;
  }

  const response = await requestJson<WorkflowInvokeResponse>(
    context,
    `/projects/${projectId}/workflows/${workflowName}/invoke?wait=${wait}`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Workflow invoked: ${workflowName}`);
  console.log(`  Job ID:  ${response.job_id}`);
  console.log(`  Status:  ${response.status}`);

  if (response.result !== undefined) {
    console.log('');
    console.log('Result:');
    if (typeof response.result === 'string') {
      console.log(response.result);
    } else {
      console.log(JSON.stringify(response.result, null, 2));
    }
  } else if (!wait) {
    console.log('');
    console.log(`Use 'eve workflow logs ${response.job_id}' to view logs`);
  }
}

/**
 * eve workflow logs <job-id> [--attempt=N] [--after=N]
 * Show logs for a workflow job
 */
async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const jobId = positionals[0];

  if (!jobId) {
    throw new Error('Usage: eve workflow logs <job-id> [--attempt=N] [--after=N]');
  }

  // Get attempt number (default to latest)
  const attemptStr = getStringFlag(flags, ['attempt']);
  let attemptNum: number;

  if (attemptStr) {
    attemptNum = parseInt(attemptStr, 10);
  } else {
    // Find the latest attempt
    const attemptsResponse = await requestJson<{ attempts: Array<{ attempt_number: number }> }>(
      context,
      `/jobs/${jobId}/attempts`,
    );
    if (attemptsResponse.attempts.length === 0) {
      console.log('No attempts found for this job.');
      return;
    }
    attemptNum = Math.max(...attemptsResponse.attempts.map(a => a.attempt_number));
  }

  const afterStr = getStringFlag(flags, ['after']);
  const afterQuery = afterStr ? `?after=${afterStr}` : '';

  const response = await requestJson<LogsResponse>(
    context,
    `/jobs/${jobId}/attempts/${attemptNum}/logs${afterQuery}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.logs.length === 0) {
    console.log(`No logs found for attempt #${attemptNum}.`);
    return;
  }

  console.log(`Logs for job ${jobId}, attempt #${attemptNum}:`);
  console.log('');

  for (const log of response.logs) {
    formatLogEntry(log);
  }

  console.log('');
  console.log(`Total: ${response.logs.length} log entries`);
}

/**
 * eve workflow retry <root-job-id> (--failed | --from <step>)
 * Retry failed/current workflow steps without rerunning successful predecessors.
 */
async function handleRetry(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const rootJobId = positionals[0] ?? getStringFlag(flags, ['job', 'root', 'root-job']);
  if (!rootJobId) {
    throw new Error('Usage: eve workflow retry <root-job-id> (--failed | --from <step>) [--project=<id>]');
  }

  const failed = getBooleanFlag(flags, ['failed']) === true;
  const fromStep = getStringFlag(flags, ['from', 'from-step']);
  if (failed === Boolean(fromStep)) {
    throw new Error('Usage: eve workflow retry <root-job-id> (--failed | --from <step>) [--project=<id>]');
  }

  let projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  if (!projectId) {
    const job = await requestJson<{ project_id: string }>(context, `/jobs/${rootJobId}`);
    projectId = job.project_id;
  }

  if (!projectId) {
    throw new Error('Project is required. Use --project=<id> or set a default project in the active profile.');
  }

  const body: Record<string, unknown> = { root_job_id: rootJobId };
  if (failed) body.failed = true;
  if (fromStep) body.from_step = fromStep;

  const response = await requestJson<WorkflowRetryResponse>(
    context,
    `/projects/${projectId}/workflows/retry`,
    {
      method: 'POST',
      body,
    },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Workflow retry queued: ${response.root_job_id}`);
  console.log(`  Mode:        ${response.mode}${response.from_step ? ` (${response.from_step})` : ''}`);
  console.log(`  Generation:  ${response.generation}`);
  console.log(`  Status:      ${response.status}`);
  console.log('');
  console.log('Retried steps:');
  for (const step of response.retried_steps) {
    const depends = step.depends_on && step.depends_on.length > 0
      ? ` (depends on ${step.depends_on.join(', ')})`
      : '';
    console.log(`- ${step.step_name}: ${step.previous_job_id} -> ${step.retry_job_id}${depends}`);
  }
}

/**
 * Format a single log entry for display
 */
function formatLogEntry(log: LogEntry): void {
  const line = log.line;
  const timestamp = new Date(log.timestamp).toLocaleTimeString();

  // Common log line formats from harnesses
  const type = log.type || (line.type as string) || 'log';

  // If type starts with 'lifecycle_', format as lifecycle event
  if (type.startsWith('lifecycle_')) {
    const content = line as Record<string, unknown>;
    const phase = content.phase as string || 'unknown';
    const action = content.action as string || 'unknown';
    const duration = content.duration_ms as number | undefined;
    const success = content.success as boolean | undefined;
    const error = content.error as string | undefined;
    const meta = content.meta as Record<string, unknown> || {};

    if (action === 'start') {
      const detail = formatLifecycleMeta(phase, meta);
      console.log(`[${timestamp}] ${getLifecycleIcon(phase)} Starting ${phase}${detail}...`);
    } else if (action === 'end') {
      const durationStr = duration ? ` (${duration}ms)` : '';
      if (success === false && error) {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} failed${durationStr}: ${error}`);
      } else {
        console.log(`[${timestamp}] ${getLifecycleIcon(phase)} ${capitalize(phase)} completed${durationStr}`);
      }
    } else if (action === 'log') {
      const msg = (meta.message as string) || JSON.stringify(meta);
      console.log(`[${timestamp}]   > ${msg}`);
    }
    return;
  }

  const message = (line.message as string) || (line.text as string) || '';
  const tool = line.tool as string | undefined;
  const toolInput = line.tool_input as string | undefined;
  const toolResult = line.tool_result as string | undefined;

  // Format based on log type
  switch (type) {
    case 'assistant':
    case 'text':
      console.log(`[${timestamp}] ${message || JSON.stringify(line)}`);
      break;
    case 'tool_use':
      console.log(`[${timestamp}] Tool: ${tool || 'tool'}: ${toolInput || JSON.stringify(line)}`);
      break;
    case 'tool_result':
      const resultPreview = (toolResult || '').substring(0, 100);
      console.log(`[${timestamp}]    → ${resultPreview}${(toolResult?.length || 0) > 100 ? '...' : ''}`);
      break;
    case 'error':
      console.log(`[${timestamp}] Error: ${message || JSON.stringify(line)}`);
      break;
    case 'status':
      console.log(`[${timestamp}] ${message || JSON.stringify(line)}`);
      break;
    default:
      // Generic JSON output for unknown types
      console.log(`[${timestamp}] ${JSON.stringify(line)}`);
  }
}

/**
 * Get icon for lifecycle phase
 */
function getLifecycleIcon(phase: string): string {
  switch (phase) {
    case 'workspace': return '📁';
    case 'hook': return '🪝';
    case 'secrets': return '🔐';
    case 'services': return '🐳';
    case 'harness': return '🤖';
    case 'runner': return '☸️';
    default: return '⚙️';
  }
}

/**
 * Capitalize first letter of string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format lifecycle metadata for display
 */
function formatLifecycleMeta(phase: string, meta: Record<string, unknown>): string {
  switch (phase) {
    case 'workspace':
      const repoUrl = meta.repo_url as string || '';
      const branch = meta.branch as string || '';
      return branch ? ` (${repoUrl}@${branch})` : repoUrl ? ` (${repoUrl})` : '';
    case 'hook':
      return meta.hook_name ? ` "${meta.hook_name}"` : '';
    case 'secrets':
      return '';
    case 'services':
      const svcName = meta.service_name as string || '';
      return svcName ? ` "${svcName}"` : '';
    case 'harness':
      return meta.harness ? ` ${meta.harness}` : '';
    case 'runner':
      return meta.pod_name ? ` (${meta.pod_name})` : '';
    default:
      return '';
  }
}

import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw, requestStream } from '../lib/client';
import { outputJson } from '../lib/output';
import { buildQuery, renderTable } from '../lib/format';
import { resolveGitRef } from '../lib/git.js';

interface PipelineDefinition {
  steps?: unknown[];
  [key: string]: unknown;
}

interface PipelineResponse {
  project_id: string;
  name: string;
  definition: PipelineDefinition;
}

interface PipelineListResponse {
  data: PipelineResponse[];
}

interface PipelineRunResponse {
  id: string;
  project_id: string;
  pipeline_name: string;
  env_name: string | null;
  git_sha: string | null;
  manifest_hash: string | null;
  inputs: Record<string, unknown> | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'awaiting_approval';
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  requested_by: string | null;
  run_mode: string | null;
  created_at: string;
  updated_at: string;
}

interface PipelineStepRunResponse {
  id: string;
  pipeline_run_id: string;
  step_index: number;
  step_name: string;
  step_type: 'build' | 'release' | 'deploy' | 'run';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  logs_ref: string | null;
  input_json: Record<string, unknown> | null;
  output_json: Record<string, unknown> | null;
  result_text: string | null;
  result_json: Record<string, unknown> | null;
  exit_code: number | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface PipelineRunDetailResponse {
  run: PipelineRunResponse;
  steps: PipelineStepRunResponse[];
}

interface PipelineRunJobResponse {
  id: string;
  step_name: string | null;
  execution_type: string;
  phase: string;
}

interface PipelineRunWithJobsResponse {
  run: PipelineRunResponse & { step_outputs?: Record<string, unknown> | null };
  jobs: PipelineRunJobResponse[];
  relations: Array<{ from_job_id: string; to_job_id: string; relation_type: string }>;
}

interface PipelineRunDetailWithOutputsResponse {
  run: PipelineRunResponse & { step_outputs?: Record<string, unknown> | null };
  steps: PipelineStepRunResponse[];
}

interface PipelineRunListResponse {
  data: PipelineRunResponse[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export async function handlePipeline(
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
    case 'runs':
      return handleRuns(positionals, flags, context, json);
    case 'show-run':
      return handleShowRun(positionals, flags, context, json);
    case 'approve':
      return handleApprove(positionals, flags, context, json);
    case 'cancel':
      return handleCancel(positionals, flags, context, json);
    case 'logs':
      return handleLogs(positionals, flags, context, json);
    case 'delete': {
      const name = positionals[0] ?? getStringFlag(flags, ['name']);
      const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      if (!name || !projectId) {
        throw new Error('Usage: eve pipeline delete <name> [--project <id>]');
      }
      await requestRaw(
        context,
        `/projects/${projectId}/pipelines/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      outputJson({ name, deleted: true }, json, `Pipeline ${name} runs deleted`);
      return;
    }
    default:
      throw new Error(
        'Usage: eve pipeline <list|show|run|runs|show-run|approve|cancel|logs|delete>\n' +
        '  list [project]                            - list pipelines for a project\n' +
        '  show <project> <name>                     - show pipeline definition\n' +
        '  run <name> --ref <sha>                    - create and run a new pipeline\n' +
        '                                              Options: --env, --inputs <json>, --only <step>\n' +
        '  runs [project]                            - list recent pipeline runs\n' +
        '                                              Options: --limit, --status, --name <pipeline>\n' +
        '  show-run <pipeline> <run-id>              - show pipeline run status and steps\n' +
        '  approve <run-id>                          - approve a blocked pipeline run\n' +
        '  cancel <run-id> [--reason <text>]         - cancel pipeline run\n' +
        '  logs <pipeline> <run-id> [--step <name>]  - show logs for pipeline run\n' +
        '                                              Options: --follow (-f) stream live\n' +
        '  delete <name> [--project <id>]            - delete all pipeline runs',
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
    throw new Error('Usage: eve pipeline list [project] [--project=<id>]');
  }

  const response = await requestJson<PipelineListResponse>(
    context,
    `/projects/${projectId}/pipelines`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No pipelines found.');
    return;
  }

  formatPipelines(response.data);
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
    throw new Error('Usage: eve pipeline show <project> <name> [--project=<id>] [--name=<name>]');
  }

  const response = await requestJson<PipelineResponse>(
    context,
    `/projects/${projectId}/pipelines/${name}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  formatPipeline(response);
}

function formatPipelines(pipelines: PipelineResponse[]): void {
  console.log('Pipelines:');
  for (const pipeline of pipelines) {
    const stepCount = Array.isArray(pipeline.definition?.steps)
      ? pipeline.definition.steps.length
      : null;
    const suffix = stepCount === null ? '' : ` (${stepCount} steps)`;
    console.log(`- ${pipeline.name}${suffix}`);
  }
}

function formatPipeline(pipeline: PipelineResponse): void {
  console.log(`Pipeline: ${pipeline.name}`);
  console.log('Definition:');
  outputJson(pipeline.definition, false);
}

function formatPipelineRunList(runs: PipelineRunResponse[]): void {
  console.log('Recent pipeline runs:');
  console.log('');

  // Table header
  const [header, ...rows] = renderTable(
    [
      { header: 'Run ID', width: 30 },
      { header: 'Pipeline', width: 20 },
      { header: 'Status', width: 20 },
      { header: 'Created' },
    ],
    runs.map((run) => [
      run.id,
      run.pipeline_name,
      run.status,
      new Date(run.created_at).toLocaleString(),
    ]),
  );
  console.log(header);
  console.log('-'.repeat(100));
  for (const row of rows) {
    console.log(row);
  }

  console.log('');
  console.log(`Total: ${runs.length} runs`);
}

function formatPipelineRunDetail(detail: PipelineRunDetailResponse | PipelineRunDetailWithOutputsResponse): void {
  const { run, steps } = detail;

  console.log(`Run ID: ${run.id}`);
  console.log(`Pipeline: ${run.pipeline_name}`);
  console.log(`Status: ${run.status}`);

  if (run.env_name) {
    console.log(`Environment: ${run.env_name}`);
  }

  if (run.git_sha) {
    console.log(`Git SHA: ${run.git_sha}`);
  }

  // Display preview URL if present in step_outputs
  if ('step_outputs' in run && run.step_outputs) {
    const deployOutput = run.step_outputs.deploy as { preview_url?: string } | undefined;
    if (deployOutput?.preview_url) {
      console.log(`Preview: ${deployOutput.preview_url}`);
    }
  }

  if (run.started_at) {
    console.log(`Started: ${run.started_at}`);
  }

  if (run.completed_at) {
    console.log(`Completed: ${run.completed_at}`);
  }

  if (run.error_message) {
    console.log(`Error: ${run.error_message}`);
  }

  console.log('');
  console.log('Steps:');
  console.log('');

  if (steps.length === 0) {
    console.log('No steps found.');
    return;
  }

  // Table header
  console.log('Step'.padEnd(25) + 'Type'.padEnd(12) + 'Status'.padEnd(15) + 'Duration');
  console.log('-'.repeat(80));

  for (const step of steps) {
    const name = step.step_name.padEnd(25);
    const type = step.step_type.padEnd(12);
    const status = step.status.padEnd(15);

    let duration = '-';
    if (step.duration_ms !== null) {
      duration = `${step.duration_ms}ms`;
    } else if (step.started_at && !step.completed_at) {
      duration = 'running...';
    }

    console.log(`${name}${type}${status}${duration}`);

    if (step.error_message) {
      console.log(`  Error: ${step.error_message}`);
    }

    // Task 3.1: Show structured error code info when available
    const errorCode = (step as PipelineStepRunResponse & { error_code?: string }).error_code;
    if (errorCode) {
      const info = getErrorCodeInfo(errorCode);
      console.log(`  Type:  ${info.label}`);
      console.log(`  Hint:  ${info.hint}`);
    }

    // Task 2.4: Surface build_id hints on failure
    if (step.status === 'failed' && step.step_type === 'build') {
      const buildId = (step.output_json as Record<string, unknown> | null)?.build_id
        ?? (step.result_json as Record<string, unknown> | null)?.build_id;
      if (buildId) {
        console.log(`  Hint: Run 'eve build diagnose ${buildId}' for full build details`);
      } else {
        console.log(`  Hint: Run 'eve build diagnose' with the build ID for details`);
      }
    }
  }

  console.log('');
  console.log(`Total: ${steps.length} steps`);
}

async function handleRun(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const pipelineName = positionals[0] ?? getStringFlag(flags, ['name']);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const env = getStringFlag(flags, ['env']);
  const ref = getStringFlag(flags, ['ref']);
  const only = getStringFlag(flags, ['only']);
  const wait = Boolean(flags.wait);
  const timeout = getStringFlag(flags, ['timeout']);
  const inputsRaw = getStringFlag(flags, ['inputs']);
  const repoDir = getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir']);

  if (!pipelineName || !projectId || !ref) {
    throw new Error(
      'Usage: eve pipeline run <name> --ref <sha> [--env <env>] [--project <id>] [--repo-dir <path>] [--wait] [--inputs <json>] [--only <step>]',
    );
  }

  // Resolve git ref to actual 40-char SHA
  const gitSha = await resolveGitRef(context, projectId, ref, repoDir);
  if (!json && ref !== gitSha) {
    console.log(`Resolved ref '${ref}' → ${gitSha.substring(0, 8)}...`);
  }

  let inputs: Record<string, unknown> | undefined;
  if (inputsRaw) {
    try {
      inputs = JSON.parse(inputsRaw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid JSON for --inputs: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // Emit event before creating the pipeline run
  await emitPipelineRunEvent(context, projectId, pipelineName, { env, ref: gitSha, inputs });

  if (only) {
    const response = await requestJson<PipelineRunWithJobsResponse>(
      context,
      `/projects/${projectId}/pipelines/${pipelineName}/runs`,
      {
        method: 'POST',
        body: { git_sha: gitSha, env_name: env, inputs, only },
      },
    );

    if (json) {
      outputJson(response, json);
      return;
    }

    console.log('Pipeline run created (job graph).');
    console.log(`Run ID: ${response.run.id}`);
    console.log(`Jobs: ${response.jobs.length}`);
    for (const job of response.jobs) {
      const name = job.step_name ?? job.id;
      console.log(`- ${name} (${job.execution_type}) [${job.phase}]`);
    }
    return;
  }

  const query = new URLSearchParams();
  if (wait) query.set('wait', 'true');
  if (timeout) query.set('timeout', timeout);
  const queryString = query.toString();
  const url = `/projects/${projectId}/pipelines/${pipelineName}/run${queryString ? `?${queryString}` : ''}`;

  const response = await requestJson<PipelineRunDetailResponse>(
    context,
    url,
    {
      method: 'POST',
      body: { ref: gitSha, env, inputs },
    },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log('Pipeline run created.');
  console.log('');
  formatPipelineRunDetail(response);
}

async function handleRuns(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  // Support both: eve pipeline runs [project] OR eve pipeline runs <pipeline_name> [project]
  // If first arg looks like a project ID, treat as project filter
  // Otherwise treat as pipeline name for backward compat
  const firstArg = positionals[0];
  const secondArg = positionals[1];

  let projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  let pipelineName = getStringFlag(flags, ['name']);

  // Determine if first arg is project or pipeline name
  if (firstArg) {
    if (firstArg.startsWith('proj_') || firstArg.startsWith('org_')) {
      projectId = firstArg;
    } else {
      pipelineName = firstArg;
      if (secondArg) {
        projectId = secondArg;
      }
    }
  }

  if (!projectId) {
    throw new Error('Usage: eve pipeline runs [project] [--project <id>] [--name <pipeline>] [--limit N] [--status <status>]');
  }

  const query = buildQuery({
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
    status: getStringFlag(flags, ['status']),
  });

  // If pipeline name specified, use per-pipeline endpoint
  // Otherwise list all runs for the project (when that endpoint exists)
  const url = pipelineName
    ? `/projects/${projectId}/pipelines/${pipelineName}/runs${query}`
    : `/projects/${projectId}/pipelines/${pipelineName || '__all'}/runs${query}`;

  const response = await requestJson<PipelineRunListResponse>(
    context,
    url,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No pipeline runs found.');
    return;
  }

  formatPipelineRunList(response.data);
}

async function handleShowRun(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  // Signature: eve pipeline show-run <pipeline_name> <run-id>
  const pipelineName = positionals[0] ?? getStringFlag(flags, ['name']);
  const runId = positionals[1] ?? getStringFlag(flags, ['run']);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!pipelineName || !runId || !projectId) {
    throw new Error('Usage: eve pipeline show-run <pipeline_name> <run-id> [--project <id>]');
  }

  const response = await requestJson<PipelineRunDetailWithOutputsResponse>(
    context,
    `/projects/${projectId}/pipelines/${pipelineName}/runs/${runId}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  formatPipelineRunDetail(response);
}

async function handleApprove(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const runId = positionals[0] ?? getStringFlag(flags, ['run']);
  if (!runId) {
    throw new Error('Usage: eve pipeline approve <run-id>');
  }

  const response = await requestJson<PipelineRunDetailResponse>(
    context,
    `/pipeline-runs/${runId}/approve`,
    { method: 'POST' },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Approved pipeline run ${runId}.`);
  console.log('');
  formatPipelineRunDetail(response);
}

async function handleCancel(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const runId = positionals[0] ?? getStringFlag(flags, ['run']);
  const reason = getStringFlag(flags, ['reason']);
  if (!runId) {
    throw new Error('Usage: eve pipeline cancel <run-id> [--reason <text>]');
  }

  const response = await requestJson<PipelineRunDetailResponse>(
    context,
    `/pipeline-runs/${runId}/cancel`,
    {
      method: 'POST',
      body: reason ? { reason } : {},
    },
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  console.log(`Cancelled pipeline run ${runId}.`);
  console.log('');
  formatPipelineRunDetail(response);
}

async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const pipelineName = positionals[0] ?? getStringFlag(flags, ['name']);
  const runId = positionals[1] ?? getStringFlag(flags, ['run']);
  const stepName = getStringFlag(flags, ['step']);
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;

  if (!pipelineName || !runId || !projectId) {
    throw new Error('Usage: eve pipeline logs <pipeline_name> <run-id> [--step <step_name>] [--follow] [--project <id>]');
  }

  const follow = Boolean(flags.follow) || Boolean(flags.f);

  if (follow) {
    return handlePipelineFollow(context, pipelineName, runId, stepName ?? null);
  }

  // First get the run details to know which steps exist
  const runDetail = await requestJson<PipelineRunDetailResponse>(
    context,
    `/projects/${projectId}/pipelines/${pipelineName}/runs/${runId}`,
  );

  if (json) {
    outputJson(runDetail, json);
    return;
  }

  console.log(`Pipeline run: ${runDetail.run.id}`);
  console.log(`Pipeline: ${runDetail.run.pipeline_name}`);
  console.log(`Status: ${runDetail.run.status}`);
  console.log('');

  // Filter steps if specific step requested
  const stepsToShow = stepName
    ? runDetail.steps.filter(s => s.step_name === stepName)
    : runDetail.steps;

  if (stepsToShow.length === 0) {
    if (stepName) {
      console.log(`No step found with name: ${stepName}`);
    } else {
      console.log('No steps found for this pipeline run.');
    }
    return;
  }

  // Show logs for each step
  for (const step of stepsToShow) {
    console.log(`Step: ${step.step_name} (${step.step_type})`);
    console.log(`Status: ${step.status}`);

    if (step.started_at) {
      console.log(`Started: ${step.started_at}`);
    }

    if (step.completed_at) {
      console.log(`Completed: ${step.completed_at}`);
    }

    if (step.duration_ms !== null) {
      console.log(`Duration: ${step.duration_ms}ms`);
    }

    if (step.error_message) {
      console.log(`Error: ${step.error_message}`);
    }

    // Show structured error code info when available
    const errorCode = (step as PipelineStepRunResponse & { error_code?: string }).error_code;
    if (errorCode) {
      const info = getErrorCodeInfo(errorCode);
      console.log(`Type:  ${info.label}`);
      console.log(`Hint:  ${info.hint}`);
    }

    // Surface build_id hints on failure
    if (step.status === 'failed' && step.step_type === 'build') {
      const buildId = (step.output_json as Record<string, unknown> | null)?.build_id
        ?? (step.result_json as Record<string, unknown> | null)?.build_id;
      if (buildId) {
        console.log(`Hint: Run 'eve build diagnose ${buildId}' for full build details`);
      } else {
        console.log(`Hint: Run 'eve build diagnose' with the build ID for details`);
      }
    }

    if (step.result_text) {
      console.log('');
      console.log('Result:');
      console.log(step.result_text);
    }

    if (step.result_json) {
      console.log('');
      console.log('Result JSON:');
      outputJson(step.result_json, false);
    }

    console.log('');
    console.log('---');
    console.log('');
  }

  if (!stepName) {
    console.log(`Total steps: ${stepsToShow.length}`);
  }

  // Fetch actual logs from the REST endpoint
  const logsUrl = stepName
    ? `/pipeline-runs/${runId}/logs?step=${encodeURIComponent(stepName)}`
    : `/pipeline-runs/${runId}/logs`;

  try {
    const logsResp = await requestJson<{ logs?: Array<{ timestamp?: string; step_name?: string; content?: { message?: string; lines?: string[] } }> }>(
      context,
      logsUrl,
    );

    if (logsResp?.logs && Array.isArray(logsResp.logs) && logsResp.logs.length > 0) {
      renderDeployFailureFromLogs(logsResp.logs);
      console.log('\n--- Logs ---');
      for (const entry of logsResp.logs) {
        const ts = entry.timestamp ? formatPipelineTime(entry.timestamp) : '';
        const step = entry.step_name ? `[${entry.step_name}] ` : '';
        const content = entry.content ?? {};
        if (content.message) {
          console.log(`${ts}${step}${content.message}`);
        } else if (content.lines && Array.isArray(content.lines)) {
          for (const line of content.lines) {
            console.log(`${ts}${step}${line}`);
          }
        }
      }
    }
  } catch {
    // Logs endpoint may not exist yet; silently skip
  }
}

const DEPLOY_FAILURE_HINTS: Record<string, string> = {
  k8s_api_error: 'Platform issue — share the attempt_id with Eve support. Full body is in the attempt log.',
  manifest_invalid: 'Manifest rejected by K8s — run `eve manifest validate` or inspect the inline body.',
  image_pull_error: 'Check imagePullSecret or the image digest. Run `eve env diagnose <project> <env>`.',
  app_crash_loop: 'App is crashing on start. Run `eve env logs <project> <env> <service> --previous`.',
  readiness_timeout: "App came up but isn't ready. Check `eve env diagnose <project> <env>` and liveness/readiness probes.",
  dependency_timeout: '`depends_on` service did not become healthy. Check `eve env logs <project> <env> <dep-service>`.',
  ingress_conflict: 'Another ingress owns this host + path. Run `eve domain list` and `eve domain transfer` to move ownership.',
};

/**
 * Scan pipeline step logs for DeployFailure `error_context` entries and render
 * the first one found with a kind-specific "Next step" hint plus the attached
 * cluster snapshot when present.
 */
function renderDeployFailureFromLogs(
  logs: Array<{ timestamp?: string; step_name?: string; content?: { message?: string; lines?: string[] } }>,
): void {
  for (const entry of logs) {
    const content = entry.content as unknown as Record<string, unknown> | undefined;
    if (!content) continue;
    const errorContext = content.error_context as Record<string, unknown> | undefined;
    if (!errorContext || typeof errorContext.kind !== 'string') continue;
    const kind = errorContext.kind;
    const hint = DEPLOY_FAILURE_HINTS[kind];

    console.log('');
    console.log(`Failure: [${kind}]${entry.step_name ? ` in step ${entry.step_name}` : ''}`);
    if (typeof errorContext.service === 'string') {
      console.log(`  Service: ${errorContext.service}${typeof errorContext.pod === 'string' ? ` (pod ${errorContext.pod})` : ''}`);
    }
    if (typeof errorContext.message === 'string') {
      console.log(`  ${errorContext.message}`);
    }
    if (hint) {
      console.log(`Next step: ${hint}`);
    }

    const snapshot = content.cluster_snapshot as
      | { namespace?: string; pods?: Array<{ name?: string; phase?: string; restartCount?: number; ready?: boolean; containers?: Array<{ name?: string; waitingReason?: string; lastTerminatedExitCode?: number | null; lastTerminatedReason?: string | null }> }> }
      | undefined;
    if (snapshot?.pods?.length) {
      console.log('');
      console.log(`Pod snapshot (${snapshot.namespace ?? 'unknown'}):`);
      for (const pod of snapshot.pods.slice(0, 6)) {
        const firstBad = pod.containers?.find((c) => c.waitingReason || (c.lastTerminatedExitCode ?? 0) !== 0)
          ?? pod.containers?.[0];
        const reason = firstBad?.waitingReason ?? firstBad?.lastTerminatedReason ?? (pod.ready ? 'Running' : 'NotReady');
        const exit = firstBad?.lastTerminatedExitCode != null ? ` last exit=${firstBad.lastTerminatedExitCode}` : '';
        console.log(`  ${(pod.name ?? 'unknown').padEnd(40)} ${(pod.phase ?? '?').padEnd(15)} ${reason}${exit} restarts=${pod.restartCount ?? 0}`);
      }
    }
    return; // only render first DeployFailure we see
  }
}

async function handlePipelineFollow(
  context: ResolvedContext,
  pipelineName: string,
  runId: string,
  stepFilter: string | null,
): Promise<void> {
  const path = stepFilter
    ? `/pipeline-runs/${runId}/steps/${encodeURIComponent(stepFilter)}/stream`
    : `/pipeline-runs/${runId}/stream`;

  console.log(`Following pipeline run ${runId}...`);

  try {
    await requestStream(context, path, {
      flushPartialFrameOnEnd: true,
      onFrame: ({ event, data }) => {
        processPipelineSSEEvent(event ?? '', data);
      },
    });

    console.log('');
    console.log('Stream ended.');
  } catch (error) {
    const err = error as Error;
    console.error(`Error following pipeline run: ${err.message}`);
    process.exit(1);
  }
}

function processPipelineSSEEvent(eventType: string, dataStr: string): void {
  try {
    const data = JSON.parse(dataStr) as Record<string, unknown>;

    if (eventType === 'log') {
      const stepName = (data.step_name as string) ?? '???';
      const content = (data.line as Record<string, unknown>) ?? {};
      const timestamp = data.timestamp as string | undefined;
      const timeStr = timestamp ? formatPipelineTime(timestamp) : '';

      if (content.message) {
        console.log(`${timeStr}[${stepName}] ${content.message}`);
      } else if (content.lines && Array.isArray(content.lines)) {
        for (const l of content.lines as string[]) {
          console.log(`${timeStr}[${stepName}] ${l}`);
        }
      } else {
        console.log(`${timeStr}[${stepName}] ${JSON.stringify(content)}`);
      }
    } else if (eventType === 'complete') {
      console.log(`\nPipeline run completed: ${data.status}`);
    } else if (eventType === 'error') {
      console.error(`\nPipeline run failed: ${(data.errorMessage as string) ?? data.status}`);
      process.exit(1);
    }
  } catch {
    // Ignore malformed events
  }
}

function formatPipelineTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `[${d.toLocaleTimeString('en-US', { hour12: false })}] `;
  } catch {
    return '';
  }
}

/**
 * Error code info lookup - inlined from @eve/shared to avoid npm dependency.
 * Keep in sync with packages/shared/src/error-codes.ts.
 */
interface ErrorCodeInfo {
  code: string;
  label: string;
  hint: string;
}

const ERROR_CODES: Record<string, ErrorCodeInfo> = {
  auth_error:     { code: 'auth_error',     label: 'Authentication Error', hint: "Check GITHUB_TOKEN via 'eve secrets set'" },
  clone_error:    { code: 'clone_error',    label: 'Git Clone Error',      hint: "Verify repo URL and access. Check 'eve secrets list'" },
  build_error:    { code: 'build_error',    label: 'Build Error',          hint: "Run 'eve build diagnose <build_id>' for full output" },
  timeout_error:  { code: 'timeout_error',  label: 'Timeout Error',        hint: 'Consider increasing timeout or checking resources' },
  resource_error: { code: 'resource_error', label: 'Resource Error',       hint: 'Check disk space and memory on build worker' },
  registry_error: { code: 'registry_error', label: 'Registry Error',       hint: "Check registry credentials via 'eve secrets list'" },
  deploy_error:   { code: 'deploy_error',   label: 'Deploy Error',         hint: "Run 'eve env diagnose <project> <env>'" },
  unknown_error:  { code: 'unknown_error',  label: 'Unknown Error',        hint: "Run 'eve build diagnose <build_id>' or 'eve job diagnose <job_id>'" },
};

function getErrorCodeInfo(code: string): ErrorCodeInfo {
  return ERROR_CODES[code] ?? ERROR_CODES.unknown_error;
}

/**
 * Emit an event before creating a pipeline run.
 * Fire-and-forget operation - logs warning on failure but doesn't block the command.
 */
async function emitPipelineRunEvent(
  context: ResolvedContext,
  projectId: string,
  pipelineName: string,
  options: {
    env?: string;
    ref?: string;
    inputs?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const eventBody: Record<string, unknown> = {
      type: 'pipeline.run',
      source: 'manual',
      actor_type: 'user',
      actor_id: 'cli-user',
    };

    // Add optional fields
    if (options.env) {
      eventBody.env_name = options.env;
    }

    if (options.ref) {
      // Heuristic: if ref looks like a SHA (40 hex chars), treat as SHA; otherwise as branch
      const isSha = /^[0-9a-f]{40}$/i.test(options.ref);
      if (isSha) {
        eventBody.ref_sha = options.ref;
      } else {
        // Could be a branch name, short SHA, or tag - store in both for maximum compatibility
        eventBody.ref_sha = options.ref;
        eventBody.ref_branch = options.ref;
      }
    }

    // Build payload with pipeline name and inputs
    const payload: Record<string, unknown> = {
      pipeline_name: pipelineName,
    };

    if (options.inputs) {
      payload.inputs = options.inputs;
    }

    eventBody.payload_json = payload;

    // Fire-and-forget: emit event but don't block on failure
    await requestJson(
      context,
      `/projects/${projectId}/events`,
      {
        method: 'POST',
        body: eventBody,
        allowError: true,
      },
    );
  } catch (error) {
    // Log warning but don't fail the command
    console.warn('Warning: Failed to emit pipeline.run event:', error instanceof Error ? error.message : 'unknown error');
  }
}

import type { FlagValue } from '../lib/args';
import { getStringFlag } from '../lib/args';
import type { ResolvedContext } from '../lib/context';
import { requestJson, requestRaw } from '../lib/client';
import { outputJson } from '../lib/output';
import { buildQuery, renderTable } from '../lib/format';
import { resolveGitRef } from '../lib/git.js';

// ---------------------------------------------------------------------------
// Error code hints — inlined from @eve/shared to avoid npm dependency
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface BuildSpecResponse {
  id: string;
  project_id: string;
  git_sha: string;
  manifest_hash: string;
  created_by: string | null;
  services_json: Record<string, unknown> | null;
  inputs_json: Record<string, unknown> | null;
  registry_json: Record<string, unknown> | null;
  cache_json: Record<string, unknown> | null;
  created_at: string;
}

interface BuildRunResponse {
  id: string;
  build_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  backend: string | null;
  runner_ref: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  error_code: string | null;
  logs_ref: string | null;
}

interface BuildArtifactResponse {
  id: string;
  build_id: string;
  service_name: string;
  image_ref: string;
  digest: string;
  platforms_json: string[] | null;
  size_bytes: number | null;
  sbom_ref: string | null;
  provenance_ref: string | null;
  created_at: string;
}

interface BuildListResponse {
  data: BuildSpecResponse[];
  pagination?: { limit: number; offset: number; total: number };
}

interface BuildRunListResponse {
  data: BuildRunResponse[];
  pagination?: { limit: number; offset: number; total: number };
}

interface BuildArtifactListResponse {
  data: BuildArtifactResponse[];
}

interface BuildLogsResponse {
  logs: Array<{
    sequence: number;
    timestamp: string;
    line: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleBuild(
  subcommand: string | undefined,
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
): Promise<void> {
  const json = Boolean(flags.json);

  switch (subcommand) {
    case 'create':
      return handleCreate(flags, context, json);
    case 'list':
      return handleList(positionals, flags, context, json);
    case 'show':
      return handleShow(positionals, flags, context, json);
    case 'run':
      return handleRun(positionals, flags, context, json);
    case 'runs':
      return handleRuns(positionals, flags, context, json);
    case 'logs':
      return handleLogs(positionals, flags, context, json);
    case 'artifacts':
      return handleArtifacts(positionals, flags, context, json);
    case 'diagnose':
      return handleDiagnose(positionals, flags, context, json);
    case 'cancel':
      return handleCancel(positionals, flags, context, json);
    case 'delete': {
      const buildId = positionals[0];
      if (!buildId) throw new Error('Usage: eve build delete <build_id>');
      await requestRaw(context, `/builds/${buildId}`, { method: 'DELETE' });
      outputJson({ id: buildId, deleted: true }, json, `Build ${buildId} deleted`);
      return;
    }
    case 'prune': {
      const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
      if (!projectId) throw new Error('Usage: eve build prune [--project <id>] [--keep <n>]');
      const keep = getStringFlag(flags, ['keep']) ?? '10';
      const result = await requestJson<{ deleted: number }>(
        context,
        `/projects/${projectId}/builds/prune`,
        { method: 'POST', body: { keep: parseInt(keep, 10) } },
      );
      outputJson(result, json, `Pruned ${result.deleted} build(s)`);
      return;
    }
    default:
      throw new Error(
        'Usage: eve build <create|list|show|run|runs|logs|artifacts|diagnose|cancel|delete|prune>\n' +
        '  create   --project <id> --ref <sha> [--services <list>]  - create a build spec\n' +
        '  list     [--project <id>]                                - list build specs\n' +
        '  show     <build_id>                                      - show build spec details\n' +
        '  run      <build_id>                                      - start a build run\n' +
        '  runs     <build_id>                                      - list runs for a build\n' +
        '  logs     <build_id> [--run <id>]                         - show build logs\n' +
        '  artifacts <build_id>                                     - list build artifacts\n' +
        '  diagnose <build_id>                                      - show full build state\n' +
        '  cancel   <build_id>                                      - cancel active build run\n' +
        '  delete   <build_id>                                      - delete a build spec\n' +
        '  prune    [--project <id>] [--keep <n>]                   - prune old builds (keep last N)',
      );
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handleCreate(
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = getStringFlag(flags, ['project']) ?? context.projectId;
  const ref = getStringFlag(flags, ['ref']);
  const manifestHash = getStringFlag(flags, ['manifest-hash', 'manifest']);
  const services = getStringFlag(flags, ['services']);
  const repoDir = getStringFlag(flags, ['repo-dir', 'repo_dir', 'dir']);

  if (!projectId || !ref || !manifestHash) {
    throw new Error(
      'Usage: eve build create --project <id> --ref <sha> --manifest-hash <hash> [--services <s1,s2>] [--repo-dir <path>]',
    );
  }

  // Resolve git ref to actual 40-char SHA
  const gitSha = await resolveGitRef(context, projectId, ref, repoDir);
  if (!json && ref !== gitSha) {
    console.log(`Resolved ref '${ref}' → ${gitSha.substring(0, 8)}...`);
  }

  const body: Record<string, unknown> = { git_sha: gitSha, manifest_hash: manifestHash };

  if (services) {
    body.services = services.split(',').map(s => s.trim());
  }

  const build = await requestJson<BuildSpecResponse>(
    context,
    `/projects/${projectId}/builds`,
    { method: 'POST', body },
  );

  if (json) {
    outputJson(build, json);
    return;
  }

  console.log(`Build created: ${build.id}`);
  console.log(`  Project:  ${build.project_id}`);
  console.log(`  SHA:      ${build.git_sha}`);
  if (build.manifest_hash) {
    console.log(`  Manifest: ${build.manifest_hash.substring(0, 12)}...`);
  }
  console.log(`  Created:  ${build.created_at}`);
}

async function handleList(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const projectId = positionals[0] ?? getStringFlag(flags, ['project']) ?? context.projectId;

  if (!projectId) {
    throw new Error('Usage: eve build list [--project <id>]');
  }

  const query = buildQuery({
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<BuildListResponse>(
    context,
    `/projects/${projectId}/builds${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No builds found.');
    return;
  }

  formatBuildList(response.data);
}

async function handleShow(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build show <build_id>');
  }

  const build = await requestJson<BuildSpecResponse>(
    context,
    `/builds/${buildId}`,
  );

  if (json) {
    outputJson(build, json);
    return;
  }

  formatBuildDetail(build);
}

async function handleRun(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build run <build_id>');
  }

  const run = await requestJson<BuildRunResponse>(
    context,
    `/builds/${buildId}/runs`,
    { method: 'POST' },
  );

  if (json) {
    outputJson(run, json);
    return;
  }

  console.log(`Build run started: ${run.id}`);
  console.log(`  Build:   ${run.build_id}`);
  console.log(`  Status:  ${run.status}`);
  if (run.backend) {
    console.log(`  Backend: ${run.backend}`);
  }
}

async function handleRuns(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build runs <build_id>');
  }

  const query = buildQuery({
    limit: getStringFlag(flags, ['limit']),
    offset: getStringFlag(flags, ['offset']),
  });

  const response = await requestJson<BuildRunListResponse>(
    context,
    `/builds/${buildId}/runs${query}`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No runs found for this build.');
    return;
  }

  formatRunList(response.data);
}

function formatLogTimestamp(timestamp: string | undefined): string {
  if (!timestamp) return '';
  try {
    const d = new Date(timestamp);
    return `[${d.toLocaleTimeString('en-US', { hour12: false })}] `;
  } catch {
    return '';
  }
}

async function handleLogs(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);
  const runId = getStringFlag(flags, ['run']);

  if (!buildId) {
    throw new Error('Usage: eve build logs <build_id> [--run <run_id>]');
  }

  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : '';

  const logs = await requestJson<BuildLogsResponse>(
    context,
    `/builds/${buildId}/logs${query}`,
  );

  if (json) {
    outputJson(logs, json);
    return;
  }

  if (logs.logs.length === 0) {
    console.log('No logs available.');
    return;
  }

  for (const entry of logs.logs) {
    const prefix = formatLogTimestamp(entry.timestamp);
    const line = entry.line;
    if (typeof line.message === 'string') {
      console.log(`${prefix}${line.message}`);
    } else if (Array.isArray(line.lines)) {
      for (const item of line.lines) {
        if (typeof item === 'string') {
          console.log(`${prefix}${item}`);
        }
      }
    } else {
      console.log(`${prefix}${JSON.stringify(line)}`);
    }

    if (line.level === 'error' && typeof line.error_code === 'string') {
      const info = getErrorCodeInfo(line.error_code);
      console.log(`${prefix}  Type: ${info.label}`);
      console.log(`${prefix}  Hint: ${info.hint}`);
    }
  }
}

async function handleArtifacts(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build artifacts <build_id>');
  }

  const response = await requestJson<BuildArtifactListResponse>(
    context,
    `/builds/${buildId}/artifacts`,
  );

  if (json) {
    outputJson(response, json);
    return;
  }

  if (response.data.length === 0) {
    console.log('No artifacts found for this build.');
    return;
  }

  formatArtifactList(response.data);
}

async function handleCancel(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build cancel <build_id>');
  }

  const result = await requestJson<{ message: string }>(
    context,
    `/builds/${buildId}/cancel`,
    { method: 'POST' },
  );

  if (json) {
    outputJson(result, json);
    return;
  }

  console.log(`Build cancelled: ${buildId}`);
}

async function handleDiagnose(
  positionals: string[],
  flags: Record<string, FlagValue>,
  context: ResolvedContext,
  json: boolean,
): Promise<void> {
  const buildId = positionals[0] ?? getStringFlag(flags, ['id']);

  if (!buildId) {
    throw new Error('Usage: eve build diagnose <build_id>');
  }

  const spec = await requestJson<BuildSpecResponse>(
    context,
    `/builds/${buildId}`,
  );
  const runs = await requestJson<BuildRunListResponse>(
    context,
    `/builds/${buildId}/runs?limit=20&offset=0`,
  );
  const artifacts = await requestJson<BuildArtifactListResponse>(
    context,
    `/builds/${buildId}/artifacts`,
  );

  const latestRun = runs.data[0];
  const logs = latestRun
    ? await requestJson<BuildLogsResponse>(
        context,
        `/builds/${buildId}/logs?run_id=${encodeURIComponent(latestRun.id)}`,
      )
    : { logs: [] };

  const payload = { spec, runs: runs.data, artifacts: artifacts.data, logs: logs.logs };

  if (json) {
    outputJson(payload, json);
    return;
  }

  console.log(`Build diagnose: ${spec.id}`);
  formatBuildDetail(spec);
  console.log('');
  if (runs.data.length > 0) {
    formatRunList(runs.data);
  } else {
    console.log('No runs found.');
  }
  console.log('');
  if (artifacts.data.length > 0) {
    formatArtifactList(artifacts.data);
  } else {
    console.log('No artifacts found.');
  }
  console.log('');
  if (logs.logs.length > 0) {
    console.log('Recent logs:');
    for (const entry of logs.logs.slice(-50)) {
      const line = entry.line;
      if (typeof line.message === 'string') {
        console.log(line.message);
      } else if (Array.isArray(line.lines)) {
        for (const item of line.lines) {
          if (typeof item === 'string') {
            console.log(item);
          }
        }
      } else {
        console.log(JSON.stringify(line));
      }

      if (line.level === 'error' && typeof line.error_code === 'string') {
        const info = getErrorCodeInfo(line.error_code);
        console.log(`  Type: ${info.label}`);
        console.log(`  Hint: ${info.hint}`);
      }
    }
  } else {
    console.log('No logs found.');
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatBuildList(builds: BuildSpecResponse[]): void {
  const [header, ...rows] = renderTable(
    [
      { header: 'Build ID', width: 30 },
      { header: 'SHA', width: 12 },
      { header: 'Created By', width: 20 },
      { header: 'Created' },
    ],
    builds.map((build) => [
      build.id,
      build.git_sha.substring(0, 8),
      build.created_by ?? '-',
      new Date(build.created_at).toLocaleString(),
    ]),
  );
  console.log(header);
  console.log('-'.repeat(90));
  for (const row of rows) {
    console.log(row);
  }

  console.log('');
  console.log(`Total: ${builds.length} builds`);
}

function formatBuildDetail(build: BuildSpecResponse): void {
  console.log(`Build: ${build.id}`);
  console.log(`  Project:       ${build.project_id}`);
  console.log(`  SHA:           ${build.git_sha}`);
  console.log(`  Manifest Hash: ${build.manifest_hash}`);
  console.log(`  Created By:    ${build.created_by ?? '-'}`);
  console.log(`  Created:       ${build.created_at}`);

  if (build.services_json) {
    console.log(`  Services:      ${JSON.stringify(build.services_json)}`);
  }

  if (build.inputs_json) {
    console.log(`  Inputs:        ${JSON.stringify(build.inputs_json)}`);
  }

  if (build.registry_json) {
    console.log(`  Registry:      ${JSON.stringify(build.registry_json)}`);
  }

  if (build.cache_json) {
    console.log(`  Cache:         ${JSON.stringify(build.cache_json)}`);
  }
}

function formatRunList(runs: BuildRunResponse[]): void {
  console.log('Run ID'.padEnd(30) + 'Status'.padEnd(15) + 'Backend'.padEnd(15) + 'Started');
  console.log('-'.repeat(80));

  for (const run of runs) {
    const id = run.id.padEnd(30);
    const status = run.status.padEnd(15);
    const backend = (run.backend ?? '-').padEnd(15);
    const started = run.started_at ? new Date(run.started_at).toLocaleString() : '-';
    console.log(`${id}${status}${backend}${started}`);

    if (run.error_message) {
      console.log(`  Error: ${run.error_message}`);
    }

    if (run.error_code) {
      const info = getErrorCodeInfo(run.error_code);
      console.log(`  Error Type: ${info.label}`);
      console.log(`  Hint:       ${info.hint}`);
    }
  }

  console.log('');
  console.log(`Total: ${runs.length} runs`);
}

function formatArtifactList(artifacts: BuildArtifactResponse[]): void {
  console.log('Service'.padEnd(25) + 'Image'.padEnd(50) + 'Size');
  console.log('-'.repeat(90));

  for (const artifact of artifacts) {
    const service = artifact.service_name.padEnd(25);
    const image = artifact.image_ref.padEnd(50);
    const size = artifact.size_bytes ? formatBytes(artifact.size_bytes) : '-';
    console.log(`${service}${image}${size}`);

    if (artifact.digest) {
      console.log(`  Digest: ${artifact.digest}`);
    }

    if (artifact.platforms_json && artifact.platforms_json.length > 0) {
      console.log(`  Platforms: ${artifact.platforms_json.join(', ')}`);
    }
  }

  console.log('');
  console.log(`Total: ${artifacts.length} artifacts`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}


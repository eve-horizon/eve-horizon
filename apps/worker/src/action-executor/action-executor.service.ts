import { Injectable, Inject, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { Db } from '@eve/db';
import {
  environmentQueries,
  buildQueries,
  executionLogQueries,
  jobQueries,
  orgQueries,
  pipelineRunQueries,
  projectManifestQueries,
  projectQueries,
  releaseQueries,
  threadMessageQueries,
} from '@eve/db';
import {
  applyEnvOverrides,
  DEFAULT_ACTION_RUN_JOB_PERMISSIONS,
  deliverProvisioningError,
  extractSecretRefs,
  generateReleaseId,
  generateBuildId,
  generateBuildRunId,
  generateBuildArtifactId,
  generateManifestId,
  buildAuthenticatedHttpsUrl,
  type AccessBindingScope,
  type Manifest,
  getBuildableServicesWithDefaults,
  getRegistryConfig,
  ensureToolchains,
  isEveRegistry,
  loadConfig,
  mintJobToken,
  resolveProjectSecrets,
  expandManifestReferences,
  type RelayDb,
  type SecretResolveItem,
  type ToolchainCacheEvent,
  toK8sName,
  readPositiveTimeoutSeconds,
} from '@eve/shared';
import * as yaml from 'yaml';
import { DeployerService } from '../deployer/deployer.service';
import { ImageBuilderService } from '../builder/image-builder.service.js';
import { classifyBuildError } from './error-classifier.js';
import { K8sOperationError } from '../deployer/k8s-error.js';
import { DeployFailureError, classifyFromSnapshot } from '../deployer/deploy-failure.js';
import { runStreamingCommand } from '../execution/streaming-command.js';

const execFileAsync = promisify(execFile);

function isMissingSecretOverrideError(
  error: unknown,
): error is Error & { code: 'missing_secret_override'; missing: string[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'missing_secret_override' &&
    Array.isArray((error as { missing?: unknown }).missing)
  );
}

/**
 * Pull typed context off an error so we can log structured fields and persist
 * them on the attempt for diagnosis later. Currently surfaces K8sOperationError
 * fields; later phases will add DeployFailure kinds.
 */
function extractErrorContext(error: unknown): Record<string, unknown> {
  if (error instanceof DeployFailureError) {
    return {
      error_context: {
        ...error.failure,
      },
      cluster_snapshot: error.snapshot ?? undefined,
    };
  }
  if (error instanceof K8sOperationError) {
    return {
      error_context: {
        kind: 'k8s_api_error',
        status_code: error.statusCode,
        reason: error.reason,
        operation: error.operation,
        resource_kind: error.resourceKind,
        resource_name: error.resourceName,
        namespace: error.namespace,
      },
    };
  }
  return {};
}

type ManifestShape = {
  environments?: Record<string, { approval?: string }>;
  tests?: Record<string, { command?: string }>;
  services?: Record<string, { image?: string }>;
};

interface ActionInput {
  components?: string[];
  git_sha?: string;
  manifest_hash?: string;
  env_name?: string;
  release_id?: string;
  timeout?: number;
  service?: string;
  timeout_seconds?: number;
  command?: string;
  command_ref?: string;
  channel?: string;
  message?: string;
  repo?: string;
  base?: string;
  head?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  dry_run?: boolean;
  // env-ensure action
  kind?: 'standard' | 'preview';
  labels?: Record<string, string>;
  image_digests?: Record<string, string>;
  tag?: string;
  build_id?: string;
  force_rebuild?: boolean;
}

function resolveRunTimeoutSeconds(
  input: ActionInput,
  job: { hints?: Record<string, unknown> | null } | null,
): number {
  return (
    readPositiveTimeoutSeconds(input.timeout_seconds) ??
    readPositiveTimeoutSeconds(input.timeout) ??
    readPositiveTimeoutSeconds(job?.hints?.timeout_seconds) ??
    1800
  );
}

function normalizeRepoSlug(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const githubMatch = trimmed.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (githubMatch && githubMatch[1]) {
    return githubMatch[1];
  }

  const simpleMatch = trimmed.replace(/\.git$/, '').split('/');
  if (simpleMatch.length >= 2) {
    return `${simpleMatch[simpleMatch.length - 2]}/${simpleMatch[simpleMatch.length - 1]}`;
  }

  return null;
}

function resolveRepoSlug(inputRepo?: string, repoUrl?: string | null): string {
  const candidates = [inputRepo, repoUrl].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const slug = normalizeRepoSlug(candidate);
    if (slug) return slug;
  }
  throw new Error('Create PR action requires repo (owner/name) or project repo_url');
}

function getJobToolchains(job: unknown): string[] {
  const hints = (job as { hints?: unknown })?.hints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return [];
  const value = (hints as Record<string, unknown>).toolchains;
  return Array.isArray(value) ? value as string[] : [];
}

function formatToolchainEvent(event: ToolchainCacheEvent): string {
  switch (event.type) {
    case 'cache_hit':
      return `Toolchain ${event.toolchain} cache hit`;
    case 'install_wait':
      return `Waiting for toolchain ${event.toolchain} install`;
    case 'install_start':
      return `Installing toolchain ${event.toolchain}`;
    case 'install_done':
      return `Installed toolchain ${event.toolchain}`;
    case 'env_loaded':
      return `Loaded toolchain ${event.toolchain} environment`;
  }
}

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);
  private jobs: ReturnType<typeof jobQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private runs: ReturnType<typeof pipelineRunQueries>;
  private envs: ReturnType<typeof environmentQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private logs: ReturnType<typeof executionLogQueries>;
  private builds: ReturnType<typeof buildQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly deployer: DeployerService,
    private readonly imageBuilder: ImageBuilderService,
  ) {
    this.jobs = jobQueries(db);
    this.orgs = orgQueries(db);
    this.runs = pipelineRunQueries(db);
    this.envs = environmentQueries(db);
    this.manifests = projectManifestQueries(db);
    this.projects = projectQueries(db);
    this.releases = releaseQueries(db);
    this.logs = executionLogQueries(db);
    this.builds = buildQueries(db);
  }

  private buildRelayDb(): RelayDb {
    return {
      queryJobHints: async (jobId) => {
        const rows = await this.db<{ hints: Record<string, unknown> | null }[]>`
          SELECT hints FROM jobs WHERE id = ${jobId}
        `;
        return rows[0];
      },
      createThreadMessage: async (msg) => {
        await threadMessageQueries(this.db).create(msg);
      },
    };
  }

  /**
   * Execute an action job
   *
   * @param jobId - Job ID to execute
   * @param attemptId - Attempt ID for logging
   * @returns Result with success flag and optional error message
   */
  async execute(jobId: string, attemptId: string): Promise<{ success: boolean; error?: string; resultText?: string; output?: Record<string, unknown> }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      return { success: false, error: `Job ${jobId} not found` };
    }

    if (job.execution_type !== 'action') {
      return { success: false, error: `Job ${jobId} is not an action job (execution_type=${job.execution_type})` };
    }

    const actionType = job.action_type;
    const actionInput: ActionInput = job.action_input ?? {};

    if (!actionType) {
      return { success: false, error: 'Action job missing action_type' };
    }

    await this.jobs.markExecutionStarted(attemptId);

    const mergedInput = await this.resolveActionInput(job, actionInput, actionType);

    await this.appendLog(attemptId, 'status', {
      message: `Starting ${actionType} action`,
      timestamp: new Date().toISOString(),
    });

    // Auto-resolve type: run + service (no command) → type: job
    let resolvedActionType = actionType;
    if (
      actionType === 'run' &&
      mergedInput.service &&
      !mergedInput.command &&
      !mergedInput.command_ref
    ) {
      this.logger.warn(
        `Auto-resolving "type: run" to "type: job" for service "${mergedInput.service}" ` +
        `(no command provided). Update manifest to use "type: job" directly.`,
      );
      resolvedActionType = 'job';
    }

    let actionOutput: Record<string, unknown> | undefined;
    let resultText: string | undefined;

    try {
      switch (resolvedActionType) {
        case 'build':
          actionOutput = await this.handleBuild(attemptId, job.project_id, mergedInput);
          break;
        case 'release':
          actionOutput = await this.handleRelease(attemptId, job.project_id, mergedInput);
          break;
        case 'deploy':
          actionOutput = await this.handleDeploy(attemptId, job.project_id, mergedInput);
          break;
        case 'job':
          actionOutput = await this.handleJob(attemptId, job.project_id, mergedInput);
          break;
        case 'run':
          actionOutput = await this.handleRun(attemptId, job.id, job.project_id, mergedInput);
          break;
        case 'notify':
          await this.handleNotify(attemptId, job.project_id, mergedInput);
          break;
        case 'create-pr':
          actionOutput = await this.handleCreatePr(attemptId, job.project_id, mergedInput);
          if (actionOutput && 'pr_url' in actionOutput) {
            const prUrl = actionOutput.pr_url as string | null;
            resultText = prUrl ? `Created PR ${prUrl}` : 'Create PR action completed';
          } else {
            resultText = 'Create PR action completed';
          }
          break;
        case 'env-ensure':
          actionOutput = await this.handleEnvEnsure(attemptId, job.project_id, mergedInput);
          if (actionOutput && 'created' in actionOutput) {
            const created = actionOutput.created as boolean;
            const envName = actionOutput.environment && typeof actionOutput.environment === 'object'
              ? (actionOutput.environment as { name?: string }).name
              : mergedInput.env_name;
            resultText = created
              ? `Created environment ${envName}`
              : `Environment ${envName} already exists`;
          } else {
            resultText = 'Env-ensure action completed';
          }
          break;
        case 'env-delete':
          actionOutput = await this.handleEnvDelete(attemptId, job.project_id, mergedInput);
          if (actionOutput && 'deleted' in actionOutput) {
            const deleted = actionOutput.deleted as boolean;
            const envName = actionOutput.env_name as string;
            resultText = deleted
              ? `Deleted environment ${envName}`
              : `Environment ${envName} not found (already deleted)`;
          } else {
            resultText = 'Env-delete action completed';
          }
          break;
        default:
          throw new Error(`Unsupported action type: ${actionType}`);
      }

      await this.appendLog(attemptId, 'status', {
        message: `Action ${actionType} completed successfully`,
        timestamp: new Date().toISOString(),
      });

      return { success: true, resultText, output: actionOutput };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;
      const errorContext = extractErrorContext(error);

      // Log to stdout with full stack + structured context — previously this was
      // only written to the attempt log, which made `kubectl logs` searches turn
      // up nothing for deploy failures.
      this.logger.error(
        `Action ${actionType} failed: ${message}`,
        stack,
        JSON.stringify({
          attempt_id: attemptId,
          project_id: job.project_id,
          action: actionType,
          error_class: errorClass,
          ...errorContext,
        }),
      );

      await this.appendLog(attemptId, 'error', {
        message,
        timestamp: new Date().toISOString(),
        error_class: errorClass,
        ...(typeof (error as { code?: unknown })?.code === 'string'
          ? { code: (error as { code: string }).code }
          : {}),
        ...(isMissingSecretOverrideError(error) ? { missing: error.missing } : {}),
        ...errorContext,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Handle build action
   * Builds container images for specified components (or all buildable services)
   */
  private async handleBuild(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    const project = await this.projects.findById(projectId);
    if (!project?.repo_url) {
      throw new Error(`Build action requires project repo_url (project ${projectId})`);
    }

    if (!input.git_sha) {
      throw new Error('Build action requires git_sha');
    }

    if (!input.manifest_hash) {
      throw new Error('Build action requires manifest_hash');
    }

    const manifest = await this.manifests.findByProjectAndHash(projectId, input.manifest_hash);
    if (!manifest) {
      throw new Error(`Manifest ${input.manifest_hash} not found for project ${projectId}`);
    }

    const parsedManifest = yaml.parse(manifest.manifest_yaml) as Manifest;
    const buildable = getBuildableServicesWithDefaults(parsedManifest);
    const registry = getRegistryConfig(parsedManifest);
    const registryHost = registry?.host
      ?? (isEveRegistry(parsedManifest) ? loadConfig().EVE_REGISTRY_HOST ?? null : null);

    const components = input.components ?? [];
    await this.appendLog(attemptId, 'status', {
      message: components.length > 0
        ? `Building components: ${components.join(', ')}`
        : 'Building all components',
      git_sha: input.git_sha,
      manifest_hash: input.manifest_hash,
      timestamp: new Date().toISOString(),
    });

    const services = components.length > 0
      ? components
      : Object.keys(buildable);

    const allowReuse = !input.force_rebuild && process.env.EVE_BUILD_REUSE !== 'false';
    if (allowReuse) {
      const reusable = await this.findReusableBuild(projectId, input.git_sha, input.manifest_hash, services);
      if (reusable) {
        await this.appendLog(attemptId, 'status', {
          message: `Reusing existing build ${reusable.build_id} for ${services.join(', ')}`,
          git_sha: input.git_sha,
          manifest_hash: input.manifest_hash,
          timestamp: new Date().toISOString(),
        });
        await this.appendLog(attemptId, 'output', {
          image_digests: reusable.image_digests,
          build_id: reusable.build_id,
          reused: true,
          timestamp: new Date().toISOString(),
        });
        return {
          image_digests: reusable.image_digests,
          build_id: reusable.build_id,
          reused: true,
        };
      }
    }

    const buildId = generateBuildId();
    const buildSpec = await this.builds.createSpec({
      id: buildId,
      project_id: projectId,
      git_sha: input.git_sha,
      manifest_hash: input.manifest_hash,
      services_json: services,
      inputs_json: input as Record<string, unknown>,
      registry_json: registry as Record<string, unknown> | null,
      cache_json: null,
      created_by: null,
    });

    const inK8s = process.env.EVE_RUNTIME === 'k8s' || Boolean(process.env.KUBERNETES_SERVICE_HOST);
    const backend = (process.env.EVE_BUILD_BACKEND ?? (inK8s ? 'buildkit' : 'buildx')).toLowerCase();

    const buildRun = await this.builds.createRun({
      id: generateBuildRunId(),
      build_id: buildSpec.id,
      status: 'running',
      backend,
      runner_ref: null,
      logs_ref: null,
      error_message: null,
      error_code: null,
      started_at: new Date(),
      completed_at: null,
    });

    await this.builds.appendLog(buildRun.id, 'status', {
      message: `Build run started (${backend})`,
      build_id: buildSpec.id,
      run_id: buildRun.id,
      timestamp: new Date().toISOString(),
    });

    const logBuffer: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let flushing = false;

    const flushLogs = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (logBuffer.length > 0) {
          const lines = logBuffer.splice(0, 50);
          await this.appendLog(attemptId, 'log', {
            lines,
            timestamp: new Date().toISOString(),
          });
          await this.builds.appendLog(buildRun.id, 'log', {
            lines,
            timestamp: new Date().toISOString(),
          });
        }
      } finally {
        flushing = false;
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushLogs();
      }, 500);
    };

    const onLog = (line: string) => {
      if (!line) return;
      logBuffer.push(line);
      if (logBuffer.length >= 50) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        void flushLogs();
        return;
      }
      scheduleFlush();
    };

    let workspace: string | null = null;
    const imageDigests: Record<string, string> = {};

    try {
      workspace = await this.prepareWorkspace(project.repo_url, input.git_sha, projectId, (msg) => {
        void this.appendLog(attemptId, 'status', {
          message: msg, phase: 'workspace', timestamp: new Date().toISOString(),
        });
      });

      // Auto-sync manifest from cloned repo so workflow triggers stay current
      await this.autoSyncManifestFromWorkspace(workspace, projectId, input.git_sha, input.manifest_hash, attemptId);

      const result = await this.imageBuilder.buildAll({
        manifest: {} as any, // Not used by buildAll (it re-parses from YAML)
        manifestYaml: manifest.manifest_yaml,
        gitSha: input.git_sha,
        workspacePath: workspace,
        projectId,
        components: input.components,
        tag: input.tag,
        onLog,
      });

      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushLogs();

      Object.assign(imageDigests, result.imageDigests);

      await this.appendLog(attemptId, 'output', {
        image_digests: result.imageDigests,
        timestamp: new Date().toISOString(),
      });

      for (const [serviceName, digest] of Object.entries(result.imageDigests)) {
        const service = buildable[serviceName];
        const image = service?.image;
        if (!image) continue;
        const imageWithoutDigest = image.split('@')[0];
        const lastSlashIndex = imageWithoutDigest.lastIndexOf('/');
        const lastColonIndex = imageWithoutDigest.lastIndexOf(':');
        const imageName =
          lastColonIndex > lastSlashIndex
            ? imageWithoutDigest.slice(0, lastColonIndex)
            : imageWithoutDigest;
        const imageFirstSegment = imageName.split('/')[0];
        const hasRegistry =
          imageFirstSegment.includes('.') ||
          imageFirstSegment.includes(':') ||
          imageFirstSegment === 'localhost';
        const imageRef = hasRegistry || !registryHost
          ? image
          : `${registryHost}/${image}`;

        await this.builds.createArtifact({
          id: generateBuildArtifactId(),
          build_id: buildSpec.id,
          service_name: serviceName,
          image_ref: imageRef,
          digest,
          platforms_json: null,
          size_bytes: null,
          sbom_ref: null,
          provenance_ref: null,
        });
      }

      await this.builds.updateRun(buildRun.id, {
        status: 'succeeded',
        completed_at: new Date(),
      });

      await this.builds.appendLog(buildRun.id, 'status', {
        message: 'Build run completed',
        image_digests: result.imageDigests,
        timestamp: new Date().toISOString(),
      });

      return { image_digests: result.imageDigests, build_id: buildSpec.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = classifyBuildError(message);
      await this.builds.updateRun(buildRun.id, {
        status: 'failed',
        error_message: message,
        error_code: errorCode,
        completed_at: new Date(),
      });
      await this.builds.appendLog(buildRun.id, 'error', {
        message,
        error_code: errorCode,
        build_id: buildSpec.id,
        build_run_id: buildRun.id,
        output_tail: logBuffer.slice(-30).join('\n'),
        services_succeeded: Object.keys(imageDigests),
        timestamp: new Date().toISOString(),
      });
      await this.appendLog(attemptId, 'error', {
        message,
        error_code: errorCode,
        build_id: buildSpec.id,
        timestamp: new Date().toISOString(),
      });
      throw error;
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushLogs();
      if (workspace) {
        await this.cleanupWorkspace(workspace);
      }
    }
  }

  private async findReusableBuild(
    projectId: string,
    gitSha: string,
    manifestHash: string,
    services: string[],
  ): Promise<{ build_id: string; image_digests: Record<string, string> } | null> {
    const requested = new Set(services);
    const specs = await this.builds.listSpecs({ project_id: projectId, limit: 50, offset: 0 });
    for (const spec of specs) {
      if (spec.git_sha !== gitSha || spec.manifest_hash !== manifestHash) {
        continue;
      }

      const latestRun = await this.builds.findLatestRunByBuildId(spec.id);
      if (!latestRun || latestRun.status !== 'succeeded') {
        continue;
      }

      const artifacts = await this.builds.listArtifacts({
        build_id: spec.id,
        limit: 1000,
        offset: 0,
      });

      const imageDigests: Record<string, string> = {};
      for (const artifact of artifacts) {
        if (requested.has(artifact.service_name)) {
          imageDigests[artifact.service_name] = artifact.digest;
        }
      }

      const missing = services.filter((service) => !imageDigests[service]);
      if (missing.length === 0) {
        return { build_id: spec.id, image_digests: imageDigests };
      }
    }
    return null;
  }

  /**
   * Handle release action
   * Creates a new release with the specified git SHA and manifest hash
   */
  private async handleRelease(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    if (!input.git_sha || !input.manifest_hash) {
      throw new Error('Release action requires git_sha and manifest_hash');
    }

    const project = await this.projects.findById(projectId);
    if (!project?.repo_url) {
      throw new Error(`Release action requires project repo_url (project ${projectId})`);
    }

    let imageDigests: Record<string, string> | null = input.image_digests ?? null;

    if (input.build_id) {
      const buildSpec = await this.builds.findSpecById(input.build_id);
      if (!buildSpec) {
        throw new Error(`Build ${input.build_id} not found`);
      }
      if (buildSpec.project_id !== projectId) {
        throw new Error(`Build ${input.build_id} does not belong to project ${projectId}`);
      }
      if (buildSpec.git_sha !== input.git_sha) {
        throw new Error(`Build ${input.build_id} git_sha does not match release git_sha`);
      }
      if (buildSpec.manifest_hash !== input.manifest_hash) {
        throw new Error(`Build ${input.build_id} manifest_hash does not match release manifest_hash`);
      }
      const artifacts = await this.builds.listArtifacts({ build_id: input.build_id, limit: 1000, offset: 0 });
      if (artifacts.length === 0) {
        throw new Error(`No build artifacts found for build ${input.build_id}`);
      }
      imageDigests = {};
      for (const artifact of artifacts) {
        imageDigests[artifact.service_name] = artifact.digest;
      }
    }

    if (!imageDigests) {
      throw new Error('Release action requires build_id or image_digests');
    }

    await this.appendLog(attemptId, 'status', {
      message: `Creating release for git_sha=${input.git_sha}, manifest_hash=${input.manifest_hash}`,
      build_id: input.build_id ?? null,
      timestamp: new Date().toISOString(),
    });

    const workspace = await this.prepareWorkspace(project.repo_url, input.git_sha, projectId, (msg) => {
      void this.appendLog(attemptId, 'status', {
        message: msg, phase: 'workspace', timestamp: new Date().toISOString(),
      });
    });
    let version: string | null = null;
    let tag: string | null = null;

    try {
      const result = await this.computeNextVersion(workspace, input.git_sha);
      version = result.version;
      tag = result.tag;

      try {
        await execFileAsync('git', ['tag', '-a', tag, '-m', `Release ${tag}`], {
          cwd: workspace,
          env: process.env,
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        await this.appendLog(attemptId, 'status', {
          message: `Warning: failed to create git tag ${tag}: ${error instanceof Error ? error.message : 'unknown error'}`,
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      await this.cleanupWorkspace(workspace);
    }

    const releaseId = generateReleaseId();
    const release = await this.releases.create({
      id: releaseId,
      project_id: projectId,
      git_sha: input.git_sha,
      manifest_hash: input.manifest_hash,
      image_digests_json: imageDigests,
      build_id: input.build_id ?? null,
      version,
      tag,
      created_by: null,
    });

    await this.appendLog(attemptId, 'output', {
      release_id: release.id,
      build_id: release.build_id,
      version: release.version,
      tag: release.tag,
      message: `Release ${release.id} created`,
      timestamp: new Date().toISOString(),
    });

    return { release_id: release.id, build_id: release.build_id, version: release.version, tag: release.tag };
  }

  /**
   * Handle deploy action
   * Deploys a release to the specified environment with gate acquisition
   */
  private async handleDeploy(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    if (!input.env_name) {
      throw new Error('Deploy action requires env_name');
    }

    if (!input.release_id) {
      throw new Error('Deploy action requires release_id');
    }

    const environment = await this.envs.findByProjectAndName(projectId, input.env_name);
    if (!environment) {
      throw new Error(`Environment ${input.env_name} not found for project ${projectId}`);
    }

    // For deploy actions, gates should be acquired using pattern: env:<project_id>:<env_name>
    const gateKey = `env:${projectId}:${input.env_name}`;
    await this.appendLog(attemptId, 'status', {
      message: `Deploying release ${input.release_id} to environment ${input.env_name}`,
      gate: gateKey,
      timestamp: new Date().toISOString(),
    });

    const timeout = input.timeout ?? 180;
    let deployStatus: Awaited<ReturnType<typeof this.deployer.deploy>>;
    try {
      deployStatus = await this.deployer.deploy(environment.id, input.release_id, {
        timeout,
      });
    } catch (err) {
      // Partial apply: manifest may have landed in the cluster even though the
      // step threw. Record the applied-but-unhealthy state so `eve env show`
      // surfaces the drift between DB (last ready) and cluster (this release).
      await this.recordDeployFailure(environment.id, input.release_id, err);
      throw err;
    }

    await this.appendLog(attemptId, 'status', {
      message: `Deployment initiated; waiting up to ${timeout}s for readiness`,
      timestamp: new Date().toISOString(),
    });

    // Wait for deployment to be ready if not already
    let finalStatus: Awaited<ReturnType<typeof this.waitForDeployReady>>;
    try {
      finalStatus = deployStatus.k8sStatus?.ready
        ? deployStatus
        : await this.waitForDeployReady(environment.id, timeout, attemptId);
    } catch (err) {
      await this.recordDeployFailure(environment.id, input.release_id, err);
      throw err;
    }

    // Compute preview URL for the deployment
    const previewUrl = await this.computePreviewUrl(projectId, input.release_id, input.env_name);

    // Record the healthy deploy: current_release_id advances (it's the new
    // rollback base), last_applied mirrors it, and any prior failure state is
    // cleared. Mismatches between the stored release and the cluster would now
    // be visible in `eve env show`.
    // Always persist namespace — it's an infrastructure fact the sentinel needs
    // to discover and monitor the environment. The deployer returns the
    // canonical (toK8sName-normalized) value.
    await this.envs.update(environment.id, {
      current_release_id: input.release_id,
      last_applied_release_id: input.release_id,
      last_failed_release_id: null,
      last_deploy_failure_json: null,
      deploy_status: 'deployed',
      ...(finalStatus.namespace ? { namespace: finalStatus.namespace } : {}),
    });

    await this.appendLog(attemptId, 'output', {
      deployment: finalStatus,
      message: `Deployed release ${input.release_id} to ${input.env_name}`,
      preview_url: previewUrl,
      timestamp: new Date().toISOString(),
    });

    return {
      deployment: finalStatus,
      release_id: input.release_id,
      env_id: environment.id,
      env_name: input.env_name,
      preview_url: previewUrl,
    };
  }

  /**
   * Persist the applied-but-unhealthy state of a failed deploy so `eve env show`
   * can explain the drift between DB's last-ready release and the running
   * cluster. Must not throw — the caller already has a failure to propagate.
   */
  private async recordDeployFailure(
    environmentId: string,
    releaseId: string,
    error: unknown,
  ): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      let failure: Record<string, unknown>;

      if (error instanceof DeployFailureError) {
        failure = {
          ...error.failure,
          release_id: releaseId,
          at: new Date().toISOString(),
          manifest_applied: error.manifestApplied,
        };
      } else {
        failure = {
          kind: 'k8s_api_error',
          release_id: releaseId,
          message,
          at: new Date().toISOString(),
          manifest_applied: false,
        };
        const k8s = error as {
          statusCode?: number;
          reason?: string;
          operation?: string;
          resourceKind?: string;
          resourceName?: string;
          namespace?: string;
        };
        if (k8s?.namespace) failure.namespace = k8s.namespace;
        if (k8s?.statusCode) failure.status_code = k8s.statusCode;
        if (k8s?.reason) failure.reason = k8s.reason;
        if (k8s?.operation) failure.operation = k8s.operation;
        if (k8s?.resourceKind) failure.resource_kind = k8s.resourceKind;
        if (k8s?.resourceName) failure.resource_name = k8s.resourceName;
      }

      const manifestApplied = error instanceof DeployFailureError
        ? error.manifestApplied
        : false;

      await this.envs.update(environmentId, {
        last_applied_release_id: manifestApplied ? releaseId : undefined,
        last_failed_release_id: releaseId,
        last_deploy_failure_json: failure,
        deploy_status: 'failed',
      });
    } catch (updateErr) {
      this.logger.warn(
        `Failed to record deploy failure state for env ${environmentId}: ${
          updateErr instanceof Error ? updateErr.message : String(updateErr)
        }`,
      );
    }
  }

  /**
   * Handle job action
   * Runs a job service in the target environment
   */
  private async handleJob(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    if (!input.env_name) {
      throw new Error('Job action requires env_name');
    }

    if (!input.service) {
      throw new Error('Job action requires service');
    }

    let manifestHash = input.manifest_hash;
    let imageDigests: Record<string, string> | undefined;
    let imageTag: string | undefined;

    if (input.release_id) {
      const release = await this.releases.findById(input.release_id);
      if (!release) {
        throw new Error(`Release ${input.release_id} not found`);
      }
      manifestHash = manifestHash ?? release.manifest_hash;
      imageDigests = release.image_digests_json ?? undefined;
      imageTag = release.tag ?? undefined;
    }

    if (!manifestHash) {
      throw new Error('Job action requires manifest_hash');
    }

    const manifest = await this.manifests.findByProjectAndHash(projectId, manifestHash);
    if (!manifest) {
      throw new Error(`Manifest ${manifestHash} not found for project ${projectId}`);
    }

    const timeoutSeconds = input.timeout_seconds ?? input.timeout ?? 300;

    await this.appendLog(attemptId, 'status', {
      message: `Running job service ${input.service} in ${input.env_name}`,
      timestamp: new Date().toISOString(),
    });

    // Clone repo for remote projects so x-eve.files and local secrets work
    // Prefer input.git_sha (user's --ref) over manifest.git_sha (last sync)
    const gitSha = input.git_sha ?? manifest.git_sha;
    let workspace: string | null = null;
    try {
      if (gitSha) {
        const project = await this.projects.findById(projectId);
        if (project?.repo_url && !project.repo_url.startsWith('file://') && !project.repo_url.startsWith('/')) {
          workspace = await this.prepareWorkspace(project.repo_url, gitSha, projectId, (msg) => {
            void this.appendLog(attemptId, 'status', {
              message: msg, phase: 'workspace', timestamp: new Date().toISOString(),
            });
          });
        }
      }

      const result = await this.deployer.runJobService({
        projectId,
        envName: input.env_name,
        manifestYaml: manifest.manifest_yaml,
        serviceName: input.service,
        attemptId,
        releaseId: input.release_id ?? null,
        imageDigests,
        imageTag,
        timeoutSeconds,
        repoPath: workspace ?? undefined,
      });

      if (result.logs) {
        await this.appendLog(attemptId, 'output', {
          stream: 'job',
          text: result.logs,
          timestamp: new Date().toISOString(),
        });
      }

      if (!result.success) {
        throw new Error(`Job service ${input.service} failed`);
      }

      return {
        job_name: result.jobName,
        service: input.service,
        exit_code: result.exitCode,
      };
    } finally {
      if (workspace) {
        await this.cleanupWorkspace(workspace);
      }
    }
  }

  /**
   * Handle run action
   * Executes a command in the context of a project repository
   */
  private async handleRun(
    attemptId: string,
    jobId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const repoUrl = project.repo_url;
    if (!repoUrl) {
      throw new Error(`Project ${projectId} missing repo_url`);
    }

    // Determine which command to run
    let command = input.command;
    if (!command && input.command_ref) {
      // Look up command from manifest if command_ref is provided
      // For now, we'll require git_sha to be in the action_input or job hints
      throw new Error('command_ref not yet supported; provide command directly');
    }

    if (!command && input.service) {
      throw new Error(
        `Pipeline step uses "type: run" with "service: ${input.service}" but no "command". ` +
        `To run a service container, use "type: job" instead. ` +
        `Change your manifest to: action: { type: job, service: ${input.service} }`,
      );
    }

    if (!command) {
      throw new Error('Run action requires either command or command_ref');
    }

    // For run actions, we need a git SHA - this should be in the action_input
    const gitSha = input.git_sha;
    if (!gitSha) {
      throw new Error('Run action requires git_sha');
    }

    // Re-fetch the job row to read per-job token_permissions / token_scope
    // (the dispatcher only forwards project_id + input).
    const job = await this.jobs.findById(jobId);
    const timeoutSeconds = resolveRunTimeoutSeconds(input, job);
    const timeoutMs = timeoutSeconds * 1000;
    const envOverrides = ((job as { env_overrides?: Record<string, string> | null } | null)?.env_overrides) ?? null;
    const envOverrideSecretRefs = extractSecretRefs(envOverrides ?? {});
    const resolvedSecrets = await this.resolveSecretsForExecution(
      projectId,
      envOverrideSecretRefs.length > 0,
      this.repoMayNeedGitAuth(repoUrl),
    );

    await this.appendLog(attemptId, 'status', {
      message: `Preparing workspace for git_sha=${gitSha}`,
      timestamp: new Date().toISOString(),
    });

    const workspace = await this.prepareWorkspace(repoUrl, gitSha, projectId, (msg) => {
      void this.appendLog(attemptId, 'status', {
        message: msg, phase: 'workspace', timestamp: new Date().toISOString(),
      });
    }, resolvedSecrets);
    try {
      // Mint a job-scoped token and write a workspace-local ~/.eve/credentials.json
      // so `eve …` calls inside the command authenticate as the job, not as
      // whatever happens to be in the worker's process env.
      const tokenPermissions =
        Array.isArray((job as { token_permissions?: unknown } | null)?.token_permissions) &&
        (((job as { token_permissions?: string[] } | null)?.token_permissions?.length ?? 0) > 0)
          ? (job as { token_permissions: string[] }).token_permissions
          : [...DEFAULT_ACTION_RUN_JOB_PERMISSIONS];
      const tokenScope =
        ((job as { token_scope?: AccessBindingScope | null } | null)?.token_scope) ?? undefined;

      const runHome = join(workspace, '.eve-run-home');
      let jobToken: string | undefined;
      try {
        const minted = await mintJobToken(jobId, {
          permissions: tokenPermissions,
          scope: tokenScope,
        });
        jobToken = minted?.access_token;
      } catch (err) {
        this.logger.warn(
          `[action-run] Token mint failed for ${jobId}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (jobToken) {
        try {
          await this.writeRunCredentials(runHome, jobToken);
        } catch (err) {
          this.logger.warn(
            `[action-run] Failed to write credentials.json for ${jobId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      await this.appendLog(attemptId, 'status', {
        message: `Executing command: ${command}`,
        timestamp: new Date().toISOString(),
      });

      let env = this.buildRunEnv({
        jobId,
        projectId,
        attemptId,
        runHome,
        jobToken,
      });
      const toolchains = getJobToolchains(job);
      if (toolchains.length > 0) {
        const provisioned = await ensureToolchains({
          toolchains,
          baseEnv: env,
          logger: (event) => this.appendLog(attemptId, 'status', {
            message: formatToolchainEvent(event),
            timestamp: new Date().toISOString(),
            toolchain_event: event.type,
            toolchain: event.toolchain,
            image: event.image,
            root: event.root,
          }),
        });
        env = provisioned.env;
      }

      const overridesResult = await applyEnvOverrides({
        envOverrides,
        resolvedSecrets,
        baseEnv: env,
        onMissingSecrets: (missing) =>
          deliverProvisioningError(this.buildRelayDb(), {
            jobId,
            parentJobId: (job as { parent_id?: string | null } | null)?.parent_id ?? null,
            assignee: null,
            errorCode: 'missing_secret_override',
            message: `env_overrides reference unresolved secret(s): ${missing.join(', ')}`,
          }),
      });
      env = overridesResult.env;
      if (overridesResult.appliedKeys.length > 0) {
        await this.appendLog(attemptId, 'status', {
          message: `Applied env_overrides: ${overridesResult.appliedKeys.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
      }
      if (overridesResult.strippedKeys.length > 0) {
        await this.appendLog(attemptId, 'warning', {
          message: `Stripped reserved env_overrides: ${overridesResult.strippedKeys.join(', ')}`,
          timestamp: new Date().toISOString(),
          stripped_keys: overridesResult.strippedKeys,
        });
      }

      const result = await runStreamingCommand({
        command,
        cwd: workspace,
        env,
        attemptId,
        timeoutMs,
        timeoutCode: 'action_run_timeout',
        appendLog: (logAttemptId, type, content) => this.appendLog(logAttemptId, type, content),
      });

      if (!result.success) {
        const error = new Error(result.error ?? `Command failed with exit code ${result.exitCode}`) as Error & { code?: string | number };
        if (result.timedOut) {
          error.code = 'action_run_timeout';
        } else {
          error.code = result.exitCode;
        }
        throw error;
      }

      await this.appendLog(attemptId, 'output', {
        command,
        exit_code: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        timestamp: new Date().toISOString(),
      });

      return { command, exit_code: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    } catch (error) {
      if (isMissingSecretOverrideError(error)) {
        throw error;
      }

      const err = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };

      if (err.stdout) {
        await this.appendLog(attemptId, 'output', {
          stream: 'stdout',
          text: err.stdout,
          timestamp: new Date().toISOString(),
        });
      }

      if (err.stderr) {
        await this.appendLog(attemptId, 'output', {
          stream: 'stderr',
          text: err.stderr,
          timestamp: new Date().toISOString(),
        });
      }

      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const wrapped = new Error(`Command failed with exit code ${exitCode}: ${err.message || 'Unknown error'}`) as Error & { code?: string };
      if (typeof err.code === 'string') {
        wrapped.code = err.code;
        wrapped.message = err.message || wrapped.message;
      }
      throw wrapped;
    } finally {
      await this.cleanupWorkspace(workspace);
    }
  }

  private async handleCreatePr(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    const project = await this.projects.findById(projectId, { include_deleted: true });
    const repoSlug = resolveRepoSlug(input.repo, project?.repo_url ?? null);
    const head = input.head;
    const base = input.base ?? 'main';
    const title = input.title ?? `Remediation for ${projectId}`;
    const body = input.body ?? '';
    const draft = input.draft ?? false;
    const dryRun = input.dry_run ?? false;

    if (!head) {
      throw new Error('Create PR action requires head branch');
    }

    await this.appendLog(attemptId, 'status', {
      message: `Creating PR ${repoSlug} ${head} -> ${base}`,
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
    });

    if (dryRun) {
      return { repo: repoSlug, head, base, title, draft, dry_run: true };
    }

    const token = process.env.EVE_GITHUB_TOKEN;
    if (!token) {
      throw new Error('Create PR action requires EVE_GITHUB_TOKEN');
    }

    const response = await fetch(`https://api.github.com/repos/${repoSlug}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'User-Agent': 'eve-horizon',
      },
      body: JSON.stringify({
        title,
        head,
        base,
        body,
        draft,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`GitHub create PR failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { html_url?: string; number?: number; id?: number };

    await this.appendLog(attemptId, 'output', {
      pr_url: data.html_url ?? null,
      pr_number: data.number ?? null,
      pr_id: data.id ?? null,
      timestamp: new Date().toISOString(),
    });

    return {
      pr_url: data.html_url ?? null,
      pr_number: data.number ?? null,
      pr_id: data.id ?? null,
      repo: repoSlug,
      head,
      base,
      title,
      draft,
    };
  }

  /**
   * Handle env-ensure action
   * Idempotently creates an environment if it doesn't exist
   */
  private async handleEnvEnsure(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    if (!input.env_name) {
      throw new Error('Env-ensure action requires env_name');
    }

    const envName = input.env_name;
    const kind = input.kind ?? 'standard';
    const labels = input.labels ?? null;

    await this.appendLog(attemptId, 'status', {
      message: `Ensuring environment ${envName} exists`,
      timestamp: new Date().toISOString(),
    });

    // Check if environment already exists
    const existing = await this.envs.findByProjectAndName(projectId, envName);
    if (existing) {
      await this.appendLog(attemptId, 'output', {
        message: `Environment ${envName} already exists`,
        environment: {
          id: existing.id,
          name: existing.name,
          kind: existing.kind,
          labels: existing.labels_json,
        },
        created: false,
        timestamp: new Date().toISOString(),
      });

      return {
        environment: {
          id: existing.id,
          name: existing.name,
          kind: existing.kind,
          labels: existing.labels_json,
        },
        created: false,
      };
    }

    // Create the environment directly using database queries
    await this.appendLog(attemptId, 'status', {
      message: `Creating environment ${envName}`,
      timestamp: new Date().toISOString(),
    });

    const { generateEnvironmentId } = await import('@eve/shared');
    const environmentId = generateEnvironmentId();

    const created = await this.envs.create({
      id: environmentId,
      project_id: projectId,
      name: envName,
      type: 'persistent',
      kind,
      namespace: null,
      db_ref: null,
      overrides_json: null,
      labels_json: labels,
      current_release_id: null,
      last_failed_release_id: null,
      last_applied_release_id: null,
      last_deploy_failure_json: null,
    });

    await this.appendLog(attemptId, 'output', {
      message: `Created environment ${envName}`,
      environment: {
        id: created.id,
        name: created.name,
        kind: created.kind,
        labels: created.labels_json,
      },
      created: true,
      timestamp: new Date().toISOString(),
    });

    return {
      environment: {
        id: created.id,
        name: created.name,
        kind: created.kind,
        labels: created.labels_json,
      },
      created: true,
    };
  }

  /**
   * Handle env-delete action
   * Idempotently deletes an environment by name
   */
  private async handleEnvDelete(
    attemptId: string,
    projectId: string,
    input: ActionInput,
  ): Promise<Record<string, unknown>> {
    if (!input.env_name) {
      throw new Error('Env-delete action requires env_name');
    }

    const envName = input.env_name;

    await this.appendLog(attemptId, 'status', {
      message: `Deleting environment ${envName}`,
      timestamp: new Date().toISOString(),
    });

    // Check if environment exists
    const existing = await this.envs.findByProjectAndName(projectId, envName);
    if (!existing) {
      await this.appendLog(attemptId, 'output', {
        message: `Environment ${envName} not found (already deleted)`,
        env_name: envName,
        deleted: false,
        timestamp: new Date().toISOString(),
      });

      return {
        env_name: envName,
        deleted: false,
      };
    }

    // Delete K8s namespace if it exists
    try {
      await this.appendLog(attemptId, 'status', {
        message: `Deleting K8s namespace for environment ${envName}`,
        timestamp: new Date().toISOString(),
      });

      await this.deployer.deleteEnvironment(existing.id);

      await this.appendLog(attemptId, 'status', {
        message: `K8s namespace deleted for environment ${envName}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Log the error but continue with database deletion
      const message = error instanceof Error ? error.message : String(error);
      await this.appendLog(attemptId, 'status', {
        message: `Warning: K8s cleanup failed: ${message}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Delete the environment from database
    await this.appendLog(attemptId, 'status', {
      message: `Deleting environment record from database`,
      timestamp: new Date().toISOString(),
    });

    const deleted = await this.envs.delete(existing.id);
    if (!deleted) {
      throw new Error(`Failed to delete environment ${envName} from database`);
    }

    await this.appendLog(attemptId, 'output', {
      message: `Deleted environment ${envName}`,
      env_name: envName,
      deleted: true,
      timestamp: new Date().toISOString(),
    });

    return {
      env_name: envName,
      deleted: true,
    };
  }

  /**
   * Compute the preview URL for a deployment
   * Returns null if no public ingress is configured
   */
  private async computePreviewUrl(
    projectId: string,
    releaseId: string,
    envName: string,
  ): Promise<string | null> {
    // Get the project to access slug and repo
    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      return null;
    }

    // Get the release to access the manifest
    const release = await this.releases.findById(releaseId);
    if (!release) {
      return null;
    }

    // Get the manifest to check for ingress configuration
    const manifest = await this.manifests.findByProjectAndHash(projectId, release.manifest_hash);
    if (!manifest) {
      return null;
    }

    // Parse the manifest to find services with public ingress
    const parsed = yaml.parse(manifest.manifest_yaml);
    const services = parsed?.services as Record<string, any> | undefined;
    if (!services) {
      return null;
    }

    // Look for the first service with public ingress (usually 'web' or 'api')
    // Priority order: web > api > first service with ingress
    const serviceNames = ['web', 'api', ...Object.keys(services)];
    let publicService: string | null = null;

    for (const serviceName of serviceNames) {
      const service = services[serviceName];
      if (!service) continue;

      const xeve = service['x-eve'] ?? service.x_eve;
      if (!xeve || typeof xeve !== 'object') {
        // If no x-eve config, check if service has ports (default to public)
        if (service.ports && Array.isArray(service.ports) && service.ports.length > 0) {
          publicService = serviceName;
          break;
        }
        continue;
      }

      const ingress = xeve.ingress;
      if (ingress && typeof ingress === 'object') {
        const isPublic = ingress.public !== false; // Default to true if not specified
        if (isPublic) {
          publicService = serviceName;
          break;
        }
      } else if (service.ports && Array.isArray(service.ports) && service.ports.length > 0) {
        // Has ports but no explicit ingress config - default to public
        publicService = serviceName;
        break;
      }
    }

    if (!publicService) {
      return null;
    }

    // Get the domain from config
    const { loadConfig } = await import('@eve/shared');
    const config = loadConfig();
    const domain = config.EVE_DEFAULT_DOMAIN;
    if (!domain || typeof domain !== 'string' || domain.length === 0) {
      return null;
    }

    // Compute the URL using the same pattern as the deployer
    // URL pattern: {component}.{orgSlug}-{project}-{env}.{domain}
    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      return null;
    }
    const orgSlug = toK8sName(org.slug, 'org');
    const componentSlug = toK8sName(publicService, 'component');
    const projectSlug = toK8sName(project.slug, 'project');
    const envSlug = toK8sName(envName, 'environment');
    const host = `${componentSlug}.${orgSlug}-${projectSlug}-${envSlug}.${domain}`;

    return `https://${host}`;
  }

  private async resolveActionInput(
    job: NonNullable<Awaited<ReturnType<typeof this.jobs.findById>>>,
    input: ActionInput,
    actionType: string,
  ): Promise<ActionInput> {
    const merged: ActionInput = { ...input };

    const runId = job.run_id ?? null;
    const stepName = job.step_name ?? null;
    const hints = (job.hints ?? {}) as Record<string, unknown>;
    const run = runId ? await this.runs.findRunById(runId) : null;

    if (!merged.git_sha) {
      merged.git_sha = typeof hints.git_sha === 'string' ? hints.git_sha : run?.git_sha ?? undefined;
    }

    if (!merged.manifest_hash) {
      merged.manifest_hash = run?.manifest_hash ?? undefined;
    }

    if (!merged.env_name) {
      merged.env_name = job.env_name ?? run?.env_name ?? undefined;
    }

    if (!merged.release_id && (actionType === 'deploy' || actionType === 'job')) {
      // Priority order for release_id:
      // 1. Action config (already in merged.release_id from input)
      // 2. Pipeline run inputs
      // 3. Step outputs from dependencies
      // 4. Step outputs from any step (fallback)

      // Check pipeline run inputs
      if (run?.inputs_json && typeof run.inputs_json.release_id === 'string') {
        merged.release_id = run.inputs_json.release_id;
      }

      // Check step outputs from dependencies
      if (!merged.release_id) {
        const releaseFromDeps = await this.findReleaseIdFromDependencies(job.id, run);
        if (releaseFromDeps) {
          merged.release_id = releaseFromDeps;
        }
      }

      // Check step outputs from any step (fallback)
      if (!merged.release_id && run?.step_outputs_json) {
        const fallbackRelease = this.findReleaseIdInOutputs(run.step_outputs_json);
        if (fallbackRelease) {
          merged.release_id = fallbackRelease;
        }
      }
    }

    if (!merged.build_id && actionType === 'release') {
      const buildFromDeps = await this.findBuildIdFromDependencies(job.id, run);
      if (buildFromDeps) {
        merged.build_id = buildFromDeps;
      }
      if (!merged.build_id && run?.step_outputs_json) {
        const fallbackBuild = this.findBuildIdInOutputs(run.step_outputs_json);
        if (fallbackBuild) {
          merged.build_id = fallbackBuild;
        }
      }
    }

    // Resolve image_digests from dependency outputs for release actions
    if (!merged.image_digests && actionType === 'release') {
      const digestsFromDeps = await this.findImageDigestsFromDependencies(job.id, run);
      if (digestsFromDeps) {
        merged.image_digests = digestsFromDeps;
      }
    }

    return merged;
  }

  private async findReleaseIdFromDependencies(
    jobId: string,
    run: Awaited<ReturnType<typeof this.runs.findRunById>> | null,
  ): Promise<string | null> {
    if (!run?.step_outputs_json) {
      return null;
    }

    const deps = await this.db<{ step_name: string | null }[]>`
      SELECT j.step_name
      FROM job_relations r
      JOIN jobs j ON j.id = r.related_job_id
      WHERE r.job_id = ${jobId}
        AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
    `;

    for (const dep of deps) {
      if (!dep.step_name) continue;
      const output = run.step_outputs_json[dep.step_name] as Record<string, unknown> | undefined;
      if (output && typeof output.release_id === 'string') {
        return output.release_id;
      }
    }

    return null;
  }

  private findReleaseIdInOutputs(outputs: Record<string, unknown>): string | null {
    for (const value of Object.values(outputs)) {
      if (!value || typeof value !== 'object') continue;
      const output = value as Record<string, unknown>;
      if (typeof output.release_id === 'string') {
        return output.release_id;
      }
    }
    return null;
  }

  private async findBuildIdFromDependencies(
    jobId: string,
    run: Awaited<ReturnType<typeof this.runs.findRunById>> | null,
  ): Promise<string | null> {
    if (!run?.step_outputs_json) {
      return null;
    }

    const deps = await this.db<{ step_name: string | null }[]>`
      SELECT j.step_name
      FROM job_relations r
      JOIN jobs j ON j.id = r.related_job_id
      WHERE r.job_id = ${jobId}
        AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
    `;

    for (const dep of deps) {
      if (!dep.step_name) continue;
      const output = run.step_outputs_json[dep.step_name] as Record<string, unknown> | undefined;
      if (output && typeof output.build_id === 'string') {
        return output.build_id;
      }
    }

    return null;
  }

  private findBuildIdInOutputs(outputs: Record<string, unknown>): string | null {
    for (const value of Object.values(outputs)) {
      if (!value || typeof value !== 'object') continue;
      const output = value as Record<string, unknown>;
      if (typeof output.build_id === 'string') {
        return output.build_id;
      }
    }
    return null;
  }

  private async findImageDigestsFromDependencies(
    jobId: string,
    run: Awaited<ReturnType<typeof this.runs.findRunById>> | null,
  ): Promise<Record<string, string> | null> {
    if (!run?.step_outputs_json) {
      return null;
    }

    const deps = await this.db<{ step_name: string | null }[]>`
      SELECT j.step_name
      FROM job_relations r
      JOIN jobs j ON j.id = r.related_job_id
      WHERE r.job_id = ${jobId}
        AND r.relation_type IN ('blocks', 'conditional_blocks', 'waits_for')
    `;

    for (const dep of deps) {
      if (!dep.step_name) continue;
      const output = run.step_outputs_json[dep.step_name] as Record<string, unknown> | undefined;
      if (output?.image_digests && typeof output.image_digests === 'object') {
        return output.image_digests as Record<string, string>;
      }
    }

    // Fallback: scan all step outputs
    for (const value of Object.values(run.step_outputs_json)) {
      if (value && typeof value === 'object' && 'image_digests' in value) {
        const digests = (value as Record<string, unknown>).image_digests;
        if (digests && typeof digests === 'object') {
          return digests as Record<string, string>;
        }
      }
    }

    return null;
  }

  /**
   * Handle notify action
   * Sends a notification to the specified channel
   */
  private async handleNotify(attemptId: string, projectId: string, input: ActionInput): Promise<void> {
    const channel = input.channel ?? 'default';
    const message = input.message ?? 'Notification from Eve Horizon';

    await this.appendLog(attemptId, 'status', {
      message: `Sending notification to channel: ${channel}`,
      timestamp: new Date().toISOString(),
    });

    // Simulate notification - in real implementation, this would call notification service
    await this.appendLog(attemptId, 'output', {
      channel,
      message,
      notification_sent: true,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Wait for deployment to become ready
   */
  private async waitForDeployReady(envId: string, timeoutSeconds: number, attemptId: string) {
    const start = Date.now();
    let lastStatus = await this.deployer.getDeploymentStatus(envId);

    while (!lastStatus.k8sStatus?.ready && Date.now() - start < timeoutSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      lastStatus = await this.deployer.getDeploymentStatus(envId);
      await this.appendLog(attemptId, 'status', {
        message: `Deployment status: ${lastStatus.k8sStatus?.availableReplicas ?? 0}/${
          lastStatus.k8sStatus?.desiredReplicas ?? 0
        } ready`,
        timestamp: new Date().toISOString(),
      });
    }

    if (!lastStatus.k8sStatus?.ready) {
      const message = `Deployment did not become ready within ${timeoutSeconds}s`;
      const environment = await this.envs.findById(envId);
      let snapshot: Awaited<ReturnType<DeployerService['collectClusterSnapshot']>> | undefined;
      let failure: ReturnType<typeof classifyFromSnapshot> = null;

      if (environment && lastStatus.namespace) {
        try {
          snapshot = await this.deployer.collectClusterSnapshot({
            namespace: lastStatus.namespace,
            projectId: environment.project_id,
            envName: environment.name,
          });
          failure = classifyFromSnapshot(snapshot);
        } catch (snapshotError) {
          this.logger.warn(
            `Failed to collect cluster snapshot after deploy readiness timeout: ${
              snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
            }`,
          );
        }
      }

      throw new DeployFailureError(
        failure ?? {
          kind: 'readiness_timeout',
          notReady: snapshot?.pods.filter((pod) => !pod.ready).map((pod) => pod.name) ?? [],
          message,
        },
        snapshot,
        { cause: new Error(message), manifestApplied: true },
      );
    }

    await this.appendLog(attemptId, 'status', {
      message: 'Deployment ready',
      timestamp: new Date().toISOString(),
    });

    return lastStatus;
  }

  /**
   * Prepare a workspace by cloning the repository at a specific commit
   */
  private async prepareWorkspace(
    repoUrl: string,
    gitSha: string,
    projectId?: string,
    onLog?: (message: string) => void,
    resolvedSecrets?: SecretResolveItem[],
  ): Promise<string> {
    const cloneUrl = projectId ? await this.injectGitAuth(repoUrl, projectId, resolvedSecrets) : repoUrl;

    const workspace = await fs.mkdtemp(join(tmpdir(), 'eve-action-'));
    const safeUrl = cloneUrl.replace(/\/\/[^@]+@/, '//***@');
    this.logger.log(`prepareWorkspace: cloning ${safeUrl} → ${workspace}`);
    onLog?.(`Cloning ${safeUrl}...`);

    try {
      await execFileAsync('git', ['clone', '--no-checkout', cloneUrl, workspace], {
        env: process.env,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Authentication') || errMsg.includes('could not read Username') || errMsg.includes('fatal: repository')) {
        throw new Error(
          `Git clone failed (authentication): ${errMsg}. ` +
          `Check that GITHUB_TOKEN is set for this project via 'eve secrets set'.`
        );
      }
      throw new Error(`Git clone failed for ${safeUrl}: ${errMsg}`);
    }

    onLog?.(`Checking out ${gitSha.substring(0, 8)}...`);
    await execFileAsync('git', ['checkout', gitSha], {
      cwd: workspace,
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    onLog?.('Workspace ready');
    return workspace;
  }

  /**
   * Resolve GITHUB_TOKEN and embed it into an HTTPS clone URL for private repos.
   */
  private repoMayNeedGitAuth(repoUrl: string): boolean {
    return repoUrl.startsWith('http');
  }

  private async resolveSecretsForExecution(
    projectId: string,
    requiredForEnvOverrides: boolean,
    neededForGitAuth: boolean,
  ): Promise<SecretResolveItem[]> {
    if (!requiredForEnvOverrides && !neededForGitAuth) {
      return [];
    }

    const result = await resolveProjectSecrets(projectId);
    if (!result.resolved) {
      if (requiredForEnvOverrides) {
        throw new Error(`Secret resolution failed for env_overrides: ${result.error ?? 'unknown error'}`);
      }
      this.logger.error(
        `Cannot resolve secrets for git auth: ${result.error}. ` +
        `Clone will proceed without authentication.`,
      );
      return [];
    }

    return result.secrets;
  }

  private async injectGitAuth(
    repoUrl: string,
    projectId: string,
    resolvedSecrets?: SecretResolveItem[],
  ): Promise<string> {
    if (!repoUrl.startsWith('http')) return repoUrl;
    try {
      const secrets = resolvedSecrets ?? (await this.resolveSecretsForExecution(projectId, false, true));

      const token =
        secrets.find((s) => s.type === 'github_token') ??
        secrets.find((s) => ['GITHUB_TOKEN', 'GH_TOKEN'].includes(s.key));

      if (!token) {
        try {
          const url = new URL(repoUrl);
          if (url.hostname.includes('github.com')) {
            this.logger.warn(
              `No GITHUB_TOKEN found for project ${projectId}. ` +
              `If ${repoUrl} is private, clone will fail. ` +
              `Set GITHUB_TOKEN via: eve secrets set GITHUB_TOKEN <value> --project <id>`
            );
          }
        } catch { /* invalid URL — not a github URL */ }
        return repoUrl;
      }

      return buildAuthenticatedHttpsUrl(repoUrl, token.value);
    } catch (err) {
      this.logger.warn(`Git auth injection failed: ${err instanceof Error ? err.message : err}`);
    }
    return repoUrl;
  }

  private async computeNextVersion(workspace: string, gitSha: string): Promise<{ version: string; tag: string }> {
    const lastTag = await this.getLastTag(workspace, gitSha);
    const baseVersion = this.parseSemver(lastTag);

    const range = lastTag ? `${lastTag}..${gitSha}` : gitSha;
    const commitsRaw = await this.gitLog(workspace, range);
    const bump = this.determineBump(commitsRaw);

    const nextVersion = this.bumpVersion(baseVersion, bump);
    const version = nextVersion ?? '0.1.0';
    return { version, tag: `v${version}` };
  }

  private async getLastTag(workspace: string, gitSha: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['describe', '--tags', '--abbrev=0', gitSha], {
        cwd: workspace,
        env: process.env,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async gitLog(workspace: string, range: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--no-merges', '--pretty=format:%s%n%b%n----END----', range],
      {
        cwd: workspace,
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.split('----END----').map((entry) => entry.trim()).filter(Boolean);
  }

  private determineBump(commits: string[]): 'major' | 'minor' | 'patch' {
    let hasMinor = false;
    let hasPatch = false;

    for (const entry of commits) {
      const lines = entry.split('\n');
      const header = lines[0]?.trim() ?? '';
      const body = lines.slice(1).join('\n');

      if (/BREAKING CHANGE/i.test(body) || /^[a-zA-Z]+(\(.+\))?!:/.test(header)) {
        return 'major';
      }

      if (/^feat(\(.+\))?:/.test(header)) {
        hasMinor = true;
      }

      if (/^(fix|perf)(\(.+\))?:/.test(header)) {
        hasPatch = true;
      }
    }

    if (hasMinor) return 'minor';
    if (hasPatch) return 'patch';
    return 'patch';
  }

  private parseSemver(tag: string | null): { major: number; minor: number; patch: number } | null {
    if (!tag) return null;
    const normalized = tag.startsWith('v') ? tag.slice(1) : tag;
    const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
    };
  }

  private bumpVersion(
    base: { major: number; minor: number; patch: number } | null,
    bump: 'major' | 'minor' | 'patch',
  ): string | null {
    if (!base) return null;
    if (bump === 'major') return `${base.major + 1}.0.0`;
    if (bump === 'minor') return `${base.major}.${base.minor + 1}.0`;
    return `${base.major}.${base.minor}.${base.patch + 1}`;
  }

  /**
   * Clean up a workspace directory
   */
  private async cleanupWorkspace(workspace: string): Promise<void> {
    try {
      await fs.rm(workspace, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Write the Eve CLI credential file used by `action: { type: run }` steps.
   */
  private async writeRunCredentials(runHome: string, jobToken: string): Promise<void> {
    const config = loadConfig();
    if (!config.EVE_API_URL) return;
    const authKey = config.EVE_API_URL.trim().replace(/\/+$/, '');
    const payload = {
      tokens: {
        [authKey]: {
          access_token: jobToken,
          token_type: 'bearer' as const,
          expires_at: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
        },
      },
    };
    const eveDir = join(runHome, '.eve');
    await fs.mkdir(eveDir, { recursive: true });
    await fs.writeFile(join(eveDir, 'credentials.json'), JSON.stringify(payload, null, 2));
  }

  /**
   * Build a sanitised environment for the bash command launched by
   * `action: { type: run }`. Excludes `EVE_INTERNAL_API_KEY` and other worker
   * secrets that have no business in user-supplied shell.
   */
  private buildRunEnv(params: {
    jobId: string;
    projectId: string;
    attemptId: string;
    runHome: string;
    jobToken?: string;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: params.runHome,
      TERM: process.env.TERM,
      LANG: process.env.LANG,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      EVE_JOB_ID: params.jobId,
      EVE_PROJECT_ID: params.projectId,
      EVE_ATTEMPT_ID: params.attemptId,
    };
    if (process.env.EVE_API_URL) env.EVE_API_URL = process.env.EVE_API_URL;
    if (process.env.EVE_PUBLIC_API_URL) env.EVE_PUBLIC_API_URL = process.env.EVE_PUBLIC_API_URL;
    if (params.jobToken) env.EVE_JOB_TOKEN = params.jobToken;
    return env;
  }

  /**
   * Append a log entry
   */
  private async appendLog(attemptId: string, type: string, content: Record<string, unknown>): Promise<void> {
    await this.logs.appendLog(attemptId, type, content);
  }

  /**
   * Convert a value to a valid K8s name (lowercase, alphanumeric + hyphens, max 63 chars)
   */
  /**
   * Auto-sync manifest from cloned workspace during build.
   *
   * Reads .eve/manifest.yaml from the workspace and compares its hash with
   * the pipeline run's inherited `manifest_hash`. When they match, there is
   * no drift and the step continues. When they differ the step fails with
   * `manifest_invalid` — this catches:
   *
   * 1. Pipeline runs created against a ref that was never synced (stale
   *    `findLatestByProject` result in the API).
   * 2. Force-pushed branches where the API resolved one SHA and the worker
   *    clone saw a different manifest at the same ref.
   *
   * In either case the right user-facing action is to run
   * `eve project sync --ref <sha>` (or push the manifest to that ref) and
   * retry, not to silently deploy the stale manifest.
   */
  private async autoSyncManifestFromWorkspace(
    workspace: string,
    projectId: string,
    gitSha: string,
    currentManifestHash: string,
    attemptId: string,
  ): Promise<void> {
    const manifestPath = join(workspace, '.eve', 'manifest.yaml');
    let rawManifestYaml: string;
    try {
      rawManifestYaml = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      // No manifest in workspace — nothing to sync
      return;
    }

    let manifestYaml: string;
    try {
      manifestYaml = expandManifestReferences(rawManifestYaml, {
        repoRoot: workspace,
        manifestPath,
      }).yaml;
    } catch (error) {
      const message =
        `Manifest drift check failed for ref ${gitSha.slice(0, 7)}: ` +
        `workspace manifest references could not be expanded. ` +
        `${error instanceof Error ? error.message : String(error)}`;

      await this.appendLog(attemptId, 'error', {
        message,
        timestamp: new Date().toISOString(),
        error_class: 'ManifestInvalid',
        error_context: {
          kind: 'manifest_invalid',
          git_sha: gitSha,
          pipeline_manifest_hash: currentManifestHash,
        },
      });

      throw new Error(message);
    }

    const newHash = crypto.createHash('sha256').update(manifestYaml).digest('hex');
    if (newHash === currentManifestHash) {
      return; // Manifest matches the pipeline run's frozen manifest_hash
    }

    // Drift detected. Ensure the workspace-observed manifest is persisted so
    // the user can act on it (project sync + retry), then fail the step.
    try {
      yaml.parse(manifestYaml);
      const existing = await this.manifests.findByProjectAndHash(projectId, newHash);
      if (existing) {
        await this.manifests.touch(existing.id);
      } else {
        const id = generateManifestId();
        await this.manifests.create({
          id,
          project_id: projectId,
          manifest_yaml: manifestYaml,
          manifest_hash: newHash,
          git_sha: gitSha,
          branch: null,
          parsed_defaults: null,
          parsed_agents: null,
        });
      }
    } catch {
      // Workspace manifest is not valid YAML — fall through to the drift error.
    }

    const message =
      `Manifest drift detected for ref ${gitSha.slice(0, 7)}: ` +
      `pipeline run was created with manifest ${currentManifestHash.slice(0, 8)} but ` +
      `workspace resolves to ${newHash.slice(0, 8)}. ` +
      `Run \`eve project sync --ref ${gitSha}\` from a checkout of that ref and retry the deploy.`;

    await this.appendLog(attemptId, 'error', {
      message,
      timestamp: new Date().toISOString(),
      error_class: 'ManifestDrift',
      error_context: {
        kind: 'manifest_invalid',
        git_sha: gitSha,
        pipeline_manifest_hash: currentManifestHash,
        workspace_manifest_hash: newHash,
      },
    });

    throw new Error(message);
  }

}

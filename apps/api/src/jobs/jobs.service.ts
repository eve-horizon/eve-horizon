import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, ForbiddenException, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Db } from '@eve/db';
import { jobQueries, projectQueries, executionLogQueries, gateQueries, projectManifestQueries, threadMessageQueries, environmentQueries, agentQueries, projectApiSourceQueries, orgQueries, agentConfigQueries, appLinkSubscriptionQueries, findJobAgent, ReviewDecidedError, type Job, type JobAttempt, type JobHints, type AttemptResultData, type JobWorkspaceConfig, type JobAttemptGitMeta } from '@eve/db';
import type { AccessBindingScope, JobGit, JobWorkspace, JobHarnessOptions, JobCompareResponse, JobTarget, ResourceRef, CreateBatchRequest, CreateBatchResponse, BatchValidateResponse, InlineProfileBundle } from '@eve/shared';
import { AccessBindingScopeSchema, agentSecretsAllowlist, boundSecretKeys, hasUserActor, isSameActor, narrowSecretsAllowlist, storedActor, deriveNamespace, parseResourceUri, defaultMountPathForUri, isValidMountPath, renderLogText, buildAppApiInstructionBlock, getServicesFromManifest, resolveHarnessProfile as sharedResolveHarnessProfile, type AppApiCliInfo, type AppApiInfo, type HarnessProfileSource } from '@eve/shared';
import * as yaml from 'yaml';
import { buildApiError } from '../system/api-errors.js';
import { JobLogsService } from './job-logs.service.js';
import { JobReceiptsService } from './job-receipts.service.js';
import { JobBatchService } from './job-batch.service.js';
import { assertCanGrantJobPermissions, judgeJobScope, workStartOptions, type WorkStartOptions } from '../auth/token-scope.js';
import { AccessService } from '../auth/access.service.js';
import { RbacService, SECRETS_USE_RULE } from '../auth/rbac.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { SecurityService } from '../security/security.service.js';
import { holdReservedEnvOverrides } from '../security/reserved-env.js';
import { inReadScope, JOB_TOKEN_READ_SCOPE_RULE } from './job-token-read-scope.js';
import { APPROVE_TOKEN_RULE, DEPENDENCY_CHANGE_RULE, RUN_STEP_CHANGE_RULE, deciderOf, howToChangeRun, isUserToken, runKind, runOfRecord, type RunRef } from './run-steps.js';

// ============================================================================
// Request/Response Types (inline - the new model)
// ============================================================================

export interface CreateJobRequest {
  description: string;                               // required: the work prompt
  title?: string;                                    // optional: defaults to first 64 chars of description
  issue_type?: string;
  labels?: string[];
  phase?: Job['phase'];                              // defaults to 'ready' (schedulable immediately)
  priority?: number;
  assignee?: string | null;
  review_required?: Job['review_required'];
  parent_id?: string | null;
  defer_until?: string | null;
  due_at?: string | null;
  harness?: string;                                  // preferred harness name
  harness_profile?: string;                          // orchestration profile name
  harness_options?: JobHarnessOptions;               // harness options (variant, model, reasoning)
  harness_profile_override?: InlineProfileBundle;    // inline per-job harness override (wins over harness_profile)
  env_overrides?: Record<string, string>;            // per-job env overrides with ${secret.KEY} placeholders
  token_scope?: AccessBindingScope | null;           // optional per-job token resource scope
  token_permissions?: string[] | null;               // optional per-job token permission list (null = executor default)
  hints?: JobHints;                                  // scheduling hints (worker_type, etc.)
  git?: JobGit;                                      // git controls (ref, branch, commit/push policies)
  workspace?: JobWorkspace;                          // workspace configuration (mode, key)
  env_name?: string | null;                          // target environment name
  execution_mode?: 'persistent' | 'ephemeral';      // execution strategy
  target?: JobTarget;                                // intent-level routing
  resource_refs?: ResourceRef[];                     // references to attachments or org docs
}

export interface UpdateJobRequest {
  title?: string;
  description?: string | null;
  labels?: string[];
  phase?: Job['phase'];
  priority?: number;
  assignee?: string | null;
  review_required?: Job['review_required'];
  defer_until?: string | null;
  due_at?: string | null;
  close_reason?: string | null;
  harness?: string | null;
  harness_profile?: string | null;
  harness_options?: JobHarnessOptions | null;
  hints?: JobHints;                                  // scheduling hints (worker_type, etc.)
  git?: JobGit;                                      // git controls (ref, branch, commit/push policies)
  workspace?: JobWorkspace;                          // workspace configuration (mode, key)
  env_name?: string | null;                          // target environment name
  execution_mode?: 'persistent' | 'ephemeral';      // execution strategy
}

/** Two secrets allowlists name the same keys (null: none declared). */
function sameSecretsAllowlist(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().every((key, i) => key === [...b].sort()[i]);
}

export interface JobResponse extends Omit<Job, 'created_at' | 'updated_at' | 'defer_until' | 'due_at' | 'ready_at' | 'closed_at' | 'git_json' | 'resolved_git_json' | 'workspace_json' | 'target' | 'resource_refs' | 'user_secrets_excluded'> {
  created_at: string;
  updated_at: string;
  defer_until: string | null;
  due_at: string | null;
  ready_at: string | null;
  closed_at: string | null;
  env_name: string | null;
  execution_mode: 'persistent' | 'ephemeral';
  git: JobGit | null;
  resolved_git?: JobAttemptGitMeta;
  workspace: JobWorkspace | null;
  harness: string | null;
  harness_profile: string | null;
  harness_options: JobHarnessOptions | null;
  target: JobTarget | null;
  resource_refs: ResourceRef[];
}

export interface JobListResponse {
  jobs: JobResponse[];
  total?: number;
}

export interface JobTreeNode extends JobResponse {
  children?: JobTreeNode[];
}

export interface JobAttemptContext {
  id: string;
  attempt_number: number;
  status: JobAttempt['status'];
  result_summary: string | null;
  result_json: Record<string, unknown> | null;
  git?: JobAttemptGitMeta;
}

export interface JobAttemptResponse extends Omit<JobAttempt, 'started_at' | 'execution_started_at' | 'ended_at' | 'git_json'> {
  started_at: string;
  execution_started_at: string | null;
  ended_at: string | null;
  git?: {
    resolved_ref?: string;
    resolved_sha?: string;
    resolved_branch?: string;
    ref_source?: 'env_release' | 'manifest' | 'project_default' | 'explicit';
    pushed?: boolean;
    commits?: string[];
  };
}

export interface ClaimRequest {
  agent_id: string;
  harness?: string;
}

export interface ReleaseRequest {
  agent_id: string;
  reason?: string;
}

export interface SubmitRequest {
  summary: string;
  agent_id?: string;
}

export interface ApproveRequest {
  /** Ignored: the decider is the authenticated caller. */
  reviewer_id?: string;
  comment?: string;
  /** The attempt the decider reviewed: refused (409) once the job is in review on a later one. */
  attempt_id?: string;
}

export interface RejectRequest {
  /** Ignored: the decider is the authenticated caller. */
  reviewer_id?: string;
  reason: string;
  /** The attempt the decider reviewed: refused (409) once the job is in review on a later one. */
  attempt_id?: string;
}

export interface AddDependencyRequest {
  related_job_id: string;
  relation_type?: string;
}

export interface DependenciesResponse {
  dependencies: Array<JobResponse & { relation_type: string }>;
  dependents: Array<JobResponse & { relation_type: string }>;
  blocking: Array<JobResponse & { relation_type: string }>;
}

export interface JobResultResponse {
  jobId?: string;
  attemptId?: string;
  attemptNumber?: number;
  status?: string;
  exitCode?: number | null;
  resultText?: string | null;
  resultJson?: Record<string, unknown> | null;
  durationMs?: number | null;
  tokenUsage?: {
    input: number | null;
    output: number | null;
  } | null;
  errorMessage?: string | null;
  git?: JobAttemptGitMeta;
}

export interface SiblingInfo {
  id: string;
  title: string;
  phase: string;
  assignee: string | null;
  effective_phase: string;
  result_summary: string | null;
}

export interface JobContextResponse {
  job: JobResponse;
  parent: JobResponse | null;
  children: JobResponse[];
  siblings?: SiblingInfo[];
  relations: DependenciesResponse;
  latest_attempt: JobAttemptContext | null;
  latest_rejection_reason: string | null;
  blocked: boolean;
  waiting: boolean;
  effective_phase: string;
  dispatch_thread_id?: string | null;
  dispatch_mode?: string | null;
}

export type WaitForJobResponse =
  | {
      completed: true;
      result: JobResultResponse;
    }
  | {
      completed: false;
      jobId: string;
      status: 'timeout';
      phase: string;
      elapsed: number;
      message: string;
    };

// ============================================================================
// Service
// ============================================================================

/**
 * Update fields that change what a job runs or how (anything but cosmetic ones).
 * The title opens the agent's prompt, and the `chat` label sends the run's
 * output to the thread its hints name.
 */
const EXECUTION_FIELDS = [
  'title',
  'description',
  'labels',
  'assignee',
  'harness',
  'harness_profile',
  'harness_options',
  'hints',
  'git',
  'workspace',
  'env_name',
  'execution_mode',
  'defer_until',
] as const satisfies ReadonlyArray<keyof UpdateJobRequest>;

/** True when an update changes what the job runs or releases it to run. */
function changesWhatRuns(job: Job, updates: UpdateJobRequest): boolean {
  if (EXECUTION_FIELDS.some((field) => updates[field] !== undefined)) {
    return true;
  }
  return Boolean(
    updates.phase
    && updates.phase !== job.phase
    && (updates.phase === 'ready' || updates.phase === 'active'),
  );
}

/** How much review a setting asks for: none, then an agent's, then a person's. */
const REVIEW_RANK: Record<Job['review_required'], number> = { none: 0, agent: 1, human: 2 };

/** True when an update asks for less review than the job needs now, in any phase. */
function lowersReview(job: Job, updates: UpdateJobRequest): boolean {
  return updates.review_required !== undefined
    && REVIEW_RANK[updates.review_required] < REVIEW_RANK[job.review_required];
}

/**
 * The review decision an update makes without the approve and reject routes,
 * or null. Moving a job out of review settles it: to done approves, back to
 * active rejects, to cancelled cancels. Lowering review_required in any
 * phase, or changing it while in review, approves.
 */
function reviewDecision(job: Job, updates: UpdateJobRequest): 'approve' | 'reject' | 'cancel' | null {
  if (job.phase === 'review' && updates.phase && updates.phase !== 'review') {
    if (updates.phase === 'done') return 'approve';
    return updates.phase === 'cancelled' ? 'cancel' : 'reject';
  }
  if (lowersReview(job, updates)) return 'approve';
  if (job.phase === 'review' && updates.review_required !== undefined && updates.review_required !== job.review_required) {
    return 'approve';
  }
  return null;
}

/** True when an update moves the job to another phase or changes whether it needs review. */
function changesProgress(job: Job, updates: UpdateJobRequest): boolean {
  return Boolean(
    (updates.phase && updates.phase !== job.phase)
    || (updates.review_required !== undefined && updates.review_required !== job.review_required),
  );
}

/** A failed review decision as an HTTP error: 409 when the review was already decided, 400 otherwise. */
/**
 * The round a review decision is for, when the decider names the attempt
 * they reviewed: the decision is refused once the job is in review on a
 * later attempt. Nothing when they name none (older callers).
 */
function reviewedRound(data: { attempt_id?: unknown }): [] | [{ attemptId: string }] {
  if (data.attempt_id === undefined || data.attempt_id === null) return [];
  if (typeof data.attempt_id !== 'string' || data.attempt_id.length === 0) {
    throw new BadRequestException('attempt_id must be the id of the attempt you reviewed');
  }
  return [{ attemptId: data.attempt_id }];
}

function reviewDecisionError(error: unknown): Error {
  if (error instanceof ReviewDecidedError) {
    return new ConflictException(`${error.message}; read the job again`);
  }
  return new BadRequestException(error instanceof Error ? error.message : String(error));
}

@Injectable()
export class JobsService {
  private jobs: ReturnType<typeof jobQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private logs: ReturnType<typeof executionLogQueries>;
  private gates: ReturnType<typeof gateQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private threadMessages: ReturnType<typeof threadMessageQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private apiSources: ReturnType<typeof projectApiSourceQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly jobLogsService: JobLogsService,
    private readonly jobReceiptsService: JobReceiptsService,
    private readonly jobBatchService: JobBatchService,
    private readonly accessService: AccessService,
    @Inject(SecurityService) private readonly security?: SecurityService,
    @Inject(RbacService) private readonly rbac?: RbacService,
  ) {
    this.jobs = jobQueries(db);
    this.projects = projectQueries(db);
    this.logs = executionLogQueries(db);
    this.gates = gateQueries(db);
    this.manifests = projectManifestQueries(db);
    this.threadMessages = threadMessageQueries(db);
    this.environments = environmentQueries(db);
    this.agents = agentQueries(db);
    this.apiSources = projectApiSourceQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
    this.orgs = orgQueries(db);
    this.agentConfigs = agentConfigQueries(db);
  }

  /**
   * Resolve project slug/ID and convert errors to NotFoundException
   */
  private async resolveProject(projectId: string): Promise<string> {
    try {
      return await this.jobs.resolveProjectSlug(projectId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Project not found')) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  /**
   * Load a job named in a request body (a parent or a dependency) and require it
   * to belong to `projectId`. Jobs are only ever linked within one project.
   */
  private async requireJobInProject(jobId: string, projectId: string): Promise<Job> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (job.project_id !== projectId) {
      throw new ForbiddenException(`Job ${jobId} is not in this project`);
    }
    return job;
  }

  private validateResourceRefs(resourceRefs: ResourceRef[], requestId?: string): void {
    const mountPaths = new Map<string, string>();

    for (const ref of resourceRefs) {
      const parsed = parseResourceUri(ref.uri);
      if (!parsed) {
        throw buildApiError(400, 'resource_uri_invalid', `Invalid resource URI: ${ref.uri}`, {
          requestId,
          details: { uri: ref.uri },
        });
      }

      const mountPath = ref.mount_path ?? defaultMountPathForUri(parsed);
      if (!isValidMountPath(mountPath)) {
        throw buildApiError(400, 'resource_uri_invalid', `Invalid mount_path: ${mountPath}`, {
          requestId,
          details: { mount_path: mountPath },
        });
      }

      const existing = mountPaths.get(mountPath);
      if (existing) {
        throw buildApiError(400, 'resource_mount_conflict', `Duplicate mount_path: ${mountPath}`, {
          requestId,
          details: { mount_path: mountPath, first_uri: existing, second_uri: ref.uri },
        });
      }

      mountPaths.set(mountPath, ref.uri);
    }
  }

  /**
   * If hints.app_apis contains API names, validate they exist for the project
   * and append an instruction block to the description so the agent knows how
   * to call them at runtime.
   */
  private async resolveAppApis(
    projectId: string,
    description: string,
    hints?: JobHints,
    envName?: string | null,
  ): Promise<{ description: string; hints?: JobHints }> {
    const apiNames = hints?.app_apis as string[] | undefined;
    const linkNames = hints?.app_links as string[] | undefined;
    if (!apiNames?.length && !linkNames?.length) return { description };

    let resolvedApis: AppApiInfo[] = [];
    if (apiNames?.length) {
    // Look up available APIs for this project (env-scoped first, then unscoped)
    const sources = await this.apiSources.list({
      project_id: projectId,
      env_name: envName ?? undefined,
    });
    // Also fetch unscoped APIs if env was specified (they're available to all envs)
    const unscopedSources = envName
      ? await this.apiSources.list({ project_id: projectId, env_name: null })
      : [];
    const allSources = [...sources, ...unscopedSources];

    const availableApis = new Map<string, { type: string; base_url: string; cli?: AppApiCliInfo }>(
      allSources.map(s => [s.name, { type: s.type, base_url: s.base_url }]),
    );

    // Fallback: resolve missing APIs from manifest services + deployed environments
    const missing = apiNames.filter(name => !availableApis.has(name));
    if (missing.length > 0) {
      await this.resolveApisFromManifest(projectId, missing, availableApis);
    }

    // After fallback, check if any are still missing
    const stillMissing = apiNames.filter(name => !availableApis.has(name));
    if (stillMissing.length > 0) {
      const available = [...availableApis.keys()].join(', ') || '(none)';
      throw new BadRequestException(
        `APIs not found in project: ${stillMissing.join(', ')}. Available APIs: ${available}`,
      );
    }

      resolvedApis = apiNames.map(name => {
      const info = availableApis.get(name)!;
      return { name, type: info.type, base_url: info.base_url, ...(info.cli ? { cli: info.cli } : {}) };
    });
    }

    const resolvedLinks = linkNames?.length
      ? await this.resolveAppLinks(projectId, linkNames, envName)
      : [];

    return {
      description: description + buildAppApiInstructionBlock([...resolvedApis, ...resolvedLinks]),
      hints: {
        ...hints,
        ...(resolvedApis.length > 0 ? { resolved_app_apis: resolvedApis } : {}),
        ...(resolvedLinks.length > 0 ? { resolved_app_links: resolvedLinks } : {}),
      },
    };
  }

  private async resolveAppLinks(
    projectId: string,
    aliases: string[],
    envName?: string | null,
  ): Promise<AppApiInfo[]> {
    const resolved: AppApiInfo[] = [];
    const subscriptions = await this.appLinkSubscriptions.listWithGrants({
      consumer_project_id: projectId,
    });
    const byAlias = new Map(subscriptions.map((subscription) => [subscription.local_alias, subscription]));

    for (const alias of aliases) {
      const subscription = byAlias.get(alias);
      if (!subscription || !subscription.api_grant) {
        throw new BadRequestException(`App link not found for project: ${alias}`);
      }
      const grant = subscription.api_grant;
      if (grant.revoked_at) {
        throw new BadRequestException(`App link "${alias}" grant is revoked`);
      }
      if (!subscription.inject_into_jobs) {
        throw new BadRequestException(`App link "${alias}" is not exposed to jobs (set inject_into.jobs: true)`);
      }
      if (!grant.service_name) {
        throw new BadRequestException(`App link "${alias}" does not expose an API service`);
      }

      const producerEnv = subscription.environment_strategy === 'same'
        ? envName
        : subscription.producer_env_name;
      if (!producerEnv) {
        throw new BadRequestException(`App link "${alias}" requires an env_name or fixed producer environment`);
      }
      if (grant.envs.length > 0 && !grant.envs.includes(producerEnv)) {
        throw new BadRequestException(`App link "${alias}" is not granted for producer env ${producerEnv}`);
      }

      const producerProject = await this.projects.findById(grant.producer_project_id);
      if (!producerProject) {
        throw new BadRequestException(`Producer project ${grant.producer_project_id} not found for app link "${alias}"`);
      }
      const producerOrg = await this.orgs.findById(producerProject.org_id, { include_deleted: false });
      if (!producerOrg) {
        throw new BadRequestException(`Producer org ${producerProject.org_id} not found for app link "${alias}"`);
      }
      const port = await this.resolveAppLinkServicePort(grant.producer_project_id, grant.service_name);
      const namespace = deriveNamespace(producerOrg.slug, producerProject.slug, producerEnv);
      const baseUrl = `http://${producerEnv}-${grant.service_name}.${namespace}.svc.cluster.local${port ? `:${port}` : ''}`;
      resolved.push({
        name: grant.export_name,
        alias,
        subscription_id: subscription.id,
        origin: 'app_link',
        type: 'openapi',
        base_url: baseUrl,
        scopes: subscription.requested_scopes,
        producer_project_id: grant.producer_project_id,
        producer_env: producerEnv,
        ...(grant.cli_name ? { cli: { name: grant.cli_name, bin: grant.cli_bin_path ?? grant.cli_name, ...(grant.cli_image ? { image: grant.cli_image } : {}) } } : {}),
      });
    }

    return resolved;
  }

  private async resolveAppLinkServicePort(projectId: string, serviceName: string): Promise<number | null> {
    const manifestRecord = await this.manifests.findLatestByProject(projectId);
    if (!manifestRecord) return null;
    try {
      const manifest = yaml.parse(manifestRecord.manifest_yaml) as Record<string, unknown>;
      const services = getServicesFromManifest(manifest as never);
      const service = services?.[serviceName];
      if (!service) return null;
      return this.extractServicePort(service as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fallback: resolve API URLs from manifest services and deployed environments.
   * When with_apis references a service name that matches a manifest service,
   * construct the internal K8s URL from the environment deployment.
   */
  private async resolveApisFromManifest(
    projectId: string,
    apiNames: string[],
    availableApis: Map<string, { type: string; base_url: string; cli?: AppApiCliInfo }>,
  ): Promise<void> {
    try {
      const project = await this.projects.findById(projectId);
      if (!project) return;

      const org = await this.orgs.findById(project.org_id, { include_deleted: false });
      if (!org) return;

      const manifestRecord = await this.manifests.findLatestByProject(projectId);
      if (!manifestRecord) return;

      const manifest = yaml.parse(manifestRecord.manifest_yaml) as Record<string, unknown>;
      const services = getServicesFromManifest(manifest as never);

      const envs = await this.environments.list({ project_id: projectId, limit: 10, offset: 0 });
      const activeEnv = envs.find(e => e.status === 'active') ?? envs[0];
      if (!activeEnv) return;

      for (const name of apiNames) {
        let portSuffix = '';
        let cliInfo: AppApiCliInfo | undefined;
        if (services) {
          const service = services[name];
          if (service) {
            const port = this.extractServicePort(service as Record<string, unknown>);
            portSuffix = port ? `:${port}` : '';

            // Extract CLI metadata from x-eve.cli
            const xeve = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
            const cli = xeve && typeof xeve === 'object' ? (xeve as Record<string, unknown>).cli : undefined;
            if (cli && typeof cli === 'object') {
              const c = cli as Record<string, string>;
              if (c.name && c.bin) {
                cliInfo = { name: c.name, bin: c.bin, ...(c.image ? { image: c.image } : {}) };
              }
            }
          }
        }

        const namespace = deriveNamespace(org.slug, project.slug, activeEnv.name);
        const baseUrl = `http://${activeEnv.name}-${name}.${namespace}.svc.cluster.local${portSuffix}`;
        availableApis.set(name, { type: 'openapi', base_url: baseUrl, ...(cliInfo ? { cli: cliInfo } : {}) });
      }
    } catch {
      // Non-fatal — just means we couldn't resolve from manifest
    }
  }

  private extractServicePort(service: Record<string, unknown>): number | undefined {
    const ports = service.ports;
    if (!Array.isArray(ports) || ports.length === 0) return undefined;
    const first = ports[0];
    if (typeof first === 'number') return first;
    if (typeof first === 'string') {
      const parsed = parseInt(first, 10);
      return isNaN(parsed) ? undefined : parsed;
    }
    if (typeof first === 'object' && first !== null) {
      const port = (first as Record<string, unknown>).port ?? (first as Record<string, unknown>).containerPort;
      return typeof port === 'number' ? port : undefined;
    }
    return undefined;
  }

  /**
   * Discover services with x-eve.cli or x-eve.api_spec from the raw manifest YAML.
   * Returns service names (e.g., ['api']) that should be injected as app_apis.
   */
  private discoverApiServicesFromManifest(manifestYaml: string): string[] {
    try {
      const manifest = yaml.parse(manifestYaml) as Record<string, unknown>;
      const services = getServicesFromManifest(manifest as never);
      if (!services) return [];

      const apiServices: string[] = [];
      for (const [name, service] of Object.entries(services)) {
        if (!service || typeof service !== 'object') continue;
        const xeve = (service as Record<string, unknown>)['x-eve'] ?? (service as Record<string, unknown>).x_eve;
        if (!xeve || typeof xeve !== 'object') continue;
        const x = xeve as Record<string, unknown>;
        if (x.cli || x.api_spec) {
          apiServices.push(name);
        }
      }
      return apiServices;
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Project-scoped operations
  // --------------------------------------------------------------------------

  /**
   * Hold a new job's env overrides to the project's profile (rule
   * harness.reserved_env): code-loading names and the added TLS trust names
   * are refused under `strict` and recorded under `audit`.
   */
  async holdReservedEnvOverrides(projectId: string, overrides: Record<string, string>, caller?: AuthUser): Promise<void> {
    const project = await this.resolveProject(projectId);
    await holdReservedEnvOverrides(this.security, { projectId: project, actor: caller, where: 'a new job' }, overrides);
  }

  /**
   * Refuse (403) a caller who may not add a job under `parentId` in the
   * project (see assertMayAddUnder). The jobs route calls this before create.
   */
  async assertMayCreateUnder(projectId: string, parentId: string, caller: AuthUser): Promise<void> {
    const parent = await this.requireJobInProject(parentId, await this.resolveProject(projectId));
    await this.assertMayAddUnder(parent, caller);
  }

  /**
   * Create a new job in a project
   */
  async create(
    projectId: string,
    data: CreateJobRequest,
    userId?: string,
    requestId?: string,
    options: WorkStartOptions = {},
  ): Promise<JobResponse> {
    // Validate required fields
    if (!data.description) {
      throw new BadRequestException('description is required');
    }

    // Resolve project (can be slug or TypeID)
    const resolvedProjectId = await this.resolveProject(projectId);

    // Look up project to get slug for job ID generation
    const project = await this.projects.findById(resolvedProjectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (data.parent_id) {
      await this.requireJobInProject(data.parent_id, resolvedProjectId);
    }

    // Look up latest manifest to apply defaults
    const manifest = await this.manifests.findLatestByProject(resolvedProjectId);
    const defaults = manifest?.parsed_defaults as Record<string, unknown> | null;

    // Apply manifest defaults if available
    if (defaults) {
      const envDefault = defaults.env;
      if (data.env_name === undefined && typeof envDefault === 'string' && envDefault.length > 0) {
        data.env_name = envDefault;
      }

      if (defaults.hints && typeof defaults.hints === 'object' && defaults.hints !== null) {
        const manifestHints = defaults.hints as JobHints;
        data.hints = { ...manifestHints, ...data.hints };
      }
      if (data.harness === undefined && typeof defaults.harness === 'string' && defaults.harness.length > 0) {
        data.harness = defaults.harness;
      }
      if (
        data.harness_profile === undefined &&
        typeof defaults.harness_profile === 'string' &&
        defaults.harness_profile.length > 0
      ) {
        data.harness_profile = defaults.harness_profile;
      }
      if (defaults.harness_options && typeof defaults.harness_options === 'object' && defaults.harness_options !== null) {
        const manifestHarnessOptions = defaults.harness_options as JobHarnessOptions;
        if (data.harness_options === undefined) {
          data.harness_options = manifestHarnessOptions;
        } else if (data.harness_options && typeof data.harness_options === 'object') {
          data.harness_options = { ...manifestHarnessOptions, ...data.harness_options };
        }
      }

      // Merge git defaults - manifest defaults come first, explicit git settings override
      if (defaults.git && typeof defaults.git === 'object' && defaults.git !== null) {
        const manifestGit = defaults.git as JobGit;
        data.git = { ...manifestGit, ...data.git };
      }

      // Merge workspace defaults - manifest defaults come first, explicit workspace settings override
      if (defaults.workspace && typeof defaults.workspace === 'object' && defaults.workspace !== null) {
        const manifestWorkspace = defaults.workspace as JobWorkspace;
        data.workspace = { ...manifestWorkspace, ...data.workspace };
      }
    }

    if (data.resource_refs && data.resource_refs.length > 0) {
      this.validateResourceRefs(data.resource_refs, requestId);
    }

    // Block job creation if the target environment is suspended
    if (data.env_name) {
      const targetEnv = await this.environments.findByProjectAndName(resolvedProjectId, data.env_name);
      if (targetEnv && targetEnv.status === 'suspended') {
        throw new ConflictException(
          `Environment "${data.env_name}" is suspended: ${targetEnv.suspension_reason ?? 'no reason given'}. Resume the environment before creating new jobs.`,
        );
      }
    }

    // Resolve target.agent_slug to an assignee if provided
    if (data.target?.agent_slug && !data.assignee) {
      const agent = await this.agents.findByOrgAndSlug(project.org_id, data.target.agent_slug);
      if (agent) {
        data.assignee = agent.id;
      }
      // If agent not found, we still store the target — resolution may happen later
    }
    // TODO: resolve target.team and target.workflow when team/workflow routing is implemented

    // Auto-discover services with x-eve.cli or api_spec from manifest when no
    // app_apis hint is provided. This ensures agent jobs always get CLI binaries
    // on PATH without requiring explicit with_apis declarations.
    if (!data.hints?.app_apis && manifest?.manifest_yaml) {
      const autoApis = this.discoverApiServicesFromManifest(manifest.manifest_yaml);
      if (autoApis.length > 0) {
        data.hints = { ...data.hints, app_apis: autoApis };
      }
    }
    if (!data.hints?.app_links) {
      const subscriptions = await this.appLinkSubscriptions.listByConsumer(resolvedProjectId);
      const autoLinks = subscriptions
        .filter((subscription) => subscription.inject_into_jobs)
        .map((subscription) => subscription.local_alias);
      if (autoLinks.length > 0) {
        data.hints = { ...data.hints, app_links: autoLinks };
      }
    }

    // Resolve app APIs: validate requested APIs exist and append instruction block to description
    const appApiResult = await this.resolveAppApis(resolvedProjectId, data.description, data.hints, data.env_name);
    data.description = appApiResult.description;
    if (appApiResult.hints) data.hints = appApiResult.hints;

    // Auto-generate title from first line of description if not provided
    let title = data.title;
    if (!title) {
      const firstLine = data.description.split('\n')[0].trim();
      title = firstLine.length > 64 ? firstLine.substring(0, 61) + '...' : firstLine;
    }

    // Project the effective harness profile into jobs.harness/jobs.harness_options.
    //
    // The orchestrator reads jobs.harness / jobs.harness_options when dispatching
    // and IGNORES jobs.harness_profile. Without this projection, setting
    // harness_profile or harness_profile_override on a direct POST /jobs
    // request would silently have no effect on execution.
    //
    // Precedence (docs/plans/per-job-harness-override-plan.md §3.2):
    //   harness_profile_override (inline bundle) > harness (explicit) > harness_profile (string ref)
    // i.e. inline override wins over everything; otherwise explicit legacy
    // fields still trump a profile string ref.
    let harnessProfileSource: HarnessProfileSource | null = null;
    let harnessProfileHash: string | null = null;
    if (data.harness_profile_override || data.harness_profile || data.env_overrides) {
      const resolved = await sharedResolveHarnessProfile(
        {
          agentConfigs: this.agentConfigs,
          manifests: this.manifests,
          logger: { warn: (m: string) => console.warn(`[jobs.create] ${m}`) },
        },
        {
          projectId: resolvedProjectId,
          stringRef: data.harness_profile ?? null,
          inlineOverride: data.harness_profile_override ?? null,
          envOverrides: data.env_overrides ?? null,
        },
      );

      // Surface resolver warnings to orchestrator logs + structured execution
      // log so scenario 34 phase F (and future analytics) can detect conflicts.
      for (const w of resolved.warnings) {
        console.warn(`[jobs.create] ${w.code}: ${w.message}`);
      }

      if (data.harness_profile_override) {
        data.harness = resolved.harness;
        data.harness_options = resolved.harness_options as JobHarnessOptions | undefined;
      } else if (data.harness_profile) {
        if (!data.harness && resolved.harness) data.harness = resolved.harness;
        if (!data.harness_options && resolved.harness_options) {
          data.harness_options = resolved.harness_options as JobHarnessOptions;
        }
      }

      harnessProfileSource = data.harness_profile_override || data.harness_profile
        ? resolved.source
        : null;
      harnessProfileHash = resolved.profile_hash;
    }

    if (options.startedBy !== undefined) {
      await this.requireSecretsUse(resolvedProjectId, project.org_id, data, options);
    }

    // Generate job ID using project slug
    const { id: jobId, projectId: resolvedId } = await this.jobs.generateJobId(
      resolvedProjectId,
      data.parent_id ?? undefined,
    );

    // Calculate depth
    const depth = data.parent_id ? data.parent_id.split('.').length : 0;

    // Create job (default phase is 'ready' = schedulable immediately)
    const job = await this.jobs.create({
      id: jobId,
      project_id: resolvedId,
      parent_id: data.parent_id ?? null,
      depth,
      title,
      description: data.description,
      issue_type: data.issue_type ?? 'task',
      labels: data.labels ?? [],
      phase: data.phase ?? 'ready',
      priority: data.priority ?? 2,
      assignee: data.assignee ?? null,
      review_required: data.review_required ?? 'none',
      review_status: null,
      reviewer: null,
      defer_until: data.defer_until ? new Date(data.defer_until) : null,
      due_at: data.due_at ? new Date(data.due_at) : null,
      hints: data.hints ?? {},
      harness: data.harness ?? null,
      harness_profile: data.harness_profile ?? null,
      harness_options: data.harness_options ?? null,
      harness_profile_override: data.harness_profile_override ?? null,
      env_overrides: data.env_overrides ?? null,
      token_scope: data.token_scope ?? null,
      token_permissions: data.token_permissions ?? null,
      harness_profile_source: harnessProfileSource,
      harness_profile_hash: harnessProfileHash,
      git_json: data.git ?? null,
      resolved_git_json: null,
      workspace_json: data.workspace ?? null,
      blocked_on_gates: [],
      env_name: data.env_name ?? null,
      execution_mode: data.execution_mode ?? 'persistent',
      execution_type: 'agent',
      run_id: null,
      step_name: null,
      action_type: null,
      action_input: null,
      script_command: null,
      script_timeout_seconds: null,
      target: data.target ?? null,
      resource_refs: data.resource_refs ?? [],
      content_hash: null,
      actor_user_id: storedActor(userId),
      user_secrets_excluded: options.userSecretsExcluded ?? false,
      secrets_allowlist: options.secretsAllowlist ?? null,
      failure_disposition: null,
      closed_at: null,
      close_reason: null,
    });

    return this.toJobResponse(job);
  }

  /**
   * Rule secrets.use: whoever starts a job bound to a secret beyond its
   * harness credential needs `secrets:use` (RbacService.requireOperatorRight).
   * The binding is the job's agent's `access.secrets` narrowed by the starting
   * caller's allowlist, plus the keys its env overrides reference.
   */
  private async requireSecretsUse(
    projectId: string,
    orgId: string,
    data: CreateJobRequest,
    options: WorkStartOptions,
  ): Promise<void> {
    if (!this.rbac) return;
    const agent = await findJobAgent(this.agents, {
      projectId,
      agentId: data.assignee,
      agentSlug: data.target?.agent_slug,
    }, orgId);
    const bound = boundSecretKeys({
      allowlist: narrowSecretsAllowlist(agentSecretsAllowlist(agent?.access_json), options.secretsAllowlist ?? null),
      envOverrides: data.env_overrides,
      harness: data.harness,
    });
    if (bound.length === 0) return;
    await this.rbac.requireOperatorRight(options.startedBy ?? null, projectId, 'secrets:use', SECRETS_USE_RULE, {
      secrets: bound.join(','),
      ...(agent ? { agent: agent.id } : {}),
    });
  }

  /**
   * List jobs for a project with optional filters
   */
  async list(
    projectId: string,
    options?: {
      phase?: Job['phase'];
      assignee?: string;
      priority?: number;
      createdAfter?: Date;
      stuck?: boolean;
      stuckMinutes?: number;
      label?: string;
      executionType?: string;
      parentId?: string | null;
      failureDisposition?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<JobListResponse> {
    const resolvedProjectId = await this.resolveProject(projectId);

    const jobs = await this.jobs.list(resolvedProjectId, {
      phase: options?.phase,
      assignee: options?.assignee,
      createdAfter: options?.createdAfter,
      stuck: options?.stuck,
      stuckMinutes: options?.stuckMinutes,
      execution_type: options?.executionType as Job['execution_type'],
      label: options?.label,
      parentId: options?.parentId,
      failureDisposition: options?.failureDisposition,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    });

    return {
      jobs: jobs.map(j => this.toJobResponse(j)),
    };
  }

  /**
   * Get ready/schedulable jobs for a project
   */
  async getReadyJobs(
    projectId: string,
    options?: { assignee?: string | null; limit?: number }
  ): Promise<JobListResponse> {
    const resolvedProjectId = await this.resolveProject(projectId);

    const jobs = await this.jobs.getReadyJobs(resolvedProjectId, {
      assignee: options?.assignee,
      limit: options?.limit ?? 10,
    });

    return {
      jobs: jobs.map(j => this.toJobResponse(j)),
    };
  }

  /**
   * Get blocked jobs for a project
   */
  /**
   * A project job list as the caller may see it (rule jobs.token_read_scope).
   * A job token sees the jobs of its own tree and pipeline run; when the list
   * holds others, `audit` records that and returns the list, and `strict`
   * records it and returns only the caller's own (a page may then be short).
   * User tokens get the list as it is.
   */
  async scopeListToCaller(caller: AuthUser | undefined, list: JobListResponse): Promise<JobListResponse> {
    if (!this.security || !caller?.is_job_token || !caller.job_id) return list;
    const reader = { jobId: caller.job_id, runId: (await this.jobs.findById(caller.job_id))?.run_id ?? null };
    const others = list.jobs.filter((job) => !inReadScope(reader, job));
    if (others.length === 0) return list;
    const profile = await this.security.decide(JOB_TOKEN_READ_SCOPE_RULE, {
      governing: 'project',
      projectId: others[0].project_id,
      actor: caller,
      detail: { reader_job_id: caller.job_id, other_jobs_listed: others.length },
    });
    if (profile !== 'strict') return list;
    const jobs = list.jobs.filter((job) => inReadScope(reader, job));
    return { ...list, jobs, ...(list.total === undefined ? {} : { total: jobs.length }) };
  }

  async getBlockedJobs(projectId: string): Promise<JobListResponse> {
    const resolvedProjectId = await this.resolveProject(projectId);

    const jobs = await this.jobs.getBlockedJobs(resolvedProjectId);

    return {
      jobs: jobs.map(j => this.toJobResponse(j)),
    };
  }

  // --------------------------------------------------------------------------
  // Admin operations (cross-project)
  // --------------------------------------------------------------------------

  /**
   * List all jobs across all projects (admin)
   *
   * Unlike `list()`, this doesn't require a project ID.
   * Supports optional filtering by org, project, and phase.
   */
  async listAll(options?: {
    orgId?: string;
    projectId?: string;
    phase?: Job['phase'];
    label?: string;
    executionType?: string;
    parentId?: string | null;
    failureDisposition?: string;
    limit?: number;
    offset?: number;
  }): Promise<JobListResponse> {
    const jobs = await this.jobs.listAll({
      orgId: options?.orgId,
      projectId: options?.projectId,
      phase: options?.phase,
      execution_type: options?.executionType as Job['execution_type'],
      label: options?.label,
      parentId: options?.parentId,
      failureDisposition: options?.failureDisposition,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    });

    return {
      jobs: jobs.map(j => this.toJobResponse(j)),
    };
  }

  // --------------------------------------------------------------------------
  // Job-scoped operations
  // --------------------------------------------------------------------------

  /**
   * Get a job by ID
   */
  async findById(jobId: string): Promise<JobResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return this.toJobResponse(job);
  }

  /**
   * Update a job
   */
  async update(jobId: string, updates: UpdateJobRequest, caller?: AuthUser): Promise<JobResponse> {
    const currentJob = await this.jobs.findById(jobId);
    if (!currentJob) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const decision = reviewDecision(currentJob, updates);
    if (decision) {
      await this.guardApprovalToken(currentJob, caller, decision);
    }
    if (lowersReview(currentJob, updates)) {
      await this.guardStepTokenLoweringReview(currentJob, caller);
    }
    const cascade = updates.phase === 'cancelled' && await this.cancelCascades(currentJob);
    const apply = (tx: Db) => this.applyUpdate(tx, currentJob, updates, { cascade, decider: deciderOf(caller), caller });
    if (caller && changesWhatRuns(currentJob, updates)) {
      await this.changeWhatJobRuns(currentJob, caller, apply);
    } else {
      if (changesProgress(currentJob, updates)) {
        await this.guardRunJob(currentJob, caller, 'change the phase or review of');
      }
      // One transaction: the phase and fields change together or not at all,
      // on a row whose actor is still the one judged above.
      await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await this.lockJudgedActor(tx, currentJob);
        return apply(tx);
      });
    }

    // Re-fetch the updated job
    const updatedJob = await this.jobs.findById(jobId);
    if (!updatedJob) {
      throw new NotFoundException(`Job ${jobId} not found after update`);
    }

    return this.toJobResponse(updatedJob);
  }

  /**
   * Applies `change` to what `job` runs, on behalf of `caller`, in one
   * transaction; used by PATCH and by attachment changes. On the jobs of a
   * workflow or pipeline run only the actor may do this (403 otherwise), and
   * the project's security profile may hold it to the run too (guardRunJob).
   * On other jobs the caller becomes the actor when they are not (see
   * actorForChange: 400 if they could not grant the job's permissions or hold
   * its token scope). The row is locked while its actor is still the one
   * judged (409 otherwise), and `change` runs in the same transaction, so
   * nothing changes when any part fails.
   */
  async changeWhatJobRuns<T>(job: Job, caller: AuthUser, change: (tx: Db) => Promise<T>): Promise<T> {
    const run = isSameActor(job.actor_user_id, caller.user_id) ? null : await this.runOf(job);
    if (run) {
      throw new ForbiddenException(
        `Job ${job.id} belongs to a ${runKind(run)} run, and only its actor can change what it runs or its attachments; ` +
        `${howToChangeRun(run)} instead`,
      );
    }
    await this.guardRunJob(job, caller, 'change what runs in');
    const nextActor = await this.actorForChange(job, caller);
    const result = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await this.lockJudgedActor(tx, job);
      if (nextActor && nextActor.scopeJudgedAt !== undefined) {
        // A new actor keeps the judged scope mark only when the scope was
        // judged again for them (P1-6).
        await tx`
          UPDATE jobs
          SET actor_user_id = ${nextActor.actorUserId}, user_secrets_excluded = ${nextActor.userSecretsExcluded}, secrets_allowlist = ${nextActor.secretsAllowlist}, token_scope_judged_at = ${nextActor.scopeJudgedAt}, updated_at = NOW()
          WHERE id = ${job.id}
        `;
      } else if (nextActor) {
        await tx`
          UPDATE jobs
          SET actor_user_id = ${nextActor.actorUserId}, user_secrets_excluded = ${nextActor.userSecretsExcluded}, secrets_allowlist = ${nextActor.secretsAllowlist}, updated_at = NOW()
          WHERE id = ${job.id}
        `;
      }
      return change(tx);
    });
    return result as T;
  }

  /**
   * The run a job belongs to, judged from its record (see runOfRecord): a
   * step the run compiled (its step_name column, which only the expanders
   * set) or the root of a run (a job with such a step under it). The steps of
   * a run feed each other as their own actors or the run's, so these actors
   * never move to someone else.
   */
  private async runOf(job: Job): Promise<RunRef | null> {
    if (job.step_name) {
      return runOfRecord(job, false);
    }
    const [compiledChild] = await this.db<Array<{ id: string }>>`
      SELECT id FROM jobs WHERE parent_id = ${job.id} AND step_name IS NOT NULL LIMIT 1
    `;
    return runOfRecord(job, Boolean(compiledChild));
  }

  /**
   * The run of the job a job token was minted for, when that job is in
   * `projectId`. With `compiledStepsOnly`, only a compiled step's token
   * counts, not the run root's.
   */
  private async callerRun(caller: AuthUser, projectId: string, compiledStepsOnly: boolean): Promise<RunRef | null> {
    if (!caller.is_job_token || !caller.job_id) {
      return null;
    }
    const own = await this.jobs.findById(caller.job_id);
    if (!own || own.project_id !== projectId || (compiledStepsOnly && !own.step_name)) {
      return null;
    }
    return this.runOf(own);
  }

  /** True for a system admin, or a caller holding jobs:admin in the project. */
  private async holdsJobsAdmin(caller: AuthUser, projectId: string): Promise<boolean> {
    if (caller.is_admin) {
      return true;
    }
    return (await this.rbac!.resolveEffectivePermissions(caller, projectId)).has('jobs:admin');
  }

  /**
   * A new job joins its parent's tree: the parent's coordination thread, the
   * parent's run when it is in one, and the wake-ups of a parent waiting on
   * its children. Only those the parent already belongs to may add it: the
   * parent's actor; for a caller with no user, the parent job's own token or
   * a job token of the parent's run (its root or a compiled step, judged from
   * the job records); or a project admin (jobs:admin). 403 otherwise.
   */
  private async assertMayAddUnder(parent: Job, caller: AuthUser): Promise<void> {
    if (hasUserActor(caller.user_id)) {
      if (caller.user_id === parent.actor_user_id) {
        return;
      }
    } else if (caller.is_job_token && caller.job_id) {
      if (caller.job_id === parent.id) {
        return;
      }
      const parentRun = await this.runOf(parent);
      if (parentRun && parentRun.key === (await this.callerRun(caller, parent.project_id, false))?.key) {
        return;
      }
    }
    if (await this.holdsJobsAdmin(caller, parent.project_id)) {
      return;
    }
    throw new ForbiddenException(
      `Job ${parent.id} belongs to someone else: only its actor, a job of its own run or a project admin (jobs:admin) can add jobs under it`,
    );
  }

  /**
   * Holds a change to the jobs of a workflow or pipeline run to the run, under
   * the project's security profile (rule jobs.run_step_change). The run
   * accepts its actor with their own token (whoever started the run, or the
   * retry the step belongs to), a job token of one of its compiled steps, and
   * a project admin (jobs:admin). Anyone else is allowed under `legacy`,
   * allowed and recorded under `audit`, and refused with 403 under `strict`.
   * Jobs outside a run, and calls with no caller, are not held.
   */
  private async guardRunJob(job: Job, caller: AuthUser | undefined, change: string): Promise<void> {
    if (!caller) {
      return;
    }
    if (isUserToken(caller) && hasUserActor(caller.user_id) && caller.user_id === job.actor_user_id) {
      return;
    }
    const run = await this.runOf(job);
    if (!run || await this.mayChangeRun(run, job.project_id, caller)) {
      return;
    }
    await this.security!.gate(
      RUN_STEP_CHANGE_RULE,
      { governing: 'project', projectId: job.project_id, actor: caller, detail: { job_id: job.id, change } },
      `Job ${job.id} is part of a workflow or pipeline run: only the run's actor, a step of the same run or a project admin (jobs:admin) can ${change} it`,
    );
  }

  private async mayChangeRun(run: RunRef, projectId: string, caller: AuthUser): Promise<boolean> {
    if (isUserToken(caller) && hasUserActor(caller.user_id) && run.rootId) {
      const root = await this.jobs.findById(run.rootId);
      if (root && caller.user_id === root.actor_user_id) {
        return true;
      }
    }
    if ((await this.callerRun(caller, projectId, true))?.key === run.key) {
      return true;
    }
    return this.holdsJobsAdmin(caller, projectId);
  }

  /**
   * Holds an approval or rejection to a person's own token, under the
   * project's security profile (rule jobs.approve_token): a job, service,
   * service-principal or app-link token is allowed under `legacy`, allowed
   * and recorded under `audit`, and refused with 403 under `strict`.
   */
  private async guardApprovalToken(job: Job, caller: AuthUser | undefined, action: string): Promise<void> {
    if (!caller || isUserToken(caller)) {
      return;
    }
    await this.security!.gate(
      APPROVE_TOKEN_RULE,
      { governing: 'project', projectId: job.project_id, actor: caller, detail: { job_id: job.id, action } },
      `Only a person, with their own token, can ${action} job ${job.id}`,
    );
  }

  /**
   * A compiled run step's token may not lower the review a job needs, its
   * own job's included, under the project's security profile (rule
   * jobs.run_step_change).
   */
  private async guardStepTokenLoweringReview(job: Job, caller: AuthUser | undefined): Promise<void> {
    if (!caller?.is_job_token || !caller.job_id) {
      return;
    }
    const own = caller.job_id === job.id ? job : await this.jobs.findById(caller.job_id);
    if (!own?.step_name) {
      return;
    }
    await this.security!.gate(
      RUN_STEP_CHANGE_RULE,
      { governing: 'project', projectId: job.project_id, actor: caller, detail: { job_id: job.id, change: 'lower the review of' } },
      `A step of a workflow or pipeline run cannot lower the review job ${job.id} needs`,
    );
  }

  /**
   * The dependencies of a job outside any run change only for those who may
   * change the job: its actor (with their own token or their agents'), its
   * own job token, or a project admin (jobs:admin). Under the project's
   * security profile (rule jobs.dependency_change) anyone else is allowed
   * under `legacy`, recorded under `audit` and refused (403) under `strict`.
   * A run's jobs are held to the run instead (guardRunJob).
   */
  private async guardDependencyChange(job: Job, caller: AuthUser | undefined): Promise<void> {
    if (!caller || await this.runOf(job)) {
      return;
    }
    if (hasUserActor(caller.user_id) && caller.user_id === job.actor_user_id) {
      return;
    }
    if (caller.is_job_token && caller.job_id === job.id) {
      return;
    }
    if (await this.holdsJobsAdmin(caller, job.project_id)) {
      return;
    }
    await this.security!.gate(
      DEPENDENCY_CHANGE_RULE,
      { governing: 'project', projectId: job.project_id, actor: caller, detail: { job_id: job.id } },
      `Job ${job.id} belongs to someone else: only its actor, its own job or a project admin (jobs:admin) can change its dependencies`,
    );
  }

  /**
   * Under the project's `strict` profile, cancelling a compiled run step also
   * cancels the steps after it, as a failure does.
   */
  private async cancelCascades(job: Job): Promise<boolean> {
    if (!job.step_name || job.phase === 'cancelled' || job.phase === 'done') {
      return false;
    }
    return (await this.security!.effectiveProfile({ projectId: job.project_id }, 'project')) === 'strict';
  }

  /** A compiled step's dependencies come from its workflow or pipeline definition. */
  private assertEdgesFromDefinition(job: Job): void {
    if (job.step_name) {
      throw new ConflictException(
        `Job ${job.id} is a step of a workflow or pipeline run; its dependencies come from the definition and cannot be changed here`,
      );
    }
  }

  /**
   * Holds the job's row for the rest of the transaction and refuses (409)
   * when its phase or review requirement is no longer what the PATCH was
   * judged on: whether it approves, rejects or lowers a review, and who may
   * make it, were decided from that read.
   */
  private async lockReviewState(tx: Db, job: Job): Promise<void> {
    const [row] = await tx<Array<{ phase: Job['phase']; review_required: Job['review_required'] }>>`
      SELECT phase, review_required FROM jobs WHERE id = ${job.id} FOR UPDATE
    `;
    if (!row || row.phase !== job.phase || row.review_required !== job.review_required) {
      throw new ConflictException(`Job ${job.id} changed while it was being updated; read it again and retry`);
    }
  }

  /**
   * The phase transition and field changes of a PATCH, inside its
   * transaction. A move from review to done is an approval and a move back to
   * active a rejection: each records the decider, the review status and an
   * audit entry, as the approve and reject routes do.
   */
  private async applyUpdate(
    tx: Db,
    job: Job,
    updates: UpdateJobRequest,
    options: { cascade: boolean; decider: { id: string; type: string }; caller?: AuthUser },
  ): Promise<void> {
    const txJobs = jobQueries(tx);
    await this.lockReviewState(tx, job);

    // Handle phase transitions through updatePhase for validation
    if (updates.phase && updates.phase !== job.phase) {
      if (job.phase === 'review' && updates.phase === 'done') {
        try {
          await txJobs.approveReview(job.id, options.decider.id, undefined, options.decider.type);
        } catch (error) {
          throw reviewDecisionError(error);
        }
      } else if (job.phase === 'review' && updates.phase === 'active') {
        // A rejection, as the reject route makes it: the caller's allowlist
        // narrows the job, and a new attempt runs it again.
        await this.narrowToCallerAllowlist(tx, job.id, options.caller);
        try {
          await txJobs.rejectReview(
            job.id,
            options.decider.id,
            updates.close_reason ?? 'Sent back from review',
            options.decider.type,
          );
        } catch (error) {
          throw reviewDecisionError(error);
        }
      } else if (updates.phase === 'cancelled') {
        const cancelled = await txJobs.cancelJob(job.id, updates.close_reason ?? undefined, { cascade: options.cascade });
        if (!cancelled) {
          throw new NotFoundException(`Job ${job.id} not found`);
        }
      } else {
        const result = await txJobs.updatePhase(job.id, updates.phase);
        if (!result.success) {
          throw new BadRequestException(result.error);
        }
      }
    }

    // Check if there are any non-phase updates to apply
    const hasUpdates =
      updates.title !== undefined ||
      updates.description !== undefined ||
      updates.labels !== undefined ||
      updates.priority !== undefined ||
      updates.assignee !== undefined ||
      updates.review_required !== undefined ||
      updates.defer_until !== undefined ||
      updates.due_at !== undefined ||
      updates.close_reason !== undefined ||
      updates.harness !== undefined ||
      updates.harness_profile !== undefined ||
      updates.harness_options !== undefined ||
      updates.hints !== undefined ||
      updates.git !== undefined ||
      updates.workspace !== undefined ||
      updates.env_name !== undefined ||
      updates.execution_mode !== undefined;

    if (hasUpdates) {
      // Use COALESCE pattern for optional updates - null means "keep existing"
      // For fields where we want to allow explicit null, we handle specially
      const title = updates.title ?? null;
      const description = updates.description !== undefined ? updates.description : null;
      const labels = updates.labels ?? null;
      const priority = updates.priority ?? null;
      const assignee = updates.assignee !== undefined ? updates.assignee : null;
      const reviewRequired = updates.review_required ?? null;
      const deferUntil = updates.defer_until !== undefined
        ? (updates.defer_until ? new Date(updates.defer_until) : null)
        : null;
      const dueAt = updates.due_at !== undefined
        ? (updates.due_at ? new Date(updates.due_at) : null)
        : null;
      const closeReason = updates.close_reason !== undefined ? updates.close_reason : null;
      const harness = updates.harness !== undefined ? updates.harness : null;
      const harnessProfile = updates.harness_profile !== undefined ? updates.harness_profile : null;
      const harnessOptions = updates.harness_options !== undefined
        ? (updates.harness_options as Parameters<typeof tx.json>[0])
        : null;

      // For fields that might be explicitly set to null, we need conditional SQL
      // Using a simpler approach: just update what was provided
      await tx`
        UPDATE jobs
        SET
          title = COALESCE(${title}, title),
          description = ${updates.description !== undefined ? description : tx`description`},
          labels = COALESCE(${labels}, labels),
          priority = COALESCE(${priority}, priority),
          assignee = ${updates.assignee !== undefined ? assignee : tx`assignee`},
          review_required = COALESCE(${reviewRequired}, review_required),
          defer_until = ${updates.defer_until !== undefined ? deferUntil : tx`defer_until`},
          due_at = ${updates.due_at !== undefined ? dueAt : tx`due_at`},
          close_reason = ${updates.close_reason !== undefined ? closeReason : tx`close_reason`},
          harness = ${updates.harness !== undefined ? harness : tx`harness`},
          harness_profile = ${updates.harness_profile !== undefined ? harnessProfile : tx`harness_profile`},
          harness_options = ${updates.harness_options !== undefined
            ? tx.json(harnessOptions)
            : tx`harness_options`},
          hints = ${updates.hints !== undefined ? tx.json(updates.hints as never) : tx`hints`},
          git_json = ${updates.git !== undefined ? tx.json(updates.git) : tx`git_json`},
          workspace_json = ${updates.workspace !== undefined ? tx.json(updates.workspace) : tx`workspace_json`},
          env_name = ${updates.env_name !== undefined ? updates.env_name : tx`env_name`},
          execution_mode = ${updates.execution_mode !== undefined ? updates.execution_mode : tx`execution_mode`},
          updated_at = NOW()
        WHERE id = ${job.id}
      `;
    }
  }

  /**
   * A job runs as its actor (their user secrets, org-fs bindings and step
   * ceiling). When someone other than the actor changes what the job runs or
   * how it runs, they become the actor (with their user-secrets marker), and
   * the job-token permissions and token scope the job carries must be ones
   * they could grant and hold, otherwise 400 before anything changes. The
   * actor's own edits, and cosmetic ones (priority, due date, review setting,
   * close reason, or moving it anywhere but ready or active), keep the actor.
   *
   * Returns the actor (and marker) the job should have after the change, or
   * null when they stay as they are.
   */
  private async actorForChange(
    job: Job,
    caller: AuthUser,
  ): Promise<{
    actorUserId: string | null;
    userSecretsExcluded: boolean;
    secretsAllowlist: string[] | null;
    /** The judged scope mark after the change: undefined leaves it as it is. */
    scopeJudgedAt?: Date | null;
  } | null> {
    const { userSecretsExcluded, secretsAllowlist: callerAllowlist } = workStartOptions(caller);
    // No actor and the 'system' actor of a no-user job token are the same actor.
    const sameActor = isSameActor(job.actor_user_id, caller.user_id);
    // The marker is sticky for the same actor and never loosened by an edit.
    const nextExcluded = sameActor ? job.user_secrets_excluded || userSecretsExcluded : userSecretsExcluded;
    // A secrets allowlist only ever narrows: a job a restricted job changes
    // may receive no secret that job could not.
    const nextAllowlist = narrowSecretsAllowlist(job.secrets_allowlist ?? null, callerAllowlist ?? null);
    const allowlistNarrowed = !sameSecretsAllowlist(nextAllowlist, job.secrets_allowlist ?? null);
    if (sameActor && nextExcluded === job.user_secrets_excluded) {
      // Narrowing needs no authority, so the actor's checks are not repeated.
      return allowlistNarrowed
        ? { actorUserId: job.actor_user_id, userSecretsExcluded: nextExcluded, secretsAllowlist: nextAllowlist }
        : null;
    }

    const project = await this.projects.findById(job.project_id);
    if (!project) {
      throw new NotFoundException(`Project ${job.project_id} not found`);
    }
    await assertCanGrantJobPermissions(this.accessService, {
      orgId: project.org_id,
      projectId: job.project_id,
      userId: caller.user_id,
      permissions: job.token_permissions,
      context: `Job ${job.id} job-token permissions`,
    });
    const { judged } = await judgeJobScope(this.accessService, {
      orgId: project.org_id,
      projectId: job.project_id,
      userId: caller.user_id,
      scope: this.storedTokenScope(job, caller),
      context: `Job ${job.id} token scope`,
    });
    // Work no user started is recorded as no actor, never as 'system'.
    const actorUserId = sameActor ? job.actor_user_id : hasUserActor(caller.user_id) ? caller.user_id : null;
    return {
      actorUserId,
      userSecretsExcluded: nextExcluded,
      secretsAllowlist: nextAllowlist,
      scopeJudgedAt: job.token_scope ? (judged ? new Date() : null) : undefined,
    };
  }

  /**
   * Locks the job row for the rest of the transaction, provided its actor and
   * marker are still the ones the change was judged against; otherwise 409.
   * Concurrent edits are applied one at a time, so one caller's checks never
   * stand for another caller's content.
   */
  private async lockJudgedActor(tx: Db, job: Job): Promise<void> {
    const [row] = await tx<Array<{ id: string }>>`
      SELECT id FROM jobs
      WHERE id = ${job.id}
        AND actor_user_id IS NOT DISTINCT FROM ${job.actor_user_id}
        AND user_secrets_excluded IS NOT DISTINCT FROM ${job.user_secrets_excluded}
        AND secrets_allowlist IS NOT DISTINCT FROM ${job.secrets_allowlist ?? null}::text[]
      FOR UPDATE
    `;
    if (!row) {
      throw new ConflictException(`Job ${job.id} changed while it was being updated; read it again and retry`);
    }
  }

  /**
   * The token scope a job carries, for judging a new actor against it. A
   * scope that does not parse, or one judged for a person when the new actor
   * is work no user started, is refused rather than carried over.
   */
  private storedTokenScope(job: Job, caller: AuthUser): AccessBindingScope | null {
    if (job.token_scope === null || job.token_scope === undefined) {
      return null;
    }
    const parsed = AccessBindingScopeSchema.safeParse(job.token_scope);
    if (!parsed.success) {
      throw new BadRequestException(`Job ${job.id} has a token scope that cannot be read`);
    }
    if (!hasUserActor(caller.user_id) && hasUserActor(job.actor_user_id)) {
      throw new BadRequestException(
        `Job ${job.id} carries a token scope judged for the person who started it; work no user started cannot take it on`,
      );
    }
    return parsed.data;
  }

  /**
   * Merge additional keys into a job's hints JSONB (shallow merge).
   */
  async updateHints(jobId: string, additional: Record<string, unknown>): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    const merged = { ...(job.hints ?? {}), ...additional };
    await this.db`
      UPDATE jobs
      SET hints = ${this.db.json(merged as Parameters<typeof this.db.json>[0])}, updated_at = NOW()
      WHERE id = ${jobId}
    `;
  }

  /**
   * Get job hierarchy (tree)
   */
  async getTree(jobId: string): Promise<JobTreeNode> {
    const hierarchy = await this.jobs.getHierarchy(jobId);
    const rootProjectId = hierarchy.find((job) => job.id === jobId)?.project_id;
    // Only jobs from the root's own project belong to its tree.
    const jobs = hierarchy.filter((job) => job.project_id === rootProjectId);
    if (jobs.length === 0) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    // Build tree structure
    const jobMap = new Map<string, JobTreeNode>();
    let root: JobTreeNode | null = null;

    // First pass: create nodes
    for (const job of jobs) {
      const node: JobTreeNode = {
        ...this.toJobResponse(job),
        children: [],
      };
      jobMap.set(job.id, node);

      if (job.id === jobId) {
        root = node;
      }
    }

    // Second pass: link children to parents
    for (const job of jobs) {
      if (job.parent_id && jobMap.has(job.parent_id)) {
        const parent = jobMap.get(job.parent_id)!;
        const child = jobMap.get(job.id)!;
        parent.children = parent.children || [];
        parent.children.push(child);
      }
    }

    if (!root) {
      throw new NotFoundException(`Job ${jobId} not found in hierarchy`);
    }

    return root;
  }

  /**
   * Get full job context (job, relations, latest attempt, derived fields)
   */
  async getContext(jobId: string): Promise<JobContextResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    // Only jobs from this job's own project are part of its context.
    const sameProject = <T extends { project_id: string }>(rows: T[]): T[] =>
      rows.filter((row) => row.project_id === job.project_id);
    const parentPromise = job.parent_id
      ? this.jobs.findById(job.parent_id).then((p) => (p?.project_id === job.project_id ? p : null))
      : Promise.resolve(null);

    // Fetch siblings if this is a child job
    const siblingsPromise = job.parent_id
      ? this.db<Array<{
          id: string; title: string; phase: string; assignee: string | null;
          result_summary: string | null;
        }>>`
          SELECT j.id, j.title, j.phase, j.assignee,
            (SELECT result_summary FROM job_attempts WHERE job_id = j.id ORDER BY attempt_number DESC LIMIT 1) as result_summary
          FROM jobs j
          WHERE j.parent_id = ${job.parent_id} AND j.id != ${jobId} AND j.project_id = ${job.project_id}
          ORDER BY j.created_at
        `
      : Promise.resolve([]);

    const [
      parent,
      children,
      siblings,
      dependencies,
      dependents,
      blocking,
      latestAttempt,
      latestRejectionReason,
    ] = await Promise.all([
      parentPromise,
      this.jobs.getChildren(jobId).then(sameProject),
      siblingsPromise,
      this.jobs.getDependencies(jobId).then(sameProject),
      this.jobs.getDependents(jobId).then(sameProject),
      this.jobs.getBlockingJobs(jobId).then(sameProject),
      this.jobs.getLatestAttempt(jobId),
      this.jobs.getLatestRejectionReason(jobId),
    ]);

    const latestAttemptContext = latestAttempt
      ? this.toAttemptContext(latestAttempt)
      : null;

    const resultJson = latestAttempt?.result_json;
    const eveStatus =
      !!resultJson && typeof resultJson === 'object'
        ? (resultJson as { eve?: { status?: unknown } }).eve?.status
        : undefined;
    const waiting =
      typeof eveStatus === 'string' && eveStatus.trim().toLowerCase() === 'waiting';
    const blocked = blocking.length > 0;
    const effectivePhase = blocked ? 'blocked' : waiting ? 'waiting' : job.phase;

    // Extract dispatch metadata from parent hints
    const parentHints = parent?.hints;
    const coordination = parentHints?.coordination as { thread_id?: string; dispatch_mode?: string } | undefined;

    return {
      job: this.toJobResponse(job),
      parent: parent ? this.toJobResponse(parent) : null,
      children: children.map(child => this.toJobResponse(child)),
      siblings: siblings.length > 0
        ? siblings.map(s => ({
            id: s.id,
            title: s.title,
            phase: s.phase,
            assignee: s.assignee,
            effective_phase: s.phase, // simplified — full computation not needed for siblings
            result_summary: s.result_summary,
          }))
        : undefined,
      relations: {
        dependencies: dependencies.map(dep => ({
          ...this.toJobResponse(dep),
          relation_type: dep.relation_type,
        })),
        dependents: dependents.map(dep => ({
          ...this.toJobResponse(dep),
          relation_type: dep.relation_type,
        })),
        blocking: blocking.map(dep => ({
          ...this.toJobResponse(dep),
          relation_type: dep.relation_type,
        })),
      },
      latest_attempt: latestAttemptContext,
      latest_rejection_reason: latestRejectionReason,
      blocked,
      waiting,
      effective_phase: effectivePhase,
      dispatch_thread_id: coordination?.thread_id ?? null,
      dispatch_mode: coordination?.dispatch_mode ?? null,
    };
  }

  // --------------------------------------------------------------------------
  // Supervision (long-poll)
  // --------------------------------------------------------------------------

  /**
   * Long-poll for child job transitions and coordination thread messages.
   * Returns immediately if events are found, otherwise polls DB every 2s until timeout.
   */
  async supervise(
    jobId: string,
    sinceCursor: string | undefined,
    timeoutSec: number,
  ): Promise<{
    events: Array<{ type: string; job_id?: string; phase?: string; timestamp: string }>;
    children: Array<{ id: string; title: string; phase: string; assignee: string | null }>;
    inbox: Array<{ id: string; actor_id: string | null; body: string; created_at: string }>;
    cursor: string;
  }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const since = sinceCursor ? new Date(sinceCursor) : new Date(Date.now() - 3600_000);
    const deadline = Date.now() + timeoutSec * 1000;
    const pollIntervalMs = 2000;

    // Get coordination thread ID from hints. Hints are caller-supplied, so the
    // thread is read only when it belongs to the job's own project.
    const coordination = job.hints?.coordination as { thread_id?: string } | undefined;
    let threadId: string | undefined;
    if (typeof coordination?.thread_id === 'string' && coordination.thread_id) {
      const [thread] = await this.db<Array<{ project_id: string | null }>>`
        SELECT project_id FROM threads WHERE id = ${coordination.thread_id} LIMIT 1
      `;
      if (thread?.project_id && thread.project_id === job.project_id) {
        threadId = coordination.thread_id;
      }
    }

    while (Date.now() < deadline) {
      // Query child jobs that changed phase since cursor
      const children = await this.db<Array<{
        id: string; title: string; phase: string; assignee: string | null; updated_at: Date;
      }>>`
        SELECT id, title, phase, assignee, updated_at
        FROM jobs
        WHERE parent_id = ${jobId} AND project_id = ${job.project_id}
        ORDER BY updated_at DESC
      `;

      const events: Array<{ type: string; job_id?: string; phase?: string; timestamp: string }> = [];
      for (const child of children) {
        if (child.updated_at > since) {
          events.push({
            type: 'child_update',
            job_id: child.id,
            phase: child.phase,
            timestamp: child.updated_at.toISOString(),
          });
        }
      }

      // Query coordination thread messages
      let inbox: Array<{ id: string; actor_id: string | null; body: string; created_at: string }> = [];
      if (threadId) {
        const messages = await this.threadMessages.listByThread(threadId, {
          since,
          limit: 50,
        });
        inbox = messages.map(m => ({
          id: m.id,
          actor_id: m.actor_id,
          body: m.body,
          created_at: m.created_at.toISOString(),
        }));
        if (inbox.length > 0) {
          events.push(...inbox.map(m => ({
            type: 'message',
            timestamp: m.created_at,
          })));
        }
      }

      if (events.length > 0) {
        const latestTimestamp = events
          .map(e => e.timestamp)
          .sort()
          .pop() ?? since.toISOString();
        return {
          events,
          children: children.map(c => ({
            id: c.id,
            title: c.title,
            phase: c.phase,
            assignee: c.assignee,
          })),
          inbox,
          cursor: latestTimestamp,
        };
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    // Timeout — return empty
    const children = await this.db<Array<{
      id: string; title: string; phase: string; assignee: string | null;
    }>>`
      SELECT id, title, phase, assignee
      FROM jobs
      WHERE parent_id = ${jobId} AND project_id = ${job.project_id}
      ORDER BY updated_at DESC
    `;
    return {
      events: [],
      children: children.map(c => ({
        id: c.id,
        title: c.title,
        phase: c.phase,
        assignee: c.assignee,
      })),
      inbox: [],
      cursor: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Dependency operations
  // --------------------------------------------------------------------------

  /**
   * Add a dependency to a job
   */
  async addDependency(jobId: string, data: AddDependencyRequest, caller?: AuthUser): Promise<{ success: boolean; message: string }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    this.assertEdgesFromDefinition(job);
    await this.guardRunJob(job, caller, 'add a dependency to');
    await this.guardDependencyChange(job, caller);
    await this.requireJobInProject(data.related_job_id, job.project_id);
    await this.jobs.addDependency(jobId, data.related_job_id, data.relation_type ?? 'blocks');
    return { success: true, message: `Added dependency: ${jobId} depends on ${data.related_job_id}` };
  }

  /**
   * Remove a dependency from a job
   */
  async removeDependency(jobId: string, relatedJobId: string, caller?: AuthUser): Promise<{ success: boolean; message: string }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    this.assertEdgesFromDefinition(job);
    await this.guardRunJob(job, caller, 'remove a dependency of');
    await this.guardDependencyChange(job, caller);
    const removed = await this.jobs.removeDependency(jobId, relatedJobId);
    if (!removed) {
      throw new NotFoundException(`Dependency from ${jobId} to ${relatedJobId} not found`);
    }
    return { success: true, message: `Removed dependency: ${jobId} no longer depends on ${relatedJobId}` };
  }

  /**
   * Get all dependencies for a job
   */
  async getDependencies(jobId: string): Promise<DependenciesResponse> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    // Only jobs from this job's own project are reported.
    const sameProject = <T extends { project_id: string }>(rows: T[]): T[] =>
      rows.filter((row) => row.project_id === job.project_id);
    const [dependencies, dependents, blocking] = await Promise.all([
      this.jobs.getDependencies(jobId).then(sameProject),
      this.jobs.getDependents(jobId).then(sameProject),
      this.jobs.getBlockingJobs(jobId).then(sameProject),
    ]);

    return {
      dependencies: dependencies.map(d => ({
        ...this.toJobResponse(d),
        relation_type: d.relation_type,
      })),
      dependents: dependents.map(d => ({
        ...this.toJobResponse(d),
        relation_type: d.relation_type,
      })),
      blocking: blocking.map(b => ({
        ...this.toJobResponse(b),
        relation_type: b.relation_type,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Claim/Release operations
  // --------------------------------------------------------------------------

  /**
   * Claim a job (creates attempt, transitions to active)
   *
   * If the job has gates defined in hints or targets a named environment,
   * the gates must be acquired first. Environment gates are automatically
   * added to prevent concurrent deployments to the same environment.
   *
   * If gates are blocked, returns a 409 Conflict with blocked_on_gates info.
   */
  async claim(jobId: string, data: ClaimRequest, caller?: AuthUser): Promise<{ attempt: JobAttemptResponse }> {
    // First get the job to check for gates
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.guardRunJob(job, caller, 'claim');

    const claimHarness = data.harness ?? job.harness ?? undefined;

    // Combine explicit gates from hints with implicit environment gate.
    // Only action jobs (deploy, build, migrate) acquire the env gate — ad-hoc
    // agent jobs use env_name for API resolution only, not mutual exclusion.
    const explicitGates = job.hints?.gates ?? [];
    const envGate = (job.env_name && job.action_type) ? [`env:${job.project_id}:${job.env_name}`] : [];
    const requiredGates = [...explicitGates, ...envGate];

    if (requiredGates.length > 0) {
      // Get timeout from hints, default to 30 minutes
      const ttlSeconds = job.hints?.timeout_seconds ?? 1800;

      // Try to acquire all gates
      const gateResult = await this.gates.acquireGates(
        jobId,
        requiredGates,
        ttlSeconds,
        { agent_id: data.agent_id, harness: claimHarness, env_name: job.env_name },
      );

      if (!gateResult.success) {
        // Update job with blocked_on_gates
        await this.gates.updateBlockedOnGates(jobId, gateResult.blocked_by);

        throw new ConflictException({
          message: 'Job blocked on gates',
          blocked_on_gates: gateResult.blocked_by,
          jobId,
        });
      }

      // Gates acquired - clear any previous blocked_on_gates
      await this.gates.clearBlockedOnGates(jobId);
    }

    // Proceed with claim
    const result = await this.jobs.claim(jobId, data.agent_id, claimHarness);
    if (!result.success || !result.attempt) {
      // If claim failed after acquiring gates, release them
      if (requiredGates.length > 0) {
        await this.gates.releaseGates(jobId);
      }
      throw new BadRequestException(result.error);
    }

    return { attempt: this.toAttemptResponse(result.attempt) };
  }

  /**
   * Release a job (ends attempt, transitions back to ready)
   *
   * Also releases any gates held by the job.
   */
  async release(jobId: string, data: ReleaseRequest, caller?: AuthUser): Promise<{ job: JobResponse }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.guardRunJob(job, caller, 'release');

    // Release any gates held by this job
    await this.gates.releaseGates(jobId);

    // Re-queueing runs the job again: a restricted releaser narrows it first.
    const result = await this.db.begin(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await this.narrowToCallerAllowlist(tx, jobId, caller);
      return jobQueries(tx).release(jobId, data.agent_id, data.reason);
    });
    if (!result.success || !result.job) {
      throw new BadRequestException(result.error);
    }
    return { job: this.toJobResponse(result.job) };
  }

  /**
   * List all attempts for a job
   */
  async listAttempts(jobId: string): Promise<{ attempts: JobAttemptResponse[] }> {
    const attempts = await this.jobs.listAttempts(jobId);
    return { attempts: attempts.map(a => this.toAttemptResponse(a)) };
  }

  /**
   * Get execution logs for a specific attempt
   */
  async getAttemptLogs(
    jobId: string,
    attemptNum: number,
    afterSeq?: number,
  ): Promise<{ logs: Array<{ sequence: number; timestamp: string; type: string; line: Record<string, unknown> }> }> {
    // Find the attempt by number
    const attempts = await this.jobs.listAttempts(jobId);
    const attempt = attempts.find(a => a.attempt_number === attemptNum);
    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptNum} not found for job ${jobId}`);
    }

    // Get logs for the attempt
    const executionLogs = await this.logs.listLogs(attempt.id, afterSeq);

    const logs = executionLogs.map((log) => {
      const content = log.content as Record<string, unknown>;
      const logType = log.type;
      return {
        sequence: log.seq,
        timestamp: (content.timestamp as string) || log.created_at.toISOString(),
        type: logType,
        line: content,
        text: renderLogText({ type: logType, line: content }),
      };
    });

    return { logs };
  }

  // ── SSE log streaming (delegated) ──────────────────────────────────
  // Implementations live in JobLogsService; these delegates keep the
  // public surface unchanged for controllers.

  streamAttemptLogs(jobId: string, attemptNum: number): Observable<MessageEvent> {
    return this.jobLogsService.streamAttemptLogs(jobId, attemptNum);
  }

  streamJobLogs(jobId: string): Observable<MessageEvent> {
    return this.jobLogsService.streamJobLogs(jobId);
  }

  // ── Results, receipts, attempt comparison (delegated) ──────────────
  // Implementations live in JobReceiptsService; these delegates keep the
  // public surface unchanged for controllers.

  async getJobResult(
    jobId: string,
    attemptNumber?: number,
    format?: 'full' | 'text',
  ): Promise<JobResultResponse> {
    return this.jobReceiptsService.getJobResult(jobId, attemptNumber, format);
  }

  async getJobReceipt(jobId: string, attemptNumber?: number): Promise<Record<string, unknown>> {
    return this.jobReceiptsService.getJobReceipt(jobId, attemptNumber);
  }

  async getAttemptReceipt(jobId: string, attemptId: string): Promise<Record<string, unknown>> {
    return this.jobReceiptsService.getAttemptReceipt(jobId, attemptId);
  }

  async compareAttempts(
    jobId: string,
    attemptA: number,
    attemptB: number,
    options?: { include_receipt?: boolean },
  ): Promise<JobCompareResponse> {
    return this.jobReceiptsService.compareAttempts(jobId, attemptA, attemptB, options);
  }

  // --------------------------------------------------------------------------
  // Review operations
  // --------------------------------------------------------------------------

  /**
   * Submit a job for review
   */
  async submit(jobId: string, data: SubmitRequest, caller?: AuthUser): Promise<JobResponse> {
    // Get the current job to find assignee for agent_id
    const currentJob = await this.jobs.findById(jobId);
    if (!currentJob) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.guardRunJob(currentJob, caller, 'submit');

    const agentId = data.agent_id ?? currentJob.assignee ?? 'unknown';
    try {
      const job = await this.jobs.submitForReview(jobId, agentId, data.summary);
      return this.toJobResponse(job);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Approve a job in review. The decider recorded is the caller (deciderOf),
   * never a reviewer named in the body. The decision is made once, in a
   * transaction holding the job's row: a review already decided gets 409.
   */
  async approve(jobId: string, data: ApproveRequest, caller?: AuthUser): Promise<JobResponse> {
    const current = await this.jobs.findById(jobId);
    if (!current) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.guardApprovalToken(current, caller, 'approve');
    await this.guardRunJob(current, caller, 'approve');
    const decider = deciderOf(caller);
    try {
      const job = await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        return jobQueries(tx).approveReview(jobId, decider.id, data.comment, decider.type, ...reviewedRound(data));
      });
      return this.toJobResponse(job as Job);
    } catch (error) {
      throw reviewDecisionError(error);
    }
  }

  /**
   * Narrow a job's secrets allowlist to a restricted caller's (a restricted
   * job's token), reading the stored list under a row lock so concurrent
   * narrowings intersect rather than overwrite. Nothing for other callers.
   */
  private async narrowToCallerAllowlist(tx: Db, jobId: string, caller?: AuthUser): Promise<void> {
    const callerAllowlist = workStartOptions(caller).secretsAllowlist ?? null;
    if (!callerAllowlist) return;
    const [row] = await tx<Array<{ secrets_allowlist: string[] | null }>>`
      SELECT secrets_allowlist FROM jobs WHERE id = ${jobId} FOR UPDATE
    `;
    if (!row) return;
    const narrowed = narrowSecretsAllowlist(row.secrets_allowlist ?? null, callerAllowlist);
    if (sameSecretsAllowlist(narrowed, row.secrets_allowlist ?? null)) return;
    await tx`UPDATE jobs SET secrets_allowlist = ${narrowed}, updated_at = NOW() WHERE id = ${jobId}`;
  }

  /**
   * Reject a job in review, which runs it again. The job keeps its actor, but
   * a rejecter with a secrets allowlist (a restricted job's token) narrows the
   * job to it, so rejecting cannot re-run work that receives more secrets. The
   * decider recorded is the caller, as on approve, and the decision is made
   * once: a review already decided gets 409 and no new attempt.
   */
  async reject(jobId: string, data: RejectRequest, caller?: AuthUser): Promise<JobResponse> {
    const current = await this.jobs.findById(jobId);
    if (!current) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    await this.guardApprovalToken(current, caller, 'reject');
    await this.guardRunJob(current, caller, 'reject');
    const decider = deciderOf(caller);
    try {
      const job = await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await this.narrowToCallerAllowlist(tx, jobId, caller);
        return jobQueries(tx).rejectReview(jobId, decider.id, data.reason, decider.type, ...reviewedRound(data));
      });
      return this.toJobResponse(job as Job);
    } catch (error) {
      throw reviewDecisionError(error);
    }
  }

  // --------------------------------------------------------------------------
  // Long-poll operations
  // --------------------------------------------------------------------------

  /**
   * Wait for a job to complete (long-poll)
   *
   * Blocks until the job reaches a terminal phase (done, failed, cancelled)
   * or the timeout expires. Polls every 2 seconds internally.
   *
   * Terminal phases:
   * - done: Job completed successfully
   * - failed: Job execution failed
   * - cancelled: Job was cancelled
   *
   * @param jobId - The job ID to wait for
   * @param timeoutSec - Maximum wait time in seconds (default: 30, max: 300)
   * @returns Result if completed, or timeout info if still running
   */
  async waitForJob(jobId: string, timeoutSec: number = 30): Promise<WaitForJobResponse> {
    // Clamp timeout to valid range
    const effectiveTimeout = Math.min(Math.max(timeoutSec, 1), 300);
    const startTime = Date.now();
    const deadline = startTime + effectiveTimeout * 1000;
    const pollIntervalMs = 2000;

    // Terminal phases - job has reached an end state
    // Note: 'failed' is not a valid job phase - failures are represented as 'cancelled' with a close_reason
    const terminalPhases = ['done', 'cancelled'];

    // First check - job must exist
    const initialJob = await this.jobs.findById(jobId);
    if (!initialJob) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    // Poll loop
    while (Date.now() < deadline) {
      const job = await this.jobs.findById(jobId);
      if (!job) {
        throw new NotFoundException(`Job ${jobId} not found`);
      }

      // Check if job has reached a terminal state
      if (terminalPhases.includes(job.phase)) {
        // Job reached terminal state - return the result
        // For failed/cancelled jobs, we still want to return what we can
        try {
          const result = await this.getJobResult(jobId);
          if (job.phase === 'cancelled' && result.exitCode == null) {
            return {
              completed: true,
              result: {
                ...result,
                status: 'cancelled',
                exitCode: 1,
                errorMessage: result.errorMessage ?? job.close_reason ?? 'Job cancelled',
              },
            };
          }
          return {
            completed: true,
            result,
          };
        } catch (error) {
          // If no attempt/result exists (e.g., cancelled before execution),
          // return a synthetic result
          return {
            completed: true,
            result: {
              jobId,
              status: job.phase,
              exitCode: job.phase === 'done' ? 0 : 1,
              resultText: job.close_reason ?? null,
              errorMessage: job.phase === 'cancelled' ? (job.close_reason ?? 'Job cancelled') : null,
            },
          };
        }
      }

      // Calculate remaining time
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      // Wait before next poll (but don't wait longer than remaining time)
      const waitTime = Math.min(pollIntervalMs, remaining);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Timeout - get current job state for response
    const finalJob = await this.jobs.findById(jobId);
    const elapsed = Date.now() - startTime;

    return {
      completed: false,
      jobId,
      status: 'timeout',
      phase: finalJob?.phase ?? 'unknown',
      elapsed,
      message: 'Job still running, request timed out',
    };
  }

  // --------------------------------------------------------------------------
  // Batch operations (delegated)
  // --------------------------------------------------------------------------
  // Implementations live in JobBatchService; these delegates keep the
  // public surface unchanged for controllers.

  async validateBatch(projectId: string, request: CreateBatchRequest): Promise<BatchValidateResponse> {
    return this.jobBatchService.validateBatch(projectId, request);
  }

  async createBatch(
    projectId: string,
    request: CreateBatchRequest,
    correlationId?: string,
    userId?: string,
    options: WorkStartOptions = {},
  ): Promise<CreateBatchResponse> {
    return this.jobBatchService.createBatch(projectId, request, correlationId, userId, options);
  }

  // --------------------------------------------------------------------------
  // Response transformers
  // --------------------------------------------------------------------------

  private toJobResponse(job: Job): JobResponse {
    return {
      id: job.id,
      project_id: job.project_id,
      parent_id: job.parent_id,
      depth: job.depth,
      title: job.title,
      description: sanitizeJobText(job.description),
      issue_type: job.issue_type,
      labels: job.labels,
      phase: job.phase,
      priority: job.priority,
      assignee: job.assignee,
      review_required: job.review_required,
      review_status: job.review_status,
      reviewer: job.reviewer,
      defer_until: job.defer_until?.toISOString() ?? null,
      due_at: job.due_at?.toISOString() ?? null,
      ready_at: job.ready_at?.toISOString() ?? null,
      harness: job.harness,
      harness_profile: job.harness_profile,
      harness_options: job.harness_options as JobHarnessOptions | null,
      harness_profile_override: job.harness_profile_override ?? null,
      env_overrides: job.env_overrides ?? null,
      token_scope: job.token_scope ?? null,
      token_permissions: job.token_permissions ?? null,
      secrets_allowlist: job.secrets_allowlist ?? null,
      harness_profile_source: job.harness_profile_source ?? null,
      harness_profile_hash: job.harness_profile_hash ?? null,
      hints: job.hints,
      git: job.git_json as JobGit | null,
      resolved_git: job.resolved_git_json ?? undefined,
      workspace: job.workspace_json as JobWorkspace | null,
      blocked_on_gates: job.blocked_on_gates ?? [],
      target: job.target as JobTarget | null,
      resource_refs: (job.resource_refs ?? []) as ResourceRef[],
      env_name: job.env_name,
      execution_mode: job.execution_mode,
      execution_type: job.execution_type,
      run_id: job.run_id,
      step_name: job.step_name,
      action_type: job.action_type,
      action_input: job.action_input,
      script_command: job.script_command,
      script_timeout_seconds: job.script_timeout_seconds,
      content_hash: job.content_hash,
      actor_user_id: job.actor_user_id,
      failure_disposition: job.failure_disposition,
      created_at: job.created_at.toISOString(),
      updated_at: job.updated_at.toISOString(),
      closed_at: job.closed_at?.toISOString() ?? null,
      close_reason: job.close_reason,
    };
  }

  private toAttemptResponse(attempt: JobAttempt): JobAttemptResponse {
    return {
      id: attempt.id,
      job_id: attempt.job_id,
      attempt_number: attempt.attempt_number,
      status: attempt.status,
      trigger_type: attempt.trigger_type,
      harness: attempt.harness,
      agent_id: attempt.agent_id,
      started_at: attempt.started_at.toISOString(),
      execution_started_at: attempt.execution_started_at?.toISOString() ?? null,
      ended_at: attempt.ended_at?.toISOString() ?? null,
      result_summary: attempt.result_summary,
      runtime_meta: attempt.runtime_meta,
      // Git controls resolved metadata
      git: attempt.git_json ?? undefined,
      // Result columns
      exit_code: attempt.exit_code,
      result_text: attempt.result_text,
      result_json: attempt.result_json,
      duration_ms: attempt.duration_ms,
      token_input: attempt.token_input,
      token_output: attempt.token_output,
      error_message: attempt.error_message,
      harness_profile_source: attempt.harness_profile_source,
      harness_profile_hash: attempt.harness_profile_hash,
    };
  }

  private toAttemptContext(attempt: JobAttempt): JobAttemptContext {
    return {
      id: attempt.id,
      attempt_number: attempt.attempt_number,
      status: attempt.status,
      result_summary: attempt.result_summary,
      result_json: attempt.result_json,
      git: attempt.git_json ?? undefined,
    };
  }
}

function sanitizeJobText(value: string | null): string | null {
  if (!value) {
    return value;
  }

  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, MessageEvent } from '@nestjs/common';
import { Observable, interval, from, of, EMPTY } from 'rxjs';
import { switchMap, concatMap, takeWhile, share } from 'rxjs/operators';
import type { Db } from '@eve/db';
import { jobQueries, projectQueries, executionLogQueries, gateQueries, projectManifestQueries, threadMessageQueries, spendQueries, environmentQueries, agentQueries, batchJobQueries, projectApiSourceQueries, orgQueries, agentConfigQueries, appLinkSubscriptionQueries, type Job, type JobAttempt, type JobHints, type AttemptResultData, type JobGitConfig, type JobWorkspaceConfig, type JobAttemptGitMeta } from '@eve/db';
import type { AccessBindingScope, JobGit, JobWorkspace, JobHarnessOptions, JobCompareResponse, JobTarget, ResourceRef, CreateBatchRequest, CreateBatchResponse, BatchValidateResponse, BatchValidationError, InlineProfileBundle } from '@eve/shared';
import { parseResourceUri, defaultMountPathForUri, isValidMountPath, generateBatchId, renderLogText, buildAppApiInstructionBlock, getServicesFromManifest, resolveHarnessProfile as sharedResolveHarnessProfile, type AppApiCliInfo, type AppApiInfo, type HarnessProfileSource } from '@eve/shared';
import * as yaml from 'yaml';
import { buildApiError } from '../system/api-errors.js';

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

export interface JobResponse extends Omit<Job, 'created_at' | 'updated_at' | 'defer_until' | 'due_at' | 'ready_at' | 'closed_at' | 'git_json' | 'resolved_git_json' | 'workspace_json' | 'target' | 'resource_refs'> {
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
  reviewer_id: string;
  comment?: string;
}

export interface RejectRequest {
  reviewer_id: string;
  reason: string;
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

@Injectable()
export class JobsService {
  private jobs: ReturnType<typeof jobQueries>;
  private projects: ReturnType<typeof projectQueries>;
  private logs: ReturnType<typeof executionLogQueries>;
  private gates: ReturnType<typeof gateQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private threadMessages: ReturnType<typeof threadMessageQueries>;
  private spend: ReturnType<typeof spendQueries>;
  private environments: ReturnType<typeof environmentQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private batchJobs: ReturnType<typeof batchJobQueries>;
  private apiSources: ReturnType<typeof projectApiSourceQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.jobs = jobQueries(db);
    this.projects = projectQueries(db);
    this.logs = executionLogQueries(db);
    this.gates = gateQueries(db);
    this.manifests = projectManifestQueries(db);
    this.threadMessages = threadMessageQueries(db);
    this.spend = spendQueries(db);
    this.environments = environmentQueries(db);
    this.agents = agentQueries(db);
    this.batchJobs = batchJobQueries(db);
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
      const namespace = `eve-${producerOrg.slug}-${producerProject.slug}-${producerEnv}`;
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

        const namespace = `eve-${org.slug}-${project.slug}-${activeEnv.name}`;
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
   * Create a new job in a project
   */
  async create(projectId: string, data: CreateJobRequest, userId?: string, requestId?: string): Promise<JobResponse> {
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
      actor_user_id: userId ?? null,
      failure_disposition: null,
      closed_at: null,
      close_reason: null,
    });

    return this.toJobResponse(job);
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
  async update(jobId: string, updates: UpdateJobRequest): Promise<JobResponse> {
    const currentJob = await this.jobs.findById(jobId);
    if (!currentJob) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    // Handle phase transitions through updatePhase for validation
    if (updates.phase && updates.phase !== currentJob.phase) {
      if (updates.phase === 'cancelled') {
        const cancelled = await this.jobs.cancelJob(jobId, updates.close_reason ?? undefined);
        if (!cancelled) {
          throw new NotFoundException(`Job ${jobId} not found`);
        }
      } else {
        const result = await this.jobs.updatePhase(jobId, updates.phase);
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
        ? (updates.harness_options as Parameters<typeof this.db.json>[0])
        : null;

      // For fields that might be explicitly set to null, we need conditional SQL
      // Using a simpler approach: just update what was provided
      await this.db`
        UPDATE jobs
        SET
          title = COALESCE(${title}, title),
          description = ${updates.description !== undefined ? description : this.db`description`},
          labels = COALESCE(${labels}, labels),
          priority = COALESCE(${priority}, priority),
          assignee = ${updates.assignee !== undefined ? assignee : this.db`assignee`},
          review_required = COALESCE(${reviewRequired}, review_required),
          defer_until = ${updates.defer_until !== undefined ? deferUntil : this.db`defer_until`},
          due_at = ${updates.due_at !== undefined ? dueAt : this.db`due_at`},
          close_reason = ${updates.close_reason !== undefined ? closeReason : this.db`close_reason`},
          harness = ${updates.harness !== undefined ? harness : this.db`harness`},
          harness_profile = ${updates.harness_profile !== undefined ? harnessProfile : this.db`harness_profile`},
          harness_options = ${updates.harness_options !== undefined
            ? this.db.json(harnessOptions)
            : this.db`harness_options`},
          hints = ${updates.hints !== undefined ? this.db.json(updates.hints as never) : this.db`hints`},
          git_json = ${updates.git !== undefined ? this.db.json(updates.git) : this.db`git_json`},
          workspace_json = ${updates.workspace !== undefined ? this.db.json(updates.workspace) : this.db`workspace_json`},
          env_name = ${updates.env_name !== undefined ? updates.env_name : this.db`env_name`},
          execution_mode = ${updates.execution_mode !== undefined ? updates.execution_mode : this.db`execution_mode`},
          updated_at = NOW()
        WHERE id = ${jobId}
      `;
    }

    // Re-fetch the updated job
    const updatedJob = await this.jobs.findById(jobId);
    if (!updatedJob) {
      throw new NotFoundException(`Job ${jobId} not found after update`);
    }

    return this.toJobResponse(updatedJob);
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
    const jobs = await this.jobs.getHierarchy(jobId);
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

    const parentPromise = job.parent_id ? this.jobs.findById(job.parent_id) : Promise.resolve(null);

    // Fetch siblings if this is a child job
    const siblingsPromise = job.parent_id
      ? this.db<Array<{
          id: string; title: string; phase: string; assignee: string | null;
          result_summary: string | null;
        }>>`
          SELECT j.id, j.title, j.phase, j.assignee,
            (SELECT result_summary FROM job_attempts WHERE job_id = j.id ORDER BY attempt_number DESC LIMIT 1) as result_summary
          FROM jobs j
          WHERE j.parent_id = ${job.parent_id} AND j.id != ${jobId}
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
      this.jobs.getChildren(jobId),
      siblingsPromise,
      this.jobs.getDependencies(jobId),
      this.jobs.getDependents(jobId),
      this.jobs.getBlockingJobs(jobId),
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

    // Get coordination thread ID from hints
    const coordination = job.hints?.coordination as { thread_id?: string } | undefined;
    const threadId = coordination?.thread_id;

    while (Date.now() < deadline) {
      // Query child jobs that changed phase since cursor
      const children = await this.db<Array<{
        id: string; title: string; phase: string; assignee: string | null; updated_at: Date;
      }>>`
        SELECT id, title, phase, assignee, updated_at
        FROM jobs
        WHERE parent_id = ${jobId}
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
      WHERE parent_id = ${jobId}
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
  async addDependency(jobId: string, data: AddDependencyRequest): Promise<{ success: boolean; message: string }> {
    await this.jobs.addDependency(jobId, data.related_job_id, data.relation_type ?? 'blocks');
    return { success: true, message: `Added dependency: ${jobId} depends on ${data.related_job_id}` };
  }

  /**
   * Remove a dependency from a job
   */
  async removeDependency(jobId: string, relatedJobId: string): Promise<{ success: boolean; message: string }> {
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
    const [dependencies, dependents, blocking] = await Promise.all([
      this.jobs.getDependencies(jobId),
      this.jobs.getDependents(jobId),
      this.jobs.getBlockingJobs(jobId),
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
  async claim(jobId: string, data: ClaimRequest): Promise<{ attempt: JobAttemptResponse }> {
    // First get the job to check for gates
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

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
  async release(jobId: string, data: ReleaseRequest): Promise<{ job: JobResponse }> {
    // Release any gates held by this job
    await this.gates.releaseGates(jobId);

    const result = await this.jobs.release(jobId, data.agent_id, data.reason);
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

  /**
   * Stream execution logs for a specific attempt (SSE)
   *
   * Polls for new logs every second and emits them as SSE events.
   * Emits 'complete' or 'error' event when the attempt finishes.
   */
  streamAttemptLogs(jobId: string, attemptNum: number): Observable<MessageEvent> {
    let lastSequence = 0;
    let isComplete = false;

    return interval(1000).pipe(
      // Fetch new logs and attempt status
      switchMap(() =>
        from(
          (async () => {
            // Find the attempt by number
            const attempts = await this.jobs.listAttempts(jobId);
            const attempt = attempts.find(a => a.attempt_number === attemptNum);
            if (!attempt) {
              throw new NotFoundException(`Attempt ${attemptNum} not found for job ${jobId}`);
            }

            // Get logs since lastSequence
            const executionLogs = await this.logs.listLogs(attempt.id, lastSequence);

            return { logs: executionLogs, attempt };
          })()
        )
      ),
      // Emit log events and check completion
      concatMap(({ logs, attempt }) => {
        const events: MessageEvent[] = [];

        // Emit each new log as a 'log' event
        for (const log of logs) {
          const content = log.content as Record<string, unknown>;
          const logType = log.type;
          lastSequence = log.seq;

          events.push({
            type: 'log',
            data: {
              sequence: log.seq,
              timestamp: (content.timestamp as string) || log.created_at.toISOString(),
              type: logType,
              line: content,
              text: renderLogText({ type: logType, line: content }),
            },
          });
        }

        // Check if attempt has finished
        if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'cancelled') {
          isComplete = true;

          if (attempt.status === 'succeeded') {
            events.push({
              type: 'complete',
              data: {
                status: 'succeeded',
                exitCode: attempt.exit_code ?? 0,
                resultText: attempt.result_text ?? null,
              },
            });
          } else {
            events.push({
              type: 'error',
              data: {
                status: attempt.status,
                exitCode: attempt.exit_code ?? 1,
                errorMessage: attempt.error_message ?? null,
              },
            });
          }
        }

        return from(events);
      }),
      // Keep the stream alive until complete
      takeWhile(() => !isComplete, true),
      share()
    );
  }

  /**
   * Stream execution logs for the current/latest attempt of a job (SSE)
   *
   * Convenience endpoint that finds the latest attempt and streams its logs.
   */
  streamJobLogs(jobId: string): Observable<MessageEvent> {
    // We need to find the current attempt number first
    // Then delegate to streamAttemptLogs
    let attemptNumResolved = false;
    let resolvedAttemptNum = 0;
    let lastSequence = 0;
    let isComplete = false;

    return interval(1000).pipe(
      // Fetch new logs and attempt status
      switchMap(() =>
        from(
          (async () => {
            // Get attempts to find the current one
            const attempts = await this.jobs.listAttempts(jobId);
            if (attempts.length === 0) {
              throw new NotFoundException(`No attempts found for job ${jobId}`);
            }

            // Use the latest attempt (first in list, sorted by attempt_number desc)
            const attempt = attempts[0];
            resolvedAttemptNum = attempt.attempt_number;
            attemptNumResolved = true;

            // Get logs since lastSequence
            const executionLogs = await this.logs.listLogs(attempt.id, lastSequence);

            return { logs: executionLogs, attempt };
          })()
        )
      ),
      // Emit log events and check completion
      concatMap(({ logs, attempt }) => {
        const events: MessageEvent[] = [];

        // Emit each new log as a 'log' event
        for (const log of logs) {
          const content = log.content as Record<string, unknown>;
          const logType = log.type;
          lastSequence = log.seq;

          events.push({
            type: 'log',
            data: {
              sequence: log.seq,
              timestamp: (content.timestamp as string) || log.created_at.toISOString(),
              type: logType,
              line: content,
              text: renderLogText({ type: logType, line: content }),
            },
          });
        }

        // Check if attempt has finished
        if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'cancelled') {
          isComplete = true;

          if (attempt.status === 'succeeded') {
            events.push({
              type: 'complete',
              data: {
                status: 'succeeded',
                exitCode: attempt.exit_code ?? 0,
                resultText: attempt.result_text ?? null,
              },
            });
          } else {
            events.push({
              type: 'error',
              data: {
                status: attempt.status,
                exitCode: attempt.exit_code ?? 1,
                errorMessage: attempt.error_message ?? null,
              },
            });
          }
        }

        return from(events);
      }),
      // Keep the stream alive until complete
      takeWhile(() => !isComplete, true),
      share()
    );
  }

  /**
   * Get job result (from latest or specific attempt)
   */
  async getJobResult(
    jobId: string,
    attemptNumber?: number,
    format?: 'full' | 'text',
  ): Promise<JobResultResponse> {
    // 1. Find the job
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    // 2. Get the attempt (latest or specified)
    const attempts = await this.jobs.listAttempts(jobId);
    if (attempts.length === 0) {
      throw new NotFoundException('No attempts found for this job');
    }

    const attempt = attemptNumber
      ? attempts.find(a => a.attempt_number === attemptNumber)
      : attempts[0]; // listAttempts returns descending by attempt_number, so [0] is latest

    if (!attempt) {
      throw new NotFoundException(`Attempt ${attemptNumber} not found for job ${jobId}`);
    }

    // 3. Check if still running
    if (attempt.status === 'running' || attempt.status === 'pending') {
      throw new ConflictException({
        message: 'Job is still running',
        phase: job.phase,
        status: attempt.status,
      });
    }

    // 4. Get result data
    const result = await this.jobs.getAttemptResult(attempt.id);

    // 5. Return based on format
    if (format === 'text') {
      return { resultText: result?.resultText ?? null };
    }

    return {
      jobId,
      attemptId: attempt.id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      exitCode: result?.exitCode ?? null,
      resultText: result?.resultText ?? null,
      resultJson: result?.resultJson ?? null,
      durationMs: result?.durationMs ?? null,
      tokenUsage: result ? {
        input: result.tokenInput,
        output: result.tokenOutput,
      } : null,
      errorMessage: result?.errorMessage ?? null,
      git: attempt.git_json ?? undefined,
    };
  }

  async getJobReceipt(jobId: string, attemptNumber?: number): Promise<Record<string, unknown>> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const [row] = attemptNumber
      ? await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
          SELECT receipt_json
          FROM job_attempts
          WHERE job_id = ${jobId} AND attempt_number = ${attemptNumber}
          LIMIT 1
        `
      : await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
          SELECT receipt_json
          FROM job_attempts
          WHERE job_id = ${jobId}
          ORDER BY attempt_number DESC
          LIMIT 1
        `;

    if (!row) {
      throw new NotFoundException(`Attempt not found for job ${jobId}`);
    }
    if (!row.receipt_json) {
      throw new NotFoundException(`Receipt not found for job ${jobId}`);
    }

    return row.receipt_json;
  }

  async getAttemptReceipt(jobId: string, attemptId: string): Promise<Record<string, unknown>> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const [row] = await this.db<{ receipt_json: Record<string, unknown> | null }[]>`
      SELECT receipt_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND id = ${attemptId}::uuid
      LIMIT 1
    `;

    if (!row) {
      throw new NotFoundException(`Attempt not found: ${attemptId}`);
    }
    if (!row.receipt_json) {
      throw new NotFoundException(`Receipt not found for attempt ${attemptId}`);
    }

    return row.receipt_json;
  }

  async compareAttempts(
    jobId: string,
    attemptA: number,
    attemptB: number,
    options?: { include_receipt?: boolean },
  ): Promise<JobCompareResponse> {
    if (!Number.isFinite(attemptA) || !Number.isFinite(attemptB)) {
      throw new BadRequestException('Attempt numbers must be integers');
    }
    const a = Math.max(1, Math.floor(attemptA));
    const b = Math.max(1, Math.floor(attemptB));
    if (a === b) {
      throw new BadRequestException('Attempt numbers must be different');
    }

    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    const result = await this.spend.compareAttempts(jobId, a, b);
    const includeReceipt = options?.include_receipt ?? false;

    return {
      job_id: jobId,
      attempts: result.attempts.map((entry) => ({
        attempt_number: entry.attempt_number,
        status: entry.status,
        started_at: entry.started_at,
        ended_at: entry.ended_at,
        base_total_usd: entry.base_total_usd,
        billed_total: entry.billed_total,
        billed_currency: entry.billed_currency,
        ...(includeReceipt ? { receipt: entry.receipt_json } : {}),
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Review operations
  // --------------------------------------------------------------------------

  /**
   * Submit a job for review
   */
  async submit(jobId: string, data: SubmitRequest): Promise<JobResponse> {
    // Get the current job to find assignee for agent_id
    const currentJob = await this.jobs.findById(jobId);
    if (!currentJob) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const agentId = data.agent_id ?? currentJob.assignee ?? 'unknown';
    try {
      const job = await this.jobs.submitForReview(jobId, agentId, data.summary);
      return this.toJobResponse(job);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Approve a job in review
   */
  async approve(jobId: string, data: ApproveRequest): Promise<JobResponse> {
    try {
      const job = await this.jobs.approveReview(jobId, data.reviewer_id, data.comment);
      return this.toJobResponse(job);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Reject a job in review
   */
  async reject(jobId: string, data: RejectRequest): Promise<JobResponse> {
    try {
      const job = await this.jobs.rejectReview(jobId, data.reviewer_id, data.reason);
      return this.toJobResponse(job);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
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
  // Batch operations
  // --------------------------------------------------------------------------

  /**
   * Validate a batch job graph without creating any jobs.
   *
   * Checks for duplicate keys, unknown parent/dependency references,
   * cycles in the dependency graph, and max nesting depth.
   */
  async validateBatch(_projectId: string, request: CreateBatchRequest): Promise<BatchValidateResponse> {
    const errors: BatchValidationError[] = [];

    // 1. Check for duplicate keys
    const keys = request.nodes.map(n => n.key);
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) {
        errors.push({ code: 'batch_node_duplicate', node_key: k, message: `Duplicate node key: ${k}` });
      }
      seen.add(k);
    }

    // 2. Verify parent references exist in nodes
    for (const node of request.nodes) {
      if (node.parent && !seen.has(node.parent)) {
        errors.push({
          code: 'batch_node_unknown',
          node_key: node.key,
          field: 'parent',
          message: `Unknown parent key: ${node.parent}`,
          hint: `Use one of: ${keys.join(', ')}`,
        });
      }
    }

    // 3. Verify dependency references
    for (const dep of request.dependencies) {
      if (!seen.has(dep.job)) {
        errors.push({
          code: 'batch_node_unknown',
          field: 'dependencies',
          message: `Unknown job key: ${dep.job}`,
        });
      }
      for (const d of dep.depends_on) {
        if (!seen.has(d)) {
          errors.push({
            code: 'batch_node_unknown',
            node_key: dep.job,
            field: 'dependencies',
            message: `Unknown dependency key: ${d}`,
            hint: `Use one of: ${keys.join(', ')}`,
          });
        }
      }
    }

    // 4. Check for cycles (only if no reference errors above)
    if (errors.length === 0) {
      const graph = new Map<string, string[]>();
      for (const node of request.nodes) graph.set(node.key, []);
      for (const dep of request.dependencies) {
        graph.get(dep.job)?.push(...dep.depends_on);
      }
      // Parent edges: child implicitly depends on parent
      for (const node of request.nodes) {
        if (node.parent) graph.get(node.key)?.push(node.parent);
      }

      if (hasCycle(graph)) {
        errors.push({ code: 'batch_graph_cycle', message: 'Dependency graph contains a cycle' });
      }
    }

    // 5. Check max nesting depth (max 3 levels of parent nesting)
    if (errors.length === 0) {
      const parentMap = new Map<string, string | undefined>();
      for (const node of request.nodes) {
        parentMap.set(node.key, node.parent);
      }
      for (const node of request.nodes) {
        let depth = 0;
        let cursor: string | undefined = node.parent;
        while (cursor) {
          depth++;
          if (depth > 3) {
            errors.push({
              code: 'batch_depth_exceeded',
              node_key: node.key,
              message: `Node "${node.key}" exceeds max nesting depth of 3`,
            });
            break;
          }
          cursor = parentMap.get(cursor);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Create an entire job tree atomically: validate, create batch record,
   * create jobs in topological order, wire parent/dependency edges.
   */
  async createBatch(
    projectId: string,
    request: CreateBatchRequest,
    correlationId?: string,
    userId?: string,
  ): Promise<CreateBatchResponse> {
    // 1. Validate the graph
    const validation = await this.validateBatch(projectId, request);
    if (!validation.valid) {
      throw new BadRequestException({
        error: { code: 'batch_validation_failed', errors: validation.errors },
      });
    }

    // 2. Resolve project
    const resolvedProjectId = await this.resolveProject(projectId);
    const project = await this.projects.findById(resolvedProjectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // 3. Check idempotency
    if (request.idempotency_key) {
      const existing = await this.batchJobs.findByIdempotencyKey(resolvedProjectId, request.idempotency_key);
      if (existing) {
        return this.reconstructBatchResult(existing.id, request);
      }
    }

    // 4. Create batch record
    const batchId = generateBatchId();
    await this.batchJobs.create({
      id: batchId,
      project_id: resolvedProjectId,
      idempotency_key: request.idempotency_key ?? null,
      node_count: request.nodes.length,
      created_by: correlationId ?? null,
    });

    // 5. Topological sort - create parents before children, dependencies before dependents
    const sorted = topologicalSort(request);

    // 6. Create jobs in order, collecting key -> jobId mapping
    const keyToJobId = new Map<string, string>();
    const keyToPhase = new Map<string, string>();

    for (const nodeKey of sorted) {
      const node = request.nodes.find(n => n.key === nodeKey)!;

      // Resolve parent ID from the key mapping
      const parentJobId = node.parent ? keyToJobId.get(node.parent) ?? null : null;

      // Generate job ID
      const { id: jobId, projectId: resolvedId } = await this.jobs.generateJobId(
        resolvedProjectId,
        parentJobId ?? undefined,
      );

      // Calculate depth
      const depth = parentJobId ? parentJobId.split('.').length : 0;

      // Determine initial phase: if this node has dependencies, start as 'backlog'
      const hasDeps = request.dependencies.some(d => d.job === nodeKey && d.depends_on.length > 0);
      const phase = hasDeps ? 'backlog' : 'ready';

      // Auto-generate title from description if not provided
      const title = node.title;

      // Create the job
      await this.jobs.create({
        id: jobId,
        project_id: resolvedId,
        parent_id: parentJobId,
        depth,
        title,
        description: node.description ?? title,
        issue_type: node.type === 'epic' ? 'epic' : 'task',
        labels: [],
        phase,
        priority: 2,
        assignee: null,
        review_required: 'none',
        review_status: null,
        reviewer: null,
        defer_until: null,
        due_at: null,
        hints: node.hints as JobHints ?? {},
        harness: null,
        harness_profile: null,
        harness_options: null,
        harness_profile_override: null,
        env_overrides: null,
        token_scope: null,
        token_permissions: null,
        harness_profile_source: null,
        harness_profile_hash: null,
        git_json: node.git ? node.git as unknown as JobGitConfig : null,
        resolved_git_json: null,
        workspace_json: null,
        blocked_on_gates: [],
        env_name: null,
        execution_mode: 'persistent',
        execution_type: 'agent',
        run_id: null,
        step_name: null,
        action_type: null,
        action_input: null,
        script_command: null,
        script_timeout_seconds: null,
        target: node.target ?? null,
        resource_refs: node.resource_refs ?? [],
        content_hash: null,
        actor_user_id: userId ?? null,
        failure_disposition: null,
        closed_at: null,
        close_reason: null,
      });

      // Tag the job with batch metadata
      await this.db`
        UPDATE jobs
        SET batch_id = ${batchId}, batch_key = ${node.key}
        WHERE id = ${jobId}
      `;

      keyToJobId.set(nodeKey, jobId);
      keyToPhase.set(nodeKey, phase);
    }

    // 7. Wire explicit dependencies
    const depsByKey = new Map<string, string[]>();
    for (const dep of request.dependencies) {
      for (const dependsOnKey of dep.depends_on) {
        const fromJobId = keyToJobId.get(dep.job)!;
        const toJobId = keyToJobId.get(dependsOnKey)!;
        await this.jobs.addDependency(fromJobId, toJobId, 'blocks');

        if (!depsByKey.has(dep.job)) depsByKey.set(dep.job, []);
        depsByKey.get(dep.job)!.push(dependsOnKey);
      }
    }

    // 8. Build response
    const jobs: Record<string, { job_id: string; phase: string; blocked_by?: string[] }> = {};
    for (const node of request.nodes) {
      const blockedBy = depsByKey.get(node.key);
      jobs[node.key] = {
        job_id: keyToJobId.get(node.key)!,
        phase: keyToPhase.get(node.key)!,
        ...(blockedBy && blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      };
    }

    return {
      batch_id: batchId,
      idempotency_key: request.idempotency_key ?? null,
      jobs,
    };
  }

  /**
   * Reconstruct a batch result from existing jobs (for idempotency).
   */
  private async reconstructBatchResult(
    batchId: string,
    request: CreateBatchRequest,
  ): Promise<CreateBatchResponse> {
    const batchJobs = await this.db<Array<{ id: string; batch_key: string; phase: string }>>`
      SELECT id, batch_key, phase FROM jobs
      WHERE batch_id = ${batchId}
      ORDER BY created_at ASC
    `;

    const depsByKey = new Map<string, string[]>();
    for (const dep of request.dependencies) {
      depsByKey.set(dep.job, dep.depends_on);
    }

    const jobs: Record<string, { job_id: string; phase: string; blocked_by?: string[] }> = {};
    for (const bj of batchJobs) {
      if (!bj.batch_key) continue;
      const blockedBy = depsByKey.get(bj.batch_key);
      jobs[bj.batch_key] = {
        job_id: bj.id,
        phase: bj.phase,
        ...(blockedBy && blockedBy.length > 0 ? { blocked_by: blockedBy } : {}),
      };
    }

    const batch = await this.batchJobs.findById(batchId);

    return {
      batch_id: batchId,
      idempotency_key: batch?.idempotency_key ?? null,
      jobs,
    };
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

// ============================================================================
// Batch Graph Helpers
// ============================================================================

/**
 * Detect whether a directed graph contains a cycle using iterative DFS.
 *
 * Each node can be in one of three states:
 *   0 = unvisited, 1 = in-progress (on current DFS stack), 2 = finished
 *
 * A back-edge to an in-progress node means a cycle exists.
 */
function hasCycle(graph: Map<string, string[]>): boolean {
  const state = new Map<string, number>(); // 0=unvisited, 1=in-progress, 2=done
  for (const key of graph.keys()) state.set(key, 0);

  for (const start of graph.keys()) {
    if (state.get(start) !== 0) continue;

    // Iterative DFS using an explicit stack
    const stack: Array<{ node: string; idx: number }> = [{ node: start, idx: 0 }];
    state.set(start, 1);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = graph.get(top.node) ?? [];

      if (top.idx < neighbors.length) {
        const next = neighbors[top.idx];
        top.idx++;

        const nextState = state.get(next) ?? 0;
        if (nextState === 1) return true; // back-edge -> cycle
        if (nextState === 0) {
          state.set(next, 1);
          stack.push({ node: next, idx: 0 });
        }
      } else {
        state.set(top.node, 2);
        stack.pop();
      }
    }
  }

  return false;
}

/**
 * Topological sort of batch nodes.
 *
 * Produces an ordering where every parent appears before its children
 * and every dependency appears before the nodes that depend on it.
 * Uses Kahn's algorithm (BFS-based) for clarity.
 */
function topologicalSort(request: CreateBatchRequest): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // prerequisite -> dependents

  for (const node of request.nodes) {
    inDegree.set(node.key, 0);
    adjacency.set(node.key, []);
  }

  // Parent edges: parent must be created before child
  for (const node of request.nodes) {
    if (node.parent) {
      adjacency.get(node.parent)!.push(node.key);
      inDegree.set(node.key, (inDegree.get(node.key) ?? 0) + 1);
    }
  }

  // Dependency edges: depends_on must be created before job
  for (const dep of request.dependencies) {
    for (const dependsOn of dep.depends_on) {
      adjacency.get(dependsOn)!.push(dep.job);
      inDegree.set(dep.job, (inDegree.get(dep.job) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

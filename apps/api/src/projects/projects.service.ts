import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  projectQueries,
  orgQueries,
  projectManifestQueries,
  membershipQueries,
  userQueries,
  releaseQueries,
  agentConfigQueries,
  agentQueries,
  teamQueries,
  teamMemberQueries,
  threadQueries,
  scheduleQueries,
  spendQueries,
  environmentQueries,
  ingressAliasQueries,
  customDomainQueries,
  appLinkGrantQueries,
  appLinkSubscriptionQueries,
  type Project,
  type ProjectAppLinkGrant,
} from '@eve/db';
import {
  generateProjectId,
  generateManifestId,
  generateAgentConfigId,
  generateEnvironmentId,
  generateIngressAliasId,
  type CreateProjectRequest,
  type EnsureProjectRequest,
  type ProjectListResponse,
  type ProjectResponse,
  type UpdateProjectRequest,
  type SyncManifestRequest,
  type ManifestResponse,
  type ManifestValidateRequest,
  type ManifestValidateResponse,
  type AgentsSyncRequest,
  type AgentsSyncResponse,
  type AgentsConfigResponse,
  type TeamListResponse,
  type RouteListResponse,
  type ThreadListResponse,
  type ScheduleListResponse,
  type CreateScheduleRequest,
  type ScheduleResponse,
  type ReleaseResponse,
  type ReleaseListResponse,
  type ProjectMemberRequest,
  type ProjectMemberResponse,
  type ProjectMemberListResponse,
  generateUserId,
  ManifestSchema,
  AgentsYamlSchema,
  TeamsYamlSchema,
  ChatYamlSchema,
  getManifestDefaults,
  getManifestRequiredSecrets,
  type SecretValidationResult,
  getManifestAgents,
  getManifestBranding,
  getManifestAuthConfig,
  getServicesFromManifest,
  type ProjectBranding,
  type ProjectAuthConfig,
  type AppDomainSignupRule,
  listHarnesses,
  getHarnessInfo,
  getHarnessAuthStatus,
  listHarnessVariants,
  getHarnessCapability,
  generateScheduleId,
  type ProjectSpendResponse,
  type BootstrapProjectRequest,
  type BootstrapProjectResponse,
  type EnvironmentResponse,
  type Manifest,
  getManifestIngressAliases,
  getManifestTcpIngressAliases,
  assertUniqueManifestIngressAliases,
  isReservedAlias,
  getManifestCustomDomainDeclarations,
  getManifestCustomDomainDesiredState,
  assertUniqueManifestCustomDomainDeclarations,
  type ManifestCustomDomainDesiredState,
  isPlatformDomainHostname,
  generateCustomDomainId,
  generateAppLinkGrantId,
  generateAppLinkSubscriptionId,
  analyzeManifestCoherence,
  isReservedAgentAlias,
  isValidPermission,
  validateWorkflowTemplates,
  assertNoUnresolvedManifestReferences,
  getManifestAppLinks,
  type AppLinks,
  type Service,
} from '@eve/shared';
import * as crypto from 'crypto';
import * as yaml from 'yaml';
import { SecretsService } from '../secrets/secrets.service.js';
import { ensureManifestEnvironment } from '../environments/manifest-environment.js';

// Regex for valid slug: 4-8 chars, starts with letter, alphanumeric
const SLUG_REGEX = /^[A-Za-z][A-Za-z0-9]{3,7}$/;

type PreparedAppLinkGrant = {
  producer_project_id: string;
  export_kind: 'api' | 'events';
  export_name: string;
  consumer_project_id: string;
  api_scopes: string[];
  event_types: string[];
  envs: string[];
  service_name: string | null;
  cli_name: string | null;
  cli_image: string | null;
  cli_bin_path: string | null;
};

type PreparedAppLinkSubscription = {
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
};

type PreparedAppLinkReconciliation = {
  grants: PreparedAppLinkGrant[];
  grantKeys: Set<string>;
  subscriptions: PreparedAppLinkSubscription[];
  subscriptionAliases: Set<string>;
  warnings: string[];
};

/**
 * Generate a slug from a project name.
 * Takes first 4-8 alphanumeric chars, ensuring it starts with a letter.
 */
function generateSlug(name: string): string {
  // Remove non-alphanumeric, keep only letters and digits
  const alphanumeric = name.replace(/[^A-Za-z0-9]/g, '');

  // Ensure starts with letter
  const startsWithLetter = alphanumeric.match(/^[A-Za-z]/);
  if (!startsWithLetter || alphanumeric.length < 4) {
    throw new BadRequestException(
      `Cannot generate slug from name "${name}". Name must contain at least 4 alphanumeric characters starting with a letter. Provide a custom --slug instead.`
    );
  }

  // Take first 8 chars (or less if shorter)
  return alphanumeric.substring(0, 8);
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private memberships: ReturnType<typeof membershipQueries>;
  private users: ReturnType<typeof userQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private teams: ReturnType<typeof teamQueries>;
  private teamMembers: ReturnType<typeof teamMemberQueries>;
  private threads: ReturnType<typeof threadQueries>;
  private schedules: ReturnType<typeof scheduleQueries>;
  private spend: ReturnType<typeof spendQueries>;
  private envs: ReturnType<typeof environmentQueries>;
  private ingressAliases: ReturnType<typeof ingressAliasQueries>;
  private customDomains: ReturnType<typeof customDomainQueries>;
  private appLinkGrants: ReturnType<typeof appLinkGrantQueries>;
  private appLinkSubscriptions: ReturnType<typeof appLinkSubscriptionQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly secretsService: SecretsService,
  ) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.manifests = projectManifestQueries(db);
    this.memberships = membershipQueries(db);
    this.users = userQueries(db);
    this.releases = releaseQueries(db);
    this.agentConfigs = agentConfigQueries(db);
    this.agents = agentQueries(db);
    this.teams = teamQueries(db);
    this.teamMembers = teamMemberQueries(db);
    this.threads = threadQueries(db);
    this.schedules = scheduleQueries(db);
    this.spend = spendQueries(db);
    this.envs = environmentQueries(db);
    this.ingressAliases = ingressAliasQueries(db);
    this.customDomains = customDomainQueries(db);
    this.appLinkGrants = appLinkGrantQueries(db);
    this.appLinkSubscriptions = appLinkSubscriptionQueries(db);
  }

  async getSpend(
    projectId: string,
    options: { since?: Date; until?: Date; currency?: string; limit?: number },
  ): Promise<ProjectSpendResponse> {
    const project = await this.projects.findById(projectId, { include_deleted: false });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const summary = await this.spend.sumProjectSpend(project.id, {
      since: options.since,
      until: options.until,
      billed_currency: options.currency,
    });

    const topJobs = await this.spend.topJobsByCost(project.id, {
      since: options.since,
      until: options.until,
      billed_currency: options.currency,
      limit: options.limit,
    });

    return {
      project_id: project.id,
      summary: {
        since: summary.since,
        until: summary.until,
        base_total_usd: summary.base_total_usd,
        billed_total: summary.billed_total,
        billed_currency: summary.billed_currency,
        attempts: summary.attempts,
      },
      top_jobs: topJobs,
    };
  }

  async create(data: CreateProjectRequest, actorUserId?: string): Promise<ProjectResponse> {
    // Validate org exists
    const org = await this.orgs.findById(data.org_id);
    if (!org) {
      throw new NotFoundException(`Organization ${data.org_id} not found`);
    }

    // Generate or validate slug
    const slug = data.slug ?? generateSlug(data.name);
    if (!SLUG_REGEX.test(slug)) {
      throw new BadRequestException(
        `Invalid slug "${slug}". Must be 4-8 alphanumeric characters starting with a letter.`
      );
    }

    const id = generateProjectId();
    const project = await this.projects.create({
      id,
      org_id: data.org_id,
      name: data.name,
      slug,
      repo_url: data.repo_url,
      branch: data.branch,
    });

    await this.assignOwner(project.id, actorUserId);
    return this.toResponse(project);
  }

  async ensure(data: EnsureProjectRequest, actorUserId?: string): Promise<ProjectResponse> {
    const requestedRepoUrl = (data.repo_url ?? '').trim();
    const repoProvided = requestedRepoUrl.length > 0;

    // Check if project already exists by name
    const existingByName = await this.projects.findByOrgAndName(data.org_id, data.name, {
      include_deleted: true,
    });
    if (existingByName) {
      // Without an incoming repo URL, keep existing repo/branch unchanged.
      const needsRepoUpdate = repoProvided && existingByName.repo_url !== requestedRepoUrl;
      const needsBranchUpdate = repoProvided && existingByName.branch !== data.branch;
      const needsUpdate = needsRepoUpdate || needsBranchUpdate;
      const canAdoptRepoWithoutForce = repoProvided && !existingByName.repo_url;

      if (needsUpdate && !data.force && !canAdoptRepoWithoutForce) {
        throw new ConflictException(
          `Project ${data.name} already exists with different repo_url/branch`
        );
      }

      // Update if forced or if restoring deleted project
      if (needsUpdate || existingByName.deleted_at !== null) {
        const updated = await this.projects.update(existingByName.id, {
          repo_url: repoProvided ? requestedRepoUrl : undefined,
          branch: repoProvided ? data.branch : undefined,
          deleted: false,
        });
        if (!updated) {
          throw new NotFoundException(`Project ${existingByName.id} not found`);
        }
        return this.toResponse(updated);
      }

      return this.toResponse(existingByName);
    }

    // Generate or validate slug for new project
    const slug = data.slug ?? generateSlug(data.name);
    if (!SLUG_REGEX.test(slug)) {
      throw new BadRequestException(
        `Invalid slug "${slug}". Must be 4-8 alphanumeric characters starting with a letter.`
      );
    }

    // Check if a project with this slug already exists (unique constraint: org_id + slug)
    const existingBySlug = await this.projects.findByOrgAndSlug(data.org_id, slug, {
      include_deleted: true,
    });
    if (existingBySlug) {
      // Found a project with same slug but different name - check if it's compatible
      const needsRepoUpdate = repoProvided && existingBySlug.repo_url !== requestedRepoUrl;
      const needsBranchUpdate = repoProvided && existingBySlug.branch !== data.branch;
      const needsUpdate = needsRepoUpdate || needsBranchUpdate;
      const canAdoptRepoWithoutForce = repoProvided && !existingBySlug.repo_url;

      if (needsUpdate && !data.force && !canAdoptRepoWithoutForce) {
        throw new ConflictException(
          `Slug "${slug}" is already used by project "${existingBySlug.name}" with different repo_url/branch. ` +
          `Use --force to update or --slug to specify a different slug.`
        );
      }

      // Update if forced or if restoring deleted project
      if (needsUpdate || existingBySlug.deleted_at !== null) {
        const updated = await this.projects.update(existingBySlug.id, {
          repo_url: repoProvided ? requestedRepoUrl : undefined,
          branch: repoProvided ? data.branch : undefined,
          deleted: false,
        });
        if (!updated) {
          throw new NotFoundException(`Project ${existingBySlug.id} not found`);
        }
        return this.toResponse(updated);
      }

      // Slug matches and attributes match - return existing project
      return this.toResponse(existingBySlug);
    }

    // Validate org exists before creating
    const org = await this.orgs.findById(data.org_id);
    if (!org) {
      throw new NotFoundException(`Organization ${data.org_id} not found`);
    }

    const id = generateProjectId();
    const project = await this.projects.create({
      id,
      org_id: data.org_id,
      name: data.name,
      slug,
      repo_url: requestedRepoUrl,
      branch: data.branch,
    });

    await this.assignOwner(project.id, actorUserId);
    return this.toResponse(project);
  }

  async bootstrap(data: BootstrapProjectRequest, actorUserId?: string): Promise<BootstrapProjectResponse> {
    // Pre-resolve slug to detect idempotent calls before ensure()
    const slug = data.slug ?? generateSlug(data.name);
    if (!SLUG_REGEX.test(slug)) {
      throw new BadRequestException(
        `Invalid slug "${slug}". Must be 4-8 alphanumeric characters starting with a letter.`,
      );
    }

    const existingBySlug = await this.projects.findByOrgAndSlug(data.org_id, slug, { include_deleted: true });
    const existingByName = await this.projects.findByOrgAndName(data.org_id, data.name, { include_deleted: true });
    const existing = existingBySlug ?? existingByName;
    const existedBefore = Boolean(existing && existing.deleted_at === null);

    // 1. Ensure project exists (idempotent)
    const project = await this.ensure({
      org_id: data.org_id,
      name: data.name,
      slug,
      repo_url: data.repo_url,
      branch: data.branch,
      force: false,
    }, actorUserId);

    // 2. Determine if newly created
    const isNew = !existedBefore;

    // 3. Create environments (idempotent)
    const envNames = data.environments ?? ['staging'];
    const environments: EnvironmentResponse[] = [];

    for (const envName of envNames) {
      const existing = await this.envs.findByProjectAndName(project.id, envName);
      if (existing) {
        environments.push(this.toEnvironmentResponse(existing));
      } else {
        const env = await this.envs.create({
          id: generateEnvironmentId(),
          project_id: project.id,
          name: envName,
          type: 'persistent',
          kind: 'standard',
          namespace: null,
          db_ref: null,
          overrides_json: null,
          labels_json: null,
          current_release_id: null,
          last_failed_release_id: null,
          last_applied_release_id: null,
          last_deploy_failure_json: null,
        });
        environments.push(this.toEnvironmentResponse(env));
      }
    }

    // 4. Build next steps
    const nextSteps = [
      `Clone the repo: git clone ${project.repo_url}`,
      'Run "eve project sync" to sync the manifest',
      `Deploy with: eve env deploy ${project.id} ${envNames[0]} --tag local`,
    ];

    return {
      project,
      environments,
      status: isNew ? 'created' : 'existing',
      next_steps: nextSteps,
    };
  }

  async list(options: {
    limit: number;
    offset: number;
    include_deleted: boolean;
    org_id?: string;
    name?: string;
    user_id?: string;
  }): Promise<ProjectListResponse> {
    const projects = options.user_id
      ? await this.memberships.listProjectsForUser(options.user_id, {
          include_deleted: options.include_deleted,
          limit: options.limit,
          offset: options.offset,
          org_id: options.org_id,
        })
      : await this.projects.list({
          limit: options.limit,
          offset: options.offset,
          include_deleted: options.include_deleted,
          org_id: options.org_id,
          name: options.name,
        });

    return {
      data: projects.map((project) => this.toResponse(project)),
      pagination: {
        limit: options.limit,
        offset: options.offset,
        count: projects.length,
      },
    };
  }

  async findById(id: string, includeDeleted = false): Promise<ProjectResponse | null> {
    const project = await this.projects.findById(id, { include_deleted: includeDeleted });
    if (!project) return null;
    return this.toResponse(project);
  }

  async update(id: string, updates: UpdateProjectRequest): Promise<ProjectResponse> {
    if (
      updates.name === undefined &&
      updates.repo_url === undefined &&
      updates.branch === undefined &&
      updates.deleted === undefined
    ) {
      throw new BadRequestException('No updates provided');
    }

    const updated = await this.projects.update(id, {
      name: updates.name,
      repo_url: updates.repo_url,
      branch: updates.branch,
      deleted: updates.deleted,
    });
    if (!updated) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return this.toResponse(updated);
  }

  async deleteProject(
    projectId: string,
    options: { hard?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const { hard = false, force = false } = options;

    const project = await this.projects.findById(projectId, { include_deleted: true });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Tear down K8s deployments for all environments before deleting records
    const environments = await this.envs.listByProject(projectId);
    for (const env of environments) {
      await this.teardownEnvironmentDeployment(env.id, force);
    }

    if (hard) {
      // Delete all environment records first (handles managed_db_tenants FK, etc.)
      for (const env of environments) {
        await this.envs.delete(env.id);
      }

      // Hard-delete the project — remaining child records cascade via FK constraints
      const deleted = await this.projects.hardDelete(projectId);
      if (!deleted) {
        throw new NotFoundException(`Project ${projectId} not found during hard delete`);
      }
      this.logger.log(`[project-delete] Hard-deleted project ${projectId}`);
    } else {
      // Soft-delete: set deleted_at timestamp
      const updated = await this.projects.update(projectId, { deleted: true });
      if (!updated) {
        throw new NotFoundException(`Project ${projectId} not found during soft delete`);
      }
      this.logger.log(`[project-delete] Soft-deleted project ${projectId}`);
    }
  }

  async syncManifest(projectId: string, data: SyncManifestRequest): Promise<ManifestResponse> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Parse and validate manifest
    let validatedManifest: Manifest | null = null;
    let parsedDefaults: Record<string, unknown> | null = null;
    let parsedAgents: Record<string, unknown> | null = null;
    let parsedBranding: ProjectBranding | null = null;
    let parsedAuthConfig: ProjectAuthConfig | null = null;
    let secretValidation: SecretValidationResult | undefined;
    let warnings: string[] | undefined;
    let appLinkReconciliation: PreparedAppLinkReconciliation | null = null;
    try {
      const parsed = yaml.parse(data.yaml);
      const validated = ManifestSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(validated.error.message);
      }
      validatedManifest = validated.data;
      try {
        assertNoUnresolvedManifestReferences(validated.data as Record<string, unknown>);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Unresolved manifest references',
        );
      }

      parsedDefaults = getManifestDefaults(validated.data);
      parsedAgents = getManifestAgents(validated.data);
      parsedBranding = getManifestBranding(validated.data);
      parsedAuthConfig = await this.normalizeProjectAuthConfig(
        project.org_id,
        getManifestAuthConfig(validated.data),
      );

      const aliases = getManifestIngressAliases(validated.data);
      const tcpAliases = getManifestTcpIngressAliases(validated.data);
      try {
        assertUniqueManifestIngressAliases(aliases);
        assertUniqueManifestIngressAliases(tcpAliases);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Duplicate ingress alias values in manifest';
        throw new BadRequestException(message);
      }
      for (const alias of tcpAliases.keys()) {
        if (aliases.has(alias)) {
          throw new BadRequestException(`Ingress alias "${alias}" is declared for both HTTP and TCP ingress`);
        }
      }

      const allAliases = new Map([...aliases.entries(), ...tcpAliases.entries()]);
      for (const alias of allAliases.keys()) {
        if (isReservedAlias(alias)) {
          throw new BadRequestException(`Ingress alias "${alias}" is reserved`);
        }

        const existingAlias = await this.ingressAliases.findByAlias(alias);
        if (existingAlias && existingAlias.project_id !== projectId) {
          throw new ConflictException(`Ingress alias "${alias}" is already claimed by another project`);
        }
      }

      // Validate custom domains
      const customDomainDeclarations = getManifestCustomDomainDeclarations(validated.data);
      try {
        assertUniqueManifestCustomDomainDeclarations(customDomainDeclarations);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Duplicate custom domain hostnames in manifest';
        throw new BadRequestException(message);
      }
      for (const declaration of customDomainDeclarations) {
        const existingDomain = await this.customDomains.findByHostname(declaration.hostname);
        if (existingDomain && existingDomain.project_id !== projectId) {
          throw new ConflictException(`Custom domain "${declaration.hostname}" is already claimed by another project`);
        }
      }

      if (data.validate_secrets || data.strict) {
        const requiredSecrets = getManifestRequiredSecrets(validated.data);
        if (requiredSecrets.length > 0) {
          secretValidation = await this.secretsService.validateRequiredSecrets(projectId, requiredSecrets);
          if (secretValidation.missing.length > 0) {
            warnings = secretValidation.missing.map((item) => {
              const hint = item.hints[0] ? ` ${item.hints[0]}` : '';
              return `Missing secret ${item.key}.${hint}`.trim();
            });
            if (data.strict) {
              throw new BadRequestException({
                message: 'Missing required secrets',
                secret_validation: secretValidation,
              });
            }
          }
        }
      }

      // Coherence analysis — surface structural warnings at sync time
      const coherenceResults = analyzeManifestCoherence(validated.data);
      const coherenceWarnings = coherenceResults
        .filter((w) => w.severity === 'warning')
        .map((w) => w.message);
      const coherenceErrors = coherenceResults
        .filter((w) => w.severity === 'error')
        .map((w) => w.message);
      if (coherenceWarnings.length > 0 || coherenceErrors.length > 0) {
        const allMessages = [...coherenceErrors, ...coherenceWarnings];
        if (warnings) {
          warnings.push(...allMessages);
        } else {
          warnings = allMessages;
        }
      }

      // Phase 4: Reject malformed workflow step template expressions and
      // undeclared `${inputs.<key>}` references. Event-payload refs are
      // accepted structurally — the payload shape is only known at runtime.
      const templateErrors = validateWorkflowTemplates(
        validated.data.workflows as Record<string, unknown> | undefined,
      );
      if (templateErrors.length > 0) {
        const lines = templateErrors.map(
          (e) =>
            `workflow "${e.workflow}"${e.stepName ? ` step "${e.stepName}"` : ''} ${e.field}: ${e.message}`,
        );
        throw new BadRequestException(
          `Invalid workflow templates: ${lines.join('; ')}`,
        );
      }

      appLinkReconciliation = await this.prepareAppLinkReconciliation(
        project,
        validated.data,
        data.local_cli_images,
      );
      if (appLinkReconciliation.warnings.length > 0) {
        warnings = [
          ...(warnings ?? []),
          ...appLinkReconciliation.warnings,
        ];
      }
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      throw new BadRequestException(`Invalid YAML: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    if (!validatedManifest) {
      throw new BadRequestException('Invalid manifest: no validated manifest content');
    }

    // Hash the manifest content
    const manifestHash = crypto
      .createHash('sha256')
      .update(data.yaml)
      .digest('hex');

    // Check if manifest with same hash already exists
    const existing = await this.manifests.findByProjectAndHash(projectId, manifestHash);
    if (existing) {
      const updated = await this.manifests.update(existing.id, {
        git_sha: data.git_sha ?? existing.git_sha ?? null,
        branch: data.branch ?? existing.branch ?? null,
        parsed_defaults: parsedDefaults,
        parsed_agents: parsedAgents,
      });
      await this.projects.updateBranding(projectId, parsedBranding);
      await this.projects.updateAuthConfig(projectId, parsedAuthConfig);
      if (appLinkReconciliation) {
        await this.applyAppLinkReconciliation(projectId, appLinkReconciliation);
      }
      await this.reconcileIngressAliases(projectId, validatedManifest);
      const domainWarnings = await this.reconcileCustomDomains(projectId, validatedManifest);
      if (domainWarnings.length > 0) {
        warnings = [...(warnings ?? []), ...domainWarnings];
      }
      if (updated) {
        const response = this.toManifestResponse(updated);
        if (secretValidation) response.secret_validation = secretValidation;
        if (warnings) response.warnings = warnings;
        return response;
      }
      const touched = await this.manifests.touch(existing.id);
      const response = this.toManifestResponse(touched ?? existing);
      if (secretValidation) response.secret_validation = secretValidation;
      if (warnings) response.warnings = warnings;
      return response;
    }

    // Create new manifest
    const id = generateManifestId();
    const manifest = await this.manifests.create({
      id,
      project_id: projectId,
      manifest_yaml: data.yaml,
      manifest_hash: manifestHash,
      git_sha: data.git_sha ?? null,
      branch: data.branch ?? null,
      parsed_defaults: parsedDefaults,
      parsed_agents: parsedAgents,
    });
    if (appLinkReconciliation) {
      await this.applyAppLinkReconciliation(projectId, appLinkReconciliation);
    }
    await this.reconcileIngressAliases(projectId, validatedManifest);
    const domainWarnings = await this.reconcileCustomDomains(projectId, validatedManifest);
    if (domainWarnings.length > 0) {
      warnings = [...(warnings ?? []), ...domainWarnings];
    }
    await this.projects.updateBranding(projectId, parsedBranding);
    await this.projects.updateAuthConfig(projectId, parsedAuthConfig);

    const response = this.toManifestResponse(manifest);
    if (secretValidation) response.secret_validation = secretValidation;
    if (warnings) response.warnings = warnings;
    return response;
  }

  async syncAgentsConfig(projectId: string, data: AgentsSyncRequest): Promise<AgentsSyncResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const org = await this.orgs.findById(project.org_id);
    if (!org) {
      throw new NotFoundException(`Organization ${project.org_id} not found`);
    }
    const orgDefaultSlug = org.default_agent_slug ?? null;

    const parsedAgentsYaml = this.parseYaml(data.agents_yaml, 'agents');
    const parsedTeamsYaml = this.parseYaml(data.teams_yaml, 'teams');
    const parsedChatYaml = this.parseYaml(data.chat_yaml, 'chat');
    const normalizedChatYaml = this.normalizeChatConfig(parsedChatYaml);

    const agentsValidated = AgentsYamlSchema.safeParse(parsedAgentsYaml);
    if (!agentsValidated.success) {
      throw new BadRequestException(`Invalid agents.yaml: ${agentsValidated.error.message}`);
    }

    const teamsValidated = TeamsYamlSchema.safeParse(parsedTeamsYaml);
    if (!teamsValidated.success) {
      throw new BadRequestException(`Invalid teams.yaml: ${teamsValidated.error.message}`);
    }

    const chatValidated = ChatYamlSchema.safeParse(normalizedChatYaml);
    if (!chatValidated.success) {
      throw new BadRequestException(`Invalid chat.yaml: ${chatValidated.error.message}`);
    }

    const agentEntries = agentsValidated.data.agents ?? {};
    const teamEntries = teamsValidated.data.teams ?? {};
    const routes = chatValidated.data.routes ?? [];

    const agentIds = new Set(Object.keys(agentEntries));
    const teamIds = new Set(Object.keys(teamEntries));

    for (const [teamId, team] of Object.entries(teamEntries)) {
      if (!agentIds.has(team.lead)) {
        throw new BadRequestException(
          `Team ${teamId} references unknown lead agent ${team.lead}`
        );
      }
      for (const memberId of team.members ?? []) {
        if (!agentIds.has(memberId)) {
          throw new BadRequestException(
            `Team ${teamId} references unknown member agent ${memberId}`
          );
        }
      }
    }

    const routeIds = new Set<string>();
    for (const route of routes) {
      if (routeIds.has(route.id)) {
        throw new BadRequestException(`Duplicate route id ${route.id}`);
      }
      routeIds.add(route.id);

      try {
        new RegExp(route.match);
      } catch (error) {
        throw new BadRequestException(
          `Invalid route match regex for ${route.id}: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }

      const targetMatch = route.target.match(/^(agent|team|workflow|pipeline):(.+)$/);
      if (!targetMatch) {
        throw new BadRequestException(`Invalid route target for ${route.id}: ${route.target}`);
      }
      const targetType = targetMatch[1];
      const targetId = targetMatch[2];
      if (targetType === 'agent' && !agentIds.has(targetId)) {
        throw new BadRequestException(`Route ${route.id} references unknown agent ${targetId}`);
      }
      if (targetType === 'team' && !teamIds.has(targetId)) {
        throw new BadRequestException(`Route ${route.id} references unknown team ${targetId}`);
      }
    }

    if (chatValidated.data.default_route && !routeIds.has(chatValidated.data.default_route)) {
      throw new BadRequestException(
        `default_route ${chatValidated.data.default_route} does not match any route id`
      );
    }

    const agentSlugMap = new Map<string, string>();
    for (const [agentId, agent] of Object.entries(agentEntries)) {
      if (!agent.slug) continue;
      const slug = agent.slug.trim();
      if (slug.length === 0) {
        throw new BadRequestException(`Agent ${agentId} has an empty slug`);
      }
      if (agentSlugMap.has(slug)) {
        const existing = agentSlugMap.get(slug);
        throw new BadRequestException(`Duplicate agent slug ${slug} (agents ${existing} and ${agentId})`);
      }
      agentSlugMap.set(slug, agentId);
    }

    if (agentSlugMap.size > 0) {
      const slugs = Array.from(agentSlugMap.keys());
      const existing = await this.agents.listByOrgAndSlugs(project.org_id, slugs);
      const conflict = existing.find((entry) => entry.project_id !== projectId);
      if (conflict && conflict.slug) {
        throw new BadRequestException(
          `Agent slug ${conflict.slug} already used by ${conflict.project_id}:${conflict.id}`
        );
      }
    }

    // --- Alias validation ---
    const agentAliasMap = new Map<string, string>();
    for (const [agentId, agent] of Object.entries(agentEntries)) {
      if (!agent.alias) continue;
      const alias = agent.alias.trim().toLowerCase();
      if (alias.length === 0) continue;
      if (isReservedAgentAlias(alias)) {
        throw new BadRequestException(`Agent alias '${alias}' is a reserved name`);
      }
      if (agentAliasMap.has(alias)) {
        const existing = agentAliasMap.get(alias);
        throw new BadRequestException(`Duplicate agent alias ${alias} (agents ${existing} and ${agentId})`);
      }
      // Alias must not collide with a slug in the same payload
      if (agentSlugMap.has(alias)) {
        throw new BadRequestException(
          `Agent alias '${alias}' collides with agent slug from ${agentSlugMap.get(alias)}`
        );
      }
      agentAliasMap.set(alias, agentId);
    }

    if (agentAliasMap.size > 0) {
      const aliases = Array.from(agentAliasMap.keys());
      // Check alias doesn't collide with existing aliases in other projects
      const existingAliases = await this.agents.listByOrgAndAliases(project.org_id, aliases);
      const aliasConflict = existingAliases.find((entry) => entry.project_id !== projectId);
      if (aliasConflict && aliasConflict.alias) {
        throw new BadRequestException(
          `Agent alias '${aliasConflict.alias}' already used by ${aliasConflict.project_id}:${aliasConflict.id}`
        );
      }
      // Check alias doesn't collide with existing slugs in other projects
      const existingSlugs = await this.agents.listByOrgAndSlugs(project.org_id, aliases);
      const slugConflict = existingSlugs.find((entry) => entry.project_id !== projectId);
      if (slugConflict && slugConflict.slug) {
        throw new BadRequestException(
          `Agent alias '${slugConflict.slug}' collides with existing agent slug from ${slugConflict.project_id}:${slugConflict.id}`
        );
      }
    }

    await this.validateAgentAccessAgainstManifest(projectId, agentEntries);

    // Validate agent-declared permissions against the permission catalog
    for (const [agentId, agent] of Object.entries(agentEntries)) {
      const perms = (agent.access as Record<string, unknown> | undefined)?.permissions;
      if (!perms) continue;
      if (!Array.isArray(perms)) {
        throw new BadRequestException(`Agent ${agentId} permissions must be an array`);
      }
      const unknown = perms.filter((p): p is string => typeof p === 'string').filter((p) => !isValidPermission(p));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Agent ${agentId} declares unknown permission(s): ${unknown.join(', ')}`
        );
      }
    }

    const configId = generateAgentConfigId();

    const created = await this.db.begin(async (tx) => {
      const transaction = tx as unknown as Db;
      const agentConfigRepo = agentConfigQueries(transaction);
      const agentsRepo = agentQueries(transaction);
      const teamsRepo = teamQueries(transaction);
      const teamMembersRepo = teamMemberQueries(transaction);

      await teamMembersRepo.deleteByProject(projectId);
      await teamsRepo.deleteByProject(projectId);
      await agentsRepo.deleteByProject(projectId);

      for (const [agentId, agent] of Object.entries(agentEntries)) {
        const gateway = agent.gateway as { policy?: string; clients?: string[] } | undefined;
        const gatewayPolicy = gateway?.policy ?? 'none';
        const gatewayClients = gateway?.clients ?? null;

        await agentsRepo.insert({
          project_id: projectId,
          id: agentId,
          slug: agent.slug ?? null,
          alias: agent.alias ?? null,
          name: agent.name ?? null,
          description: agent.description ?? null,
          role: agent.role ?? null,
          workflow: agent.workflow ?? null,
          harness_profile: agent.harness_profile ?? null,
          policies_json: agent.policies ?? null,
          access_json: agent.access ?? null,
          gateway_policy: gatewayPolicy,
          gateway_clients: gatewayClients,
        });
      }

      for (const [teamId, team] of Object.entries(teamEntries)) {
        await teamsRepo.insert({
          project_id: projectId,
          id: teamId,
          lead_agent_id: team.lead ?? null,
          dispatch_json: team.dispatch ?? null,
        });

        const members = new Set<string>(team.members ?? []);
        if (team.lead) {
          members.add(team.lead);
        }
        for (const memberId of members) {
          await teamMembersRepo.insert({
            project_id: projectId,
            team_id: teamId,
            agent_id: memberId,
          });
        }
      }

      if (orgDefaultSlug) {
        const existingDefault = await agentsRepo.listByOrgAndSlugs(project.org_id, [orgDefaultSlug]);
        if (existingDefault.length === 0) {
          throw new BadRequestException(
            `Org default agent slug ${orgDefaultSlug} would be removed by this sync. Update the org default before syncing.`
          );
        }
      }

      return agentConfigRepo.create({
        id: configId,
        project_id: projectId,
        agents_yaml: data.agents_yaml,
        teams_yaml: data.teams_yaml,
        chat_yaml: data.chat_yaml,
        x_eve_yaml: data.x_eve_yaml ?? null,
        parsed_agents: agentsValidated.data as unknown as Record<string, unknown>,
        parsed_teams: teamsValidated.data as unknown as Record<string, unknown>,
        parsed_routes: routes.length > 0 ? (routes as unknown[]) : null,
        pack_refs: data.pack_refs ?? null,
        git_sha: data.git_sha ?? null,
        branch: data.branch ?? null,
        git_ref: data.git_ref ?? null,
      });
    });

    return this.toAgentsSyncResponse(created);
  }

  async getLatestManifest(projectId: string): Promise<ManifestResponse | null> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      return null;
    }

    return this.toManifestResponse(manifest);
  }

  async validateManifest(
    projectId: string,
    data: ManifestValidateRequest,
  ): Promise<ManifestValidateResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const response: ManifestValidateResponse = {
      valid: false,
    };

    let manifestYaml = data.manifest_yaml;
    if (!manifestYaml) {
      const latest = await this.manifests.findLatestByProject(projectId);
      if (!latest) {
        response.errors = ['No manifest available for validation. Provide manifest_yaml or sync a manifest first.'];
        return response;
      }
      manifestYaml = latest.manifest_yaml;
      response.manifest_hash = latest.manifest_hash;
    }

    let parsed: unknown;
    try {
      parsed = yaml.parse(manifestYaml);
    } catch (error) {
      response.errors = [
        `Invalid YAML: ${error instanceof Error ? error.message : 'unknown error'}`,
      ];
      return response;
    }

    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      response.errors = [validated.error.message];
      return response;
    }

    response.valid = true;
    try {
      assertNoUnresolvedManifestReferences(validated.data as Record<string, unknown>);
    } catch (error) {
      response.errors = [
        ...(response.errors ?? []),
        error instanceof Error ? error.message : 'Unresolved manifest references',
      ];
      response.valid = false;
    }
    response.parsed_defaults = getManifestDefaults(validated.data);
    response.parsed_agents = getManifestAgents(validated.data);

    // Pipeline coherence analysis
    const coherenceResults = analyzeManifestCoherence(validated.data);
    const coherenceErrors = coherenceResults.filter((w) => w.severity === 'error');
    const coherenceWarnings = coherenceResults.filter((w) => w.severity === 'warning');

    if (coherenceErrors.length > 0) {
      response.errors = coherenceErrors.map((e) => e.message);
      response.valid = false;
    }

    if (coherenceWarnings.length > 0) {
      response.warnings = [
        ...(response.warnings ?? []),
        ...coherenceWarnings.map((w) => w.message),
      ];
    }

    // Phase 4: workflow template expression validation.
    const templateErrors = validateWorkflowTemplates(
      validated.data.workflows as Record<string, unknown> | undefined,
    );
    if (templateErrors.length > 0) {
      const lines = templateErrors.map(
        (e) =>
          `workflow "${e.workflow}"${e.stepName ? ` step "${e.stepName}"` : ''} ${e.field}: ${e.message}`,
      );
      response.errors = [...(response.errors ?? []), ...lines];
      response.valid = false;
    }

    response.manifest_hash = crypto
      .createHash('sha256')
      .update(manifestYaml)
      .digest('hex');

    if (data.validate_secrets || data.strict) {
      const requiredSecrets = getManifestRequiredSecrets(validated.data);
      if (requiredSecrets.length > 0) {
        const validation = await this.secretsService.validateRequiredSecrets(projectId, requiredSecrets);
        response.secret_validation = validation;
        if (validation.missing.length > 0) {
          response.warnings = validation.missing.map((item) => {
            const hint = item.hints[0] ? ` ${item.hints[0]}` : '';
            const suggestion = item.suggestion ? ` (${item.suggestion})` : '';
            return `Missing secret ${item.key}.${suggestion}${hint}`.trim();
          });
          if (data.strict) {
            response.valid = false;
            response.errors = ['Missing required secrets'];
          }
        }
      }
    }

    return response;
  }

  async getAgentsConfig(projectId: string, includeHarnesses: boolean): Promise<AgentsConfigResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const manifest = await this.manifests.findLatestByProject(projectId);
    const agentConfig = await this.agentConfigs.findLatestByProject(projectId);
    const syncedPolicy = this.getSyncedPolicyConfig(agentConfig?.x_eve_yaml ?? null);
    const parsedAgents = this.getAgentSummariesFromParsedConfig(agentConfig?.parsed_agents);
    const dbAgents = await this.agents.listByProject(projectId);
    const policy = syncedPolicy.policy ?? manifest?.parsed_agents ?? null;
    const manifestDefaults = syncedPolicy.defaults ?? manifest?.parsed_defaults ?? null;

    let configSource: NonNullable<AgentsConfigResponse['config_source']> = 'none';
    if (parsedAgents.length > 0) {
      configSource = 'agent_config';
    } else if (dbAgents.length > 0) {
      configSource = 'database';
    } else if (policy || manifestDefaults) {
      configSource = 'manifest';
    }

    const response: AgentsConfigResponse = {
      project_id: projectId,
      policy,
      manifest_defaults: manifestDefaults,
      config_source: configSource,
      synced_at: agentConfig?.updated_at?.toISOString() ?? manifest?.updated_at?.toISOString() ?? null,
    };

    if (parsedAgents.length > 0) {
      response.agents = parsedAgents;
    } else if (dbAgents.length > 0) {
      response.agents = dbAgents.map((agent) => ({
        id: agent.id,
        slug: agent.slug ?? null,
        alias: agent.alias ?? null,
        name: agent.name ?? null,
        description: agent.description ?? null,
        role: agent.role ?? null,
        workflow: agent.workflow ?? null,
        harness_profile: agent.harness_profile ?? null,
        policies: agent.policies_json ?? null,
        access: agent.access_json ?? null,
        gateway_policy: agent.gateway_policy as 'none' | 'discoverable' | 'routable',
        gateway_clients: agent.gateway_clients ?? null,
      }));
    }

    if (includeHarnesses) {
      response.harnesses = {
        data: listHarnesses().map((harness) => {
          const info = getHarnessInfo(harness.name);
          if (!info) {
            return {
              name: harness.name,
              description: harness.description,
              variants: [],
              auth: getHarnessAuthStatus(harness.name),
              capabilities: getHarnessCapability(harness.name),
            };
          }
          return {
            name: info.name,
            aliases: info.aliases,
            description: info.description,
            variants: listHarnessVariants(info),
            auth: getHarnessAuthStatus(info.name),
            capabilities: getHarnessCapability(info.name),
          };
        }),
      };
    }

    return response;
  }

  async listTeams(projectId: string): Promise<TeamListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const agentConfig = await this.agentConfigs.findLatestByProject(projectId);
    const parsedTeams = this.getTeamSummariesFromParsedConfig(agentConfig?.parsed_teams);
    if (parsedTeams.length > 0) {
      return { teams: parsedTeams };
    }

    const teams = await this.teams.listByProject(projectId);
    const members = await this.teamMembers.listByProject(projectId);
    const membersByTeam = new Map<string, string[]>();

    for (const member of members) {
      const existing = membersByTeam.get(member.team_id) ?? [];
      existing.push(member.agent_id);
      membersByTeam.set(member.team_id, existing);
    }

    return {
      teams: teams.map((team) => ({
        id: team.id,
        lead_agent_id: team.lead_agent_id ?? null,
        dispatch: team.dispatch_json ?? null,
        members: membersByTeam.get(team.id) ?? [],
      })),
    };
  }

  async listRoutes(projectId: string): Promise<RouteListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const config = await this.agentConfigs.findLatestByProject(projectId);
    const routes = Array.isArray(config?.parsed_routes)
      ? config?.parsed_routes
      : [];

    return {
      routes: routes.map((route) => {
        const obj = typeof route === 'object' && route ? route as Record<string, unknown> : {};
        return {
          id: String(obj.id ?? ''),
          match: String(obj.match ?? ''),
          target: String(obj.target ?? ''),
          permissions: (obj.permissions && typeof obj.permissions === 'object') ? obj.permissions as Record<string, unknown> : undefined,
        };
      }),
    };
  }

  async listThreads(projectId: string, options: { limit?: number; offset?: number }): Promise<ThreadListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const threads = await this.threads.listByProject(projectId, options);
    return {
      threads: threads.map((thread) => ({
        id: thread.id,
        project_id: thread.project_id!,
        key: thread.key,
        channel: thread.channel ?? null,
        peer: thread.peer ?? null,
        policy: thread.policy_json ?? null,
        summary: thread.summary ?? null,
        workspace_key: thread.workspace_key ?? null,
        created_at: thread.created_at.toISOString(),
        updated_at: thread.updated_at.toISOString(),
      })),
    };
  }

  async listSchedules(projectId: string, options: { limit?: number; offset?: number }): Promise<ScheduleListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const schedules = await this.schedules.listByProject(projectId, options);
    return {
      schedules: schedules.map((schedule) => ({
        id: schedule.id,
        project_id: schedule.project_id,
        cron: schedule.cron,
        event_type: schedule.event_type,
        payload: schedule.payload_json ?? null,
        enabled: schedule.enabled,
        created_at: schedule.created_at.toISOString(),
        updated_at: schedule.updated_at.toISOString(),
      })),
    };
  }

  async createSchedule(projectId: string, data: CreateScheduleRequest): Promise<ScheduleResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const created = await this.schedules.create({
      id: generateScheduleId(),
      project_id: projectId,
      cron: data.cron,
      event_type: data.event_type,
      payload_json: data.payload ?? null,
      enabled: data.enabled ?? true,
    });

    return {
      id: created.id,
      project_id: created.project_id,
      cron: created.cron,
      event_type: created.event_type,
      payload: created.payload_json ?? null,
      enabled: created.enabled,
      created_at: created.created_at.toISOString(),
      updated_at: created.updated_at.toISOString(),
    };
  }

  async listReleases(
    projectId: string,
    options: { limit?: number; offset?: number },
  ): Promise<ReleaseListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const releases = await this.releases.list({ project_id: projectId, limit, offset });

    return {
      data: releases.map(r => this.toReleaseResponse(r)),
      pagination: { limit, offset, count: releases.length },
    };
  }

  async getReleaseByTag(projectId: string, tag: string): Promise<ReleaseResponse | null> {
    // Verify project exists
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const release = await this.releases.findByProjectAndTag(projectId, tag);
    if (!release) {
      return null;
    }

    return this.toReleaseResponse(release);
  }

  async deleteRelease(projectId: string, tag: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const release = await this.releases.findByProjectAndTag(projectId, tag);
    if (!release) {
      throw new NotFoundException(`Release with tag "${tag}" not found for project ${projectId}`);
    }
    await this.releases.delete(release.id);
  }

  async pruneReleases(projectId: string, keep: number): Promise<{ deleted: number }> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const deleted = await this.releases.deleteByProjectOlderThan(projectId, keep);
    return { deleted };
  }

  async deleteAgent(projectId: string, slug: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const agent = await this.agents.findByProjectAndSlug(projectId, slug);
    if (!agent) {
      throw new NotFoundException(`Agent with slug "${slug}" not found for project ${projectId}`);
    }
    await this.agents.hardDelete(projectId, agent.id);
  }

  async deleteTeam(projectId: string, teamId: string): Promise<void> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    const ok = await this.teams.hardDelete(projectId, teamId);
    if (!ok) {
      throw new NotFoundException(`Team "${teamId}" not found for project ${projectId}`);
    }
  }

  // ── Member management ─────────────────────────────────────────────

  private async assignOwner(projectId: string, actorUserId?: string): Promise<void> {
    if (!actorUserId) return;
    const user = await this.users.findById(actorUserId);
    if (user) {
      await this.memberships.upsertProjectMembership(projectId, actorUserId, 'owner');
    }
  }

  async addMember(projectId: string, input: ProjectMemberRequest): Promise<ProjectMemberResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    let user = input.user_id
      ? await this.users.findById(input.user_id)
      : input.email
        ? await this.users.findByEmail(input.email)
        : null;

    if (!user) {
      if (!input.email) {
        throw new NotFoundException('User not found');
      }
      user = await this.users.create({
        id: generateUserId(),
        email: input.email,
        display_name: null,
        is_admin: false,
      });
    }

    const membership = await this.memberships.upsertProjectMembership(projectId, user.id, input.role);
    return this.toMemberResponse({ ...membership, email: user.email, display_name: user.display_name });
  }

  async listMembers(projectId: string): Promise<ProjectMemberListResponse> {
    const project = await this.projects.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const members = await this.memberships.listProjectMembers(projectId);
    return { data: members.map((m) => this.toMemberResponse(m)) };
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    const members = await this.memberships.listProjectMembers(projectId);
    const owners = members.filter((m) => m.role === 'owner');
    const isOwner = owners.some((m) => m.user_id === userId);
    if (isOwner && owners.length <= 1) {
      throw new ForbiddenException('Cannot remove the last owner of a project');
    }

    const removed = await this.memberships.removeProjectMembership(projectId, userId);
    if (!removed) {
      throw new NotFoundException(`Member ${userId} not found in project ${projectId}`);
    }
  }

  private toMemberResponse(member: { project_id: string; user_id: string; email: string; display_name: string | null; role: string; created_at: Date; updated_at: Date }): ProjectMemberResponse {
    return {
      project_id: member.project_id,
      user_id: member.user_id,
      email: member.email,
      display_name: member.display_name,
      role: member.role as ProjectMemberResponse['role'],
      created_at: member.created_at.toISOString(),
      updated_at: member.updated_at.toISOString(),
    };
  }

  private toEnvironmentResponse(env: {
    id: string;
    project_id: string;
    name: string;
    type: string;
    kind: string;
    namespace: string | null;
    db_ref: string | null;
    overrides_json: Record<string, unknown> | null;
    labels_json: Record<string, string> | null;
    current_release_id: string | null;
    last_failed_release_id: string | null;
    last_applied_release_id?: string | null;
    last_deploy_failure_json?: Record<string, unknown> | null;
    deploy_status?: string;
    status: string;
    suspended_at: Date | null;
    suspension_reason: string | null;
    created_at: Date;
    updated_at: Date;
  }): EnvironmentResponse {
    return {
      id: env.id,
      project_id: env.project_id,
      name: env.name,
      type: env.type as 'persistent' | 'temporary',
      kind: env.kind as 'standard' | 'preview',
      namespace: env.namespace,
      db_ref: env.db_ref,
      overrides: env.overrides_json,
      labels: env.labels_json,
      current_release_id: env.current_release_id,
      last_failed_release_id: env.last_failed_release_id,
      last_applied_release_id: env.last_applied_release_id ?? null,
      last_deploy_failure: (env.last_deploy_failure_json ?? null) as EnvironmentResponse['last_deploy_failure'],
      deploy_status: (env.deploy_status ?? 'unknown') as 'unknown' | 'deployed' | 'undeployed' | 'deploying' | 'undeploying' | 'failed',
      status: env.status as 'active' | 'suspended' | 'terminated',
      suspended_at: env.suspended_at?.toISOString() ?? null,
      suspension_reason: env.suspension_reason,
      created_at: env.created_at.toISOString(),
      updated_at: env.updated_at.toISOString(),
    };
  }

  private toResponse(project: Awaited<ReturnType<typeof this.projects.findById>> & object): ProjectResponse {
    return {
      id: project.id,
      org_id: project.org_id,
      name: project.name,
      slug: project.slug,
      repo_url: project.repo_url,
      branch: project.branch,
      deleted: project.deleted_at !== null,  // Convert timestamp to boolean
      created_at: project.created_at.toISOString(),
      updated_at: project.updated_at.toISOString(),
    };
  }

  private getSyncedPolicyConfig(xEveYaml: string | null | undefined): {
    policy: Record<string, unknown> | null;
    defaults: Record<string, unknown> | null;
  } {
    if (!xEveYaml) {
      return { policy: null, defaults: null };
    }

    try {
      const parsed = yaml.parse(xEveYaml) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') {
        return { policy: null, defaults: null };
      }

      const root =
        ((parsed['x-eve'] ?? parsed.x_eve) && typeof (parsed['x-eve'] ?? parsed.x_eve) === 'object')
          ? (parsed['x-eve'] ?? parsed.x_eve) as Record<string, unknown>
          : parsed;

      return {
        policy: (root.agents && typeof root.agents === 'object') ? root.agents as Record<string, unknown> : null,
        defaults: (root.defaults && typeof root.defaults === 'object') ? root.defaults as Record<string, unknown> : null,
      };
    } catch {
      return { policy: null, defaults: null };
    }
  }

  private getAgentSummariesFromParsedConfig(
    parsedAgents: Record<string, unknown> | null | undefined,
  ): NonNullable<AgentsConfigResponse['agents']> {
    if (!parsedAgents || typeof parsedAgents !== 'object') {
      return [];
    }

    const agentMap = (parsedAgents as { agents?: Record<string, unknown> }).agents;
    if (!agentMap || typeof agentMap !== 'object') {
      return [];
    }

    return Object.entries(agentMap).map(([agentId, rawAgent]) => {
      const agent = (rawAgent && typeof rawAgent === 'object') ? rawAgent as Record<string, unknown> : {};
      const gateway = (agent.gateway && typeof agent.gateway === 'object') ? agent.gateway as Record<string, unknown> : {};

      return {
        id: agentId,
        slug: typeof agent.slug === 'string' ? agent.slug : null,
        alias: typeof agent.alias === 'string' ? agent.alias : null,
        name: typeof agent.name === 'string' ? agent.name : null,
        description: typeof agent.description === 'string' ? agent.description : null,
        role: typeof agent.role === 'string' ? agent.role : null,
        workflow: typeof agent.workflow === 'string' ? agent.workflow : null,
        harness_profile: typeof agent.harness_profile === 'string' ? agent.harness_profile : null,
        policies: (agent.policies && typeof agent.policies === 'object') ? agent.policies as Record<string, unknown> : null,
        access: (agent.access && typeof agent.access === 'object') ? agent.access as Record<string, unknown> : null,
        gateway_policy:
          gateway.policy === 'discoverable' || gateway.policy === 'routable'
            ? gateway.policy
            : 'none',
        gateway_clients: Array.isArray(gateway.clients)
          ? gateway.clients.filter((value): value is string => typeof value === 'string')
          : null,
      };
    });
  }

  private getTeamSummariesFromParsedConfig(
    parsedTeams: Record<string, unknown> | null | undefined,
  ): TeamListResponse['teams'] {
    if (!parsedTeams || typeof parsedTeams !== 'object') {
      return [];
    }

    const teamMap = (parsedTeams as { teams?: Record<string, unknown> }).teams;
    if (!teamMap || typeof teamMap !== 'object') {
      return [];
    }

    return Object.entries(teamMap).map(([teamId, rawTeam]) => {
      const team = (rawTeam && typeof rawTeam === 'object') ? rawTeam as Record<string, unknown> : {};
      const members = Array.isArray(team.members)
        ? team.members.filter((value): value is string => typeof value === 'string')
        : [];
      const lead = typeof team.lead === 'string' ? team.lead : null;

      if (lead && !members.includes(lead)) {
        members.unshift(lead);
      }

      return {
        id: teamId,
        lead_agent_id: lead,
        dispatch: (team.dispatch && typeof team.dispatch === 'object') ? team.dispatch as Record<string, unknown> : null,
        members,
      };
    });
  }

  private getManifestStructure(manifestYaml: string | null | undefined): {
    services: Record<string, unknown> | null;
    environments: Record<string, unknown> | null;
  } {
    if (!manifestYaml) {
      return { services: null, environments: null };
    }

    try {
      const parsed = yaml.parse(manifestYaml);
      const validated = ManifestSchema.safeParse(parsed);
      if (!validated.success) {
        return { services: null, environments: null };
      }

      return {
        services: validated.data.services ?? null,
        environments: validated.data.environments ?? null,
      };
    } catch {
      return { services: null, environments: null };
    }
  }

  private toManifestResponse(manifest: Awaited<ReturnType<typeof this.manifests.findById>> & object): ManifestResponse {
    const { services, environments } = this.getManifestStructure(
      ('manifest_yaml' in manifest ? (manifest as { manifest_yaml?: string | null }).manifest_yaml : null) ?? null,
    );

    return {
      id: manifest.id,
      project_id: manifest.project_id,
      manifest_hash: manifest.manifest_hash,
      git_sha: manifest.git_sha,
      branch: manifest.branch,
      parsed_defaults: manifest.parsed_defaults,
      parsed_agents: manifest.parsed_agents,
      services,
      environments,
      created_at: manifest.created_at.toISOString(),
      updated_at: manifest.updated_at.toISOString(),
    };
  }

  private async prepareAppLinkReconciliation(
    project: Project,
    manifest: Manifest,
    localCliImages?: Record<string, string>,
  ): Promise<PreparedAppLinkReconciliation> {
    const appLinks = getManifestAppLinks(manifest);
    const services = getServicesFromManifest(manifest) ?? {};
    const producerEnvNames = await this.getKnownEnvironmentNames(project.id, manifest);
    const grants: PreparedAppLinkGrant[] = [];
    const grantKeys = new Set<string>();
    const subscriptions: PreparedAppLinkSubscription[] = [];
    const subscriptionAliases = new Set<string>();
    const warnings: string[] = [];

    await this.prepareProducerAppLinkGrants({
      project,
      services,
      producerEnvNames,
      appLinks,
      localCliImages,
      grants,
      grantKeys,
      warnings,
    });

    await this.prepareConsumerAppLinkSubscriptions({
      project,
      services,
      manifest,
      appLinks,
      subscriptions,
      subscriptionAliases,
    });

    return {
      grants,
      grantKeys,
      subscriptions,
      subscriptionAliases,
      warnings,
    };
  }

  private async prepareProducerAppLinkGrants(input: {
    project: Project;
    services: Record<string, Service>;
    producerEnvNames: Set<string>;
    appLinks: AppLinks | null;
    localCliImages?: Record<string, string>;
    grants: PreparedAppLinkGrant[];
    grantKeys: Set<string>;
    warnings: string[];
  }): Promise<void> {
    const exports = input.appLinks?.exports;
    if (!exports) return;

    for (const [exportName, apiExport] of Object.entries(exports.apis ?? {})) {
      const service = input.services[apiExport.service];
      if (!service) {
        throw new BadRequestException(
          `app_links.exports.apis.${exportName}: service "${apiExport.service}" does not exist`,
        );
      }

      const xEve = this.getServiceXeve(service);
      if (!xEve?.api_spec && (!Array.isArray(xEve?.api_specs) || xEve.api_specs.length === 0)) {
        throw new BadRequestException(
          `app_links.exports.apis.${exportName}: service "${apiExport.service}" must declare x-eve.api_spec or x-eve.api_specs`,
        );
      }

      let cliName: string | null = null;
      let cliImage: string | null = null;
      let cliBinPath: string | null = null;
      if (apiExport.cli) {
        const cli = xEve?.cli;
        if (!cli || cli.name !== apiExport.cli) {
          throw new BadRequestException(
            `app_links.exports.apis.${exportName}: cli "${apiExport.cli}" must match service "${apiExport.service}" x-eve.cli.name`,
          );
        }
        if (!cli.image) {
          throw new BadRequestException(
            `app_links.exports.apis.${exportName}: cross-project CLI export "${apiExport.cli}" requires x-eve.cli.image`,
          );
        }
        cliName = cli.name;
        cliImage = this.resolveLocalCliImageOverride(input.localCliImages, {
          cliName: cli.name,
          serviceName: apiExport.service,
          exportName,
        }) ?? cli.image;
        cliBinPath = cli.bin;
      }

      for (const [consumerIndex, consumer] of apiExport.consumers.entries()) {
        const consumerProject = await this.resolveAppLinkProjectRef(
          input.project,
          consumer.project,
          `app_links.exports.apis.${exportName}.consumers[${consumerIndex}].project`,
        );
        this.assertSubset(
          consumer.scopes,
          apiExport.scopes,
          `Consumer ${consumerProject.slug} requested scope`,
          `producer export ${exportName}`,
        );
        for (const envName of consumer.envs) {
          if (!input.producerEnvNames.has(envName)) {
            throw new BadRequestException(
              `app_links.exports.apis.${exportName}.consumers[${consumerIndex}].envs: producer environment "${envName}" does not exist`,
            );
          }
        }

        const grant: PreparedAppLinkGrant = {
          producer_project_id: input.project.id,
          export_kind: 'api',
          export_name: exportName,
          consumer_project_id: consumerProject.id,
          api_scopes: [...consumer.scopes],
          event_types: [],
          envs: [...consumer.envs],
          service_name: apiExport.service,
          cli_name: cliName,
          cli_image: cliImage,
          cli_bin_path: cliBinPath,
        };
        input.grants.push(grant);
        input.grantKeys.add(this.appLinkGrantKey(grant));
      }
    }

    for (const [exportName, eventExport] of Object.entries(exports.events ?? {})) {
      for (const eventType of eventExport.types) {
        if (!/^(app|runner)\./.test(eventType)) {
          input.warnings.push(
            `app_links.exports.events.${exportName}: event type "${eventType}" should normally start with app. or runner.`,
          );
        }
      }

      for (const [consumerIndex, consumer] of eventExport.consumers.entries()) {
        const consumerProject = await this.resolveAppLinkProjectRef(
          input.project,
          consumer.project,
          `app_links.exports.events.${exportName}.consumers[${consumerIndex}].project`,
        );
        const grantedTypes = consumer.types ?? eventExport.types;
        this.assertSubset(
          grantedTypes,
          eventExport.types,
          `Consumer ${consumerProject.slug} requested event type`,
          `producer event export ${exportName}`,
        );

        const grant: PreparedAppLinkGrant = {
          producer_project_id: input.project.id,
          export_kind: 'events',
          export_name: exportName,
          consumer_project_id: consumerProject.id,
          api_scopes: [],
          event_types: [...grantedTypes],
          envs: [],
          service_name: null,
          cli_name: null,
          cli_image: null,
          cli_bin_path: null,
        };
        input.grants.push(grant);
        input.grantKeys.add(this.appLinkGrantKey(grant));
      }
    }
  }

  private resolveLocalCliImageOverride(
    localCliImages: Record<string, string> | undefined,
    keys: { cliName: string; serviceName: string; exportName: string },
  ): string | null {
    if (!localCliImages) return null;
    for (const key of [keys.cliName, keys.serviceName, keys.exportName]) {
      const image = localCliImages[key];
      if (typeof image === 'string' && image.trim().length > 0) {
        return image.trim();
      }
    }
    return null;
  }

  private async prepareConsumerAppLinkSubscriptions(input: {
    project: Project;
    services: Record<string, Service>;
    manifest: Manifest;
    appLinks: AppLinks | null;
    subscriptions: PreparedAppLinkSubscription[];
    subscriptionAliases: Set<string>;
  }): Promise<void> {
    const consumes = input.appLinks?.consumes ?? {};
    const consumerEnvNames = await this.getKnownEnvironmentNames(input.project.id, input.manifest);

    for (const [alias, consume] of Object.entries(consumes)) {
      const producer = await this.resolveAppLinkProjectRef(
        input.project,
        consume.project,
        `app_links.consumes.${alias}.project`,
      );
      let apiGrant: ProjectAppLinkGrant | null = null;
      let eventGrant: ProjectAppLinkGrant | null = null;

      if (consume.api) {
        apiGrant = await this.findUsableGrant({
          producerProject: producer,
          consumerProject: input.project,
          exportKind: 'api',
          exportName: consume.api,
          path: `app_links.consumes.${alias}.api`,
        });

        this.assertSubset(
          consume.scopes,
          apiGrant.api_scopes,
          `Consumer ${input.project.slug} requested scope`,
          `producer ${producer.slug} grant ${consume.api}`,
        );
        this.validateConsumeEnvironment(alias, consume.environment, apiGrant, consumerEnvNames);
      }

      if (consume.events) {
        eventGrant = await this.findUsableGrant({
          producerProject: producer,
          consumerProject: input.project,
          exportKind: 'events',
          exportName: consume.events.feed,
          path: `app_links.consumes.${alias}.events.feed`,
        });
        const requestedTypes = consume.events.types.length > 0
          ? consume.events.types
          : eventGrant.event_types;
        this.assertSubset(
          requestedTypes,
          eventGrant.event_types,
          `Consumer ${input.project.slug} requested event type`,
          `producer ${producer.slug} event grant ${consume.events.feed}`,
        );
      }

      const injectInto = consume.inject_into;
      const injectServices = injectInto?.services ?? [];
      for (const serviceName of injectServices) {
        if (!input.services[serviceName]) {
          throw new BadRequestException(
            `app_links.consumes.${alias}.inject_into.services: service "${serviceName}" does not exist`,
          );
        }
      }

      const environmentStrategy = consume.environment === 'same' ? 'same' : 'fixed';
      const subscription: PreparedAppLinkSubscription = {
        consumer_project_id: input.project.id,
        local_alias: alias,
        api_grant_id: apiGrant?.id ?? null,
        event_grant_id: eventGrant?.id ?? null,
        requested_scopes: [...consume.scopes],
        event_types: consume.events
          ? (consume.events.types.length > 0 ? [...consume.events.types] : [...(eventGrant?.event_types ?? [])])
          : [],
        environment_strategy: environmentStrategy,
        producer_env_name: environmentStrategy === 'fixed' ? consume.environment : null,
        inject_into_services: [...injectServices],
        inject_into_jobs: injectInto?.jobs ?? false,
      };
      input.subscriptions.push(subscription);
      input.subscriptionAliases.add(alias);
    }
  }

  private async applyAppLinkReconciliation(
    projectId: string,
    reconciliation: PreparedAppLinkReconciliation,
  ): Promise<void> {
    for (const grant of reconciliation.grants) {
      await this.appLinkGrants.upsert({
        id: generateAppLinkGrantId(),
        ...grant,
      });
    }
    await this.appLinkGrants.revokeMissing(projectId, reconciliation.grantKeys);

    for (const subscription of reconciliation.subscriptions) {
      await this.appLinkSubscriptions.upsert({
        id: generateAppLinkSubscriptionId(),
        ...subscription,
      });
    }
    await this.appLinkSubscriptions.deleteMissingForConsumer(
      projectId,
      reconciliation.subscriptionAliases,
    );
  }

  private async resolveAppLinkProjectRef(
    currentProject: Project,
    ref: string,
    path: string,
  ): Promise<Project> {
    const project = ref.startsWith('proj_')
      ? await this.projects.findById(ref, { include_deleted: false })
      : await this.projects.findByOrgAndSlug(currentProject.org_id, ref, { include_deleted: false });

    if (!project) {
      throw new BadRequestException(`${path}: project not found: ${ref}`);
    }
    if (project.org_id !== currentProject.org_id) {
      throw new BadRequestException(`${path}: cross-org app links are not supported in v1`);
    }
    return project;
  }

  private async getKnownEnvironmentNames(projectId: string, manifest: Manifest): Promise<Set<string>> {
    const names = new Set<string>(Object.keys(manifest.environments ?? {}));
    try {
      const rows = await this.envs.listByProject(projectId);
      for (const row of rows) {
        names.add(row.name);
      }
    } catch {
      // Environment rows may not exist during early syncs. Manifest names are enough for validation.
    }
    return names;
  }

  private getServiceXeve(service: Service): NonNullable<Service['x_eve']> | undefined {
    return service['x-eve'] ?? service.x_eve;
  }

  private assertSubset(
    requested: string[],
    allowed: string[],
    requestedLabel: string,
    allowedLabel: string,
  ): void {
    const allowedSet = new Set(allowed);
    const missing = requested.filter((value) => !allowedSet.has(value));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${requestedLabel} ${missing.map((value) => `"${value}"`).join(', ')}, but ${allowedLabel} only grants ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
      );
    }
  }

  private validateConsumeEnvironment(
    alias: string,
    environment: string,
    grant: ProjectAppLinkGrant,
    consumerEnvNames: Set<string>,
  ): void {
    if (environment !== 'same') {
      if (grant.envs.length > 0 && !grant.envs.includes(environment)) {
        throw new BadRequestException(
          `app_links.consumes.${alias}.environment: producer grant allows ${grant.envs.join(', ') || '(none)'}, not "${environment}"`,
        );
      }
      return;
    }

    if (grant.envs.length === 0 || consumerEnvNames.size === 0) {
      return;
    }

    const missing = [...consumerEnvNames].filter((name) => !grant.envs.includes(name));
    if (missing.length > 0) {
      throw new BadRequestException(
        `app_links.consumes.${alias}.environment: same-env link is not granted for producer env(s): ${missing.join(', ')}`,
      );
    }
  }

  private async findUsableGrant(input: {
    producerProject: Project;
    consumerProject: Project;
    exportKind: 'api' | 'events';
    exportName: string;
    path: string;
  }): Promise<ProjectAppLinkGrant> {
    const grant = await this.appLinkGrants.findActive({
      producer_project_id: input.producerProject.id,
      export_kind: input.exportKind,
      export_name: input.exportName,
      consumer_project_id: input.consumerProject.id,
    });
    if (grant) return grant;

    const existing = (await this.appLinkGrants.listByConsumer(input.consumerProject.id, true))
      .find((candidate) => (
        candidate.producer_project_id === input.producerProject.id
        && candidate.export_kind === input.exportKind
        && candidate.export_name === input.exportName
      ));
    if (existing?.revoked_at) {
      throw new BadRequestException(
        `${input.path}: grant from producer ${input.producerProject.slug} is revoked at ${existing.revoked_at.toISOString()}`,
      );
    }

    throw new BadRequestException(
      `${input.path}: no active ${input.exportKind} grant "${input.exportName}" from producer ${input.producerProject.slug} to consumer ${input.consumerProject.slug}`,
    );
  }

  private appLinkGrantKey(grant: Pick<PreparedAppLinkGrant, 'export_kind' | 'export_name' | 'consumer_project_id'>): string {
    return `${grant.export_kind}:${grant.export_name}:${grant.consumer_project_id}`;
  }

  private async normalizeProjectAuthConfig(
    projectOrgId: string,
    authConfig: ProjectAuthConfig | null,
  ): Promise<ProjectAuthConfig | null> {
    if (!authConfig) return null;

    const orgAccess = authConfig.org_access;

    let resolvedAllowedOrgs: string[];
    if (orgAccess.mode === 'project_org') {
      resolvedAllowedOrgs = [projectOrgId];
    } else {
      resolvedAllowedOrgs = [];
      for (const ref of orgAccess.allowed_orgs) {
        const org = ref.startsWith('org_')
          ? await this.orgs.findById(ref, { include_deleted: false })
          : await this.orgs.findBySlug(ref, { include_deleted: false });
        if (!org) {
          throw new BadRequestException(`Allowed org not found: ${ref}`);
        }
        if (!resolvedAllowedOrgs.includes(org.id)) {
          resolvedAllowedOrgs.push(org.id);
        }
      }
    }

    const domainSignup = orgAccess.domain_signup;
    let resolvedDomainSignup = domainSignup;
    if (domainSignup.enabled) {
      // Resolve each rule's target_org slug → canonical id, then validate it
      // falls inside the project's effective allowed_orgs. Rules keep their
      // declaration order so first-match precedence is preserved at runtime.
      const resolvedRules: AppDomainSignupRule[] = [];
      for (const [index, rule] of domainSignup.domains.entries()) {
        const ref = rule.target_org;
        const org = ref.startsWith('org_')
          ? await this.orgs.findById(ref, { include_deleted: false })
          : await this.orgs.findBySlug(ref, { include_deleted: false });
        if (!org) {
          throw new BadRequestException(
            `domain_signup.domains[${index}] ("${rule.domain}"): target_org not found: ${ref}`,
          );
        }
        if (!resolvedAllowedOrgs.includes(org.id)) {
          throw new BadRequestException(
            `domain_signup.domains[${index}] ("${rule.domain}"): target_org ${org.id} must be one of the app's allowed_orgs`,
          );
        }
        resolvedRules.push({ ...rule, target_org: org.id });
      }
      resolvedDomainSignup = {
        ...domainSignup,
        domains: resolvedRules,
      };
    }

    return {
      ...authConfig,
      org_access: {
        ...orgAccess,
        allowed_orgs: resolvedAllowedOrgs,
        domain_signup: resolvedDomainSignup,
      },
    };
  }

  private toAgentsSyncResponse(config: {
    id: string;
    project_id: string;
    parsed_agents: Record<string, unknown> | null;
    parsed_teams: Record<string, unknown> | null;
    parsed_routes: unknown[] | null;
    pack_refs: Array<{ id: string; source: string; ref: string }> | null;
    git_sha: string | null;
    branch: string | null;
    git_ref: string | null;
    created_at: Date;
    updated_at: Date;
  }): AgentsSyncResponse {
    return {
      id: config.id,
      project_id: config.project_id,
      parsed_agents: config.parsed_agents,
      parsed_teams: config.parsed_teams,
      parsed_routes: config.parsed_routes,
      pack_refs: config.pack_refs,
      git_sha: config.git_sha,
      branch: config.branch,
      git_ref: config.git_ref,
      created_at: config.created_at.toISOString(),
      updated_at: config.updated_at.toISOString(),
    };
  }

  private async reconcileIngressAliases(projectId: string, manifest: Manifest): Promise<void> {
    const aliases = getManifestIngressAliases(manifest);
    const tcpAliases = getManifestTcpIngressAliases(manifest);
    assertUniqueManifestIngressAliases(aliases);
    assertUniqueManifestIngressAliases(tcpAliases);
    for (const alias of tcpAliases.keys()) {
      if (aliases.has(alias)) {
        throw new BadRequestException(`Ingress alias "${alias}" is declared for both HTTP and TCP ingress`);
      }
    }
    const allAliases = new Map([...aliases.entries(), ...tcpAliases.entries()]);

    try {
      await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const txIngressAliases = ingressAliasQueries(tx);
        const existingClaims = await txIngressAliases.findByProject(projectId);
        const desiredAliases = new Set(allAliases.keys());

        for (const [alias, serviceName] of allAliases.entries()) {
          const row = await txIngressAliases.claimOrUpdate({
            id: generateIngressAliasId(),
            alias,
            project_id: projectId,
            service_name: serviceName,
          });

          if (!row || row.project_id !== projectId) {
            throw new ConflictException(`Ingress alias "${alias}" is already claimed by another project`);
          }
        }

        for (const claim of existingClaims) {
          if (!desiredAliases.has(claim.alias)) {
            await txIngressAliases.release(claim.alias, projectId);
          }
        }
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('One or more ingress aliases are already claimed');
      }
      throw error;
    }
  }

  private async reconcileCustomDomains(projectId: string, manifest: Manifest): Promise<string[]> {
    const declarations = getManifestCustomDomainDeclarations(manifest);
    assertUniqueManifestCustomDomainDeclarations(declarations);
    const desired = getManifestCustomDomainDesiredState(manifest);
    this.validateManifestCustomDomainServices(manifest, desired);
    const warnings: string[] = [];

    try {
      await this.db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const txCustomDomains = customDomainQueries(tx);
        const txEnvironments = environmentQueries(tx);
        const existingClaims = await txCustomDomains.findByProject(projectId);
        const desiredHostnames = new Set(desired.keys());

        for (const state of desired.values()) {
          const row = await txCustomDomains.claimOrUpdate({
            id: generateCustomDomainId(),
            hostname: state.hostname,
            project_id: projectId,
            service_name: state.service_name,
            source: 'manifest',
          });

          if (!row || row.project_id !== projectId) {
            throw new ConflictException(`Custom domain "${state.hostname}" is already claimed by another project`);
          }

          if (state.env_names.length === 1) {
            const envName = state.env_names[0];
            const environment = await ensureManifestEnvironment(txEnvironments, projectId, envName, manifest);
            if (!environment) {
              throw new BadRequestException(
                `Custom domain "${state.hostname}" references unknown environment "${envName}" at ${state.origin_paths.join(', ')}`,
              );
            }

            const bound = await txCustomDomains.bindToEnvironment(
              state.hostname,
              projectId,
              environment.id,
              state.service_name,
              'manifest',
            );

            if (!bound) {
              const owner = row.environment_id
                ? await txEnvironments.findById(row.environment_id)
                : null;
              const ownerName = owner?.name ?? row.environment_id ?? 'unknown';
              warnings.push(
                `Custom domain "${state.hostname}" is already owned by environment "${ownerName}". ` +
                `To move it, run: eve domain transfer ${state.hostname} --to ${envName}`,
              );
            }
            continue;
          }

          if (state.env_names.length > 1) {
            if (!row.environment_id) {
              warnings.push(
                `Custom domain "${state.hostname}" is declared in multiple environments (${state.env_names.join(', ')}) and is unbound. ` +
                `Run eve domain transfer ${state.hostname} --to <env> to choose the owner explicitly.`,
              );
              continue;
            }

            const owner = await txEnvironments.findById(row.environment_id);
            if (!owner || !state.env_names.includes(owner.name)) {
              const ownerName = owner?.name ?? row.environment_id;
              warnings.push(
                `Custom domain "${state.hostname}" is declared in multiple environments (${state.env_names.join(', ')}) but is owned by "${ownerName}". ` +
                `Run eve domain transfer ${state.hostname} --to <env> to choose one of the declared owners.`,
              );
            }
          }
        }

        for (const claim of existingClaims) {
          if (!desiredHostnames.has(claim.hostname)) {
            await txCustomDomains.releaseManifestManaged(claim.hostname, projectId);
          }
        }
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        throw new ConflictException('One or more custom domains are already claimed');
      }
      throw error;
    }

    return warnings;
  }

  private validateManifestCustomDomainServices(
    manifest: Manifest,
    desired: Map<string, ManifestCustomDomainDesiredState>,
  ): void {
    const baseServices = manifest.services ?? {};
    for (const state of desired.values()) {
      if (state.has_project_scope && !baseServices[state.service_name]) {
        throw new BadRequestException(
          `Custom domain "${state.hostname}" references missing service "${state.service_name}" at ${state.origin_paths.join(', ')}`,
        );
      }

      for (const envName of state.env_names) {
        const envConfig = manifest.environments?.[envName];
        if (!envConfig) {
          throw new BadRequestException(
            `Custom domain "${state.hostname}" references unknown environment "${envName}" at ${state.origin_paths.join(', ')}`,
          );
        }

        const envServices = this.getManifestEnvironmentServiceNames(manifest, envName);
        if (!envServices.has(state.service_name)) {
          throw new BadRequestException(
            `Custom domain "${state.hostname}" references missing service "${state.service_name}" for environment "${envName}" at ${state.origin_paths.join(', ')}`,
          );
        }
      }
    }
  }

  private getManifestEnvironmentServiceNames(manifest: Manifest, envName: string): Set<string> {
    const serviceNames = new Set(Object.keys(manifest.services ?? {}));
    const envConfig = manifest.environments?.[envName];
    const overrides = envConfig?.overrides;
    if (!overrides || typeof overrides !== 'object') {
      return serviceNames;
    }

    const services = (overrides as Record<string, unknown>).services;
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      return serviceNames;
    }

    for (const serviceName of Object.keys(services)) {
      serviceNames.add(serviceName);
    }
    return serviceNames;
  }

  private parseYaml(content: string, label: string): unknown {
    try {
      return yaml.parse(content);
    } catch (error) {
      throw new BadRequestException(
        `Invalid ${label} yaml: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  private normalizeChatConfig(raw: unknown): Record<string, unknown> {
    const base = this.extractChatObject(raw);
    if (!base || typeof base !== 'object') {
      return {};
    }
    const record = base as Record<string, unknown>;
    if (record.routes || record.default_route || record.version) {
      return record;
    }

    const routes: Array<{ id: string; match: string; target: string }> = [];
    const commands = Array.isArray(record.commands) ? record.commands : [];
    commands.forEach((command, index) => {
      if (!command || typeof command !== 'object') {
        return;
      }
      const commandRecord = command as Record<string, unknown>;
      const id = typeof commandRecord.id === 'string'
        ? commandRecord.id
        : `legacy_command_${index + 1}`;
      const matchCandidate = commandRecord.match ?? commandRecord.pattern ?? commandRecord.command;
      const match = typeof matchCandidate === 'string' ? matchCandidate : null;
      const target = this.resolveLegacyTarget(commandRecord);
      if (match && target) {
        routes.push({ id, match, target });
      }
    });

    const defaultAssistant = this.resolveLegacyDefaultAssistant(record);
    let defaultRouteId: string | undefined;
    if (defaultAssistant) {
      defaultRouteId = 'route_default';
      routes.push({
        id: defaultRouteId,
        match: '.*',
        target: defaultAssistant,
      });
    }

    if (routes.length === 0) {
      return record;
    }

    const normalized: Record<string, unknown> = {
      version: 1,
      routes,
    };
    if (defaultRouteId) {
      normalized.default_route = defaultRouteId;
    }
    return normalized;
  }

  private extractChatObject(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') {
      return raw;
    }
    const record = raw as Record<string, unknown>;
    if (record.chat && typeof record.chat === 'object') {
      return record.chat;
    }
    return record;
  }

  private resolveLegacyDefaultAssistant(record: Record<string, unknown>): string | null {
    const defaultCandidate = record.default_assistant ?? record.default ?? record.assistant;
    if (typeof defaultCandidate === 'string' && defaultCandidate.length > 0) {
      return this.toTarget(defaultCandidate);
    }
    const assistants = record.assistants;
    if (Array.isArray(assistants) && typeof assistants[0] === 'string') {
      return this.toTarget(String(assistants[0]));
    }
    return null;
  }

  private resolveLegacyTarget(command: Record<string, unknown>): string | null {
    const direct = command.target;
    if (typeof direct === 'string' && direct.length > 0) {
      return this.toTarget(direct);
    }
    if (typeof command.agent === 'string') return this.toTarget(command.agent);
    if (typeof command.assistant === 'string') return this.toTarget(command.assistant);
    if (typeof command.team === 'string') return `team:${command.team}`;
    if (typeof command.workflow === 'string') return `workflow:${command.workflow}`;
    if (typeof command.pipeline === 'string') return `pipeline:${command.pipeline}`;
    return null;
  }

  private toTarget(value: string): string {
    return value.includes(':') ? value : `agent:${value}`;
  }

  private async validateAgentAccessAgainstManifest(
    projectId: string,
    agents: Record<string, { access?: { envs?: string[]; services?: string[]; api_specs?: string[] } }>,
  ): Promise<void> {
    const envAccess = new Set<string>();
    const serviceAccess = new Set<string>();

    for (const agent of Object.values(agents)) {
      for (const env of agent.access?.envs ?? []) {
        envAccess.add(env);
      }
      for (const service of agent.access?.services ?? []) {
        serviceAccess.add(service);
      }
    }

    if (envAccess.size === 0 && serviceAccess.size === 0) {
      return;
    }

    const manifest = await this.manifests.findLatestByProject(projectId);
    if (!manifest) {
      throw new BadRequestException('Manifest must be synced before validating agent access lists.');
    }

    const parsed = this.parseYaml(manifest.manifest_yaml, 'manifest');
    const validated = ManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new BadRequestException(`Invalid stored manifest: ${validated.error.message}`);
    }

    const environments = validated.data.environments ?? {};
    const services = validated.data.services ?? {};

    for (const env of envAccess) {
      if (!Object.prototype.hasOwnProperty.call(environments, env)) {
        throw new BadRequestException(`Agent access env ${env} does not exist in manifest environments.`);
      }
    }

    for (const service of serviceAccess) {
      if (!Object.prototype.hasOwnProperty.call(services, service)) {
        throw new BadRequestException(`Agent access service ${service} does not exist in manifest services.`);
      }
    }
  }

  private toReleaseResponse(release: Awaited<ReturnType<typeof this.releases.findById>> & object): ReleaseResponse {
    return {
      id: release.id,
      project_id: release.project_id,
      git_sha: release.git_sha,
      manifest_hash: release.manifest_hash,
      image_digests: release.image_digests_json,
      build_id: release.build_id,
      version: release.version,
      tag: release.tag,
      created_by: release.created_by,
      created_at: release.created_at.toISOString(),
    };
  }

  // ── Environment teardown helpers (for project delete) ───────────────

  private async teardownEnvironmentDeployment(
    envId: string,
    force = false,
  ): Promise<void> {
    let workerUrl: string;
    try {
      workerUrl = this.resolveWorkerUrl();
    } catch {
      this.logger.warn(`[project-delete] Worker URL unavailable, skipping deployment teardown for env ${envId}`);
      return;
    }

    try {
      const response = await fetch(`${workerUrl}/environments/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env_id: envId }),
      });

      if (response.ok) {
        return;
      }

      const text = await response.text();
      const lower = `${response.status} ${text}`.toLowerCase();
      if (response.status === 404 || lower.includes('not found')) {
        this.logger.log(`[project-delete] Deployment namespace already absent for env ${envId}`);
        return;
      }

      if (force) {
        this.logger.warn(`[project-delete] Worker delete failed (force=true) for env ${envId}: ${response.status} ${text || response.statusText}`);
        return;
      }

      throw new ServiceUnavailableException(
        `Worker environment delete failed (${response.status}): ${text || response.statusText}`,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        if (force) {
          this.logger.warn(`[project-delete] Worker delete failed (force=true) for env ${envId}: ${(error as Error).message}`);
          return;
        }
        throw error;
      }
      if (force) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[project-delete] Worker delete failed (force=true) for env ${envId}: ${message}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(`Failed to teardown environment deployment: ${message}`);
    }
  }

  private resolveWorkerUrl(): string {
    const mapping = process.env.EVE_WORKER_URLS ?? '';
    if (mapping.trim().length > 0) {
      const entries = mapping
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [name, url] = entry.split('=');
          return { name: name?.trim() ?? '', url: url?.trim() ?? '' };
        })
        .filter((entry) => entry.name && entry.url);

      const defaultEntry = entries.find((entry) => entry.name === 'default-worker');
      if (defaultEntry) {
        return defaultEntry.url;
      }

      if (entries.length > 0) {
        return entries[0].url;
      }
    }

    if (process.env.WORKER_URL) {
      return process.env.WORKER_URL;
    }

    throw new ServiceUnavailableException('WORKER_URL or EVE_WORKER_URLS must be set to delete environment deployments');
  }
}

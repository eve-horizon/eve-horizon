import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { resolveWorkerUrl } from '../common/worker-url';
import type { Db } from '@eve/db';
import {
  projectQueries,
  orgQueries,
  membershipQueries,
  userQueries,
  releaseQueries,
  agentConfigQueries,
  agentQueries,
  teamQueries,
  threadQueries,
  scheduleQueries,
  spendQueries,
  environmentQueries,
} from '@eve/db';
import {
  generateProjectId,
  generateEnvironmentId,
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
  generateScheduleId,
  type ProjectSpendResponse,
  type BootstrapProjectRequest,
  type BootstrapProjectResponse,
  type EnvironmentResponse,
} from '@eve/shared';
import { ManifestService } from './manifest.service.js';
import { AgentsConfigService } from './agents-config.service.js';

// Regex for valid slug: 4-8 chars, starts with letter, alphanumeric
const SLUG_REGEX = /^[A-Za-z][A-Za-z0-9]{3,7}$/;

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
  private memberships: ReturnType<typeof membershipQueries>;
  private users: ReturnType<typeof userQueries>;
  private releases: ReturnType<typeof releaseQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private teams: ReturnType<typeof teamQueries>;
  private threads: ReturnType<typeof threadQueries>;
  private schedules: ReturnType<typeof scheduleQueries>;
  private spend: ReturnType<typeof spendQueries>;
  private envs: ReturnType<typeof environmentQueries>;

  constructor(
    @Inject('DB') db: Db,
    private readonly manifestService: ManifestService,
    private readonly agentsConfigService: AgentsConfigService,
  ) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.memberships = membershipQueries(db);
    this.users = userQueries(db);
    this.releases = releaseQueries(db);
    this.agentConfigs = agentConfigQueries(db);
    this.agents = agentQueries(db);
    this.teams = teamQueries(db);
    this.threads = threadQueries(db);
    this.schedules = scheduleQueries(db);
    this.spend = spendQueries(db);
    this.envs = environmentQueries(db);
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

  // ── Manifest + agents-config subsystems (delegated) ─────────────────
  // Implementations live in ManifestService / AgentsConfigService; these
  // delegates keep the public surface unchanged for controllers.

  async syncManifest(projectId: string, data: SyncManifestRequest): Promise<ManifestResponse> {
    return this.manifestService.syncManifest(projectId, data);
  }

  async syncAgentsConfig(projectId: string, data: AgentsSyncRequest): Promise<AgentsSyncResponse> {
    return this.agentsConfigService.syncAgentsConfig(projectId, data);
  }

  async getLatestManifest(projectId: string): Promise<ManifestResponse | null> {
    return this.manifestService.getLatestManifest(projectId);
  }

  async validateManifest(
    projectId: string,
    data: ManifestValidateRequest,
  ): Promise<ManifestValidateResponse> {
    return this.manifestService.validateManifest(projectId, data);
  }

  async getAgentsConfig(projectId: string, includeHarnesses: boolean): Promise<AgentsConfigResponse> {
    return this.agentsConfigService.getAgentsConfig(projectId, includeHarnesses);
  }

  async listTeams(projectId: string): Promise<TeamListResponse> {
    return this.agentsConfigService.listTeams(projectId);
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
      workerUrl = resolveWorkerUrl('delete environment deployments');
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

}

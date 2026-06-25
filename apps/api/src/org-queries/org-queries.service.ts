import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { orgQueryQueries, orgQueries } from '@eve/db';
import type {
  OrgJobListResponse,
  OrgJobStatsResponse,
  OrgEventListResponse,
  OrgAgentsListResponse,
  OrgJobQueryParams,
  OrgEventQueryParams,
} from '@eve/shared';

@Injectable()
export class OrgQueriesService {
  private queries: ReturnType<typeof orgQueryQueries>;
  private orgs: ReturnType<typeof orgQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.queries = orgQueryQueries(db);
    this.orgs = orgQueries(db);
  }

  /**
   * Resolve an org by ID or slug, throwing NotFoundException if not found.
   */
  private async resolveOrgId(orgIdOrSlug: string): Promise<string> {
    // Try by ID first
    const byId = await this.orgs.findById(orgIdOrSlug);
    if (byId) return byId.id;

    // Try by slug
    const bySlug = await this.orgs.findBySlug(orgIdOrSlug);
    if (bySlug) return bySlug.id;

    throw new NotFoundException(`Organization ${orgIdOrSlug} not found`);
  }

  /**
   * Get the list of project IDs the caller has access to within an org.
   * For admin/system callers, userId may be undefined — in that case,
   * return all projects in the org.
   */
  private async getAccessibleProjectIds(
    orgId: string,
    userId?: string,
  ): Promise<string[]> {
    if (!userId) {
      // System/admin caller: return all projects in the org
      const rows = await this.db<{ id: string }[]>`
        SELECT id FROM projects
        WHERE org_id = ${orgId} AND deleted_at IS NULL
      `;
      return rows.map((r) => r.id);
    }

    return this.queries.getAccessibleProjectIds(orgId, userId);
  }

  // --------------------------------------------------------------------------
  // Jobs
  // --------------------------------------------------------------------------

  async findJobs(
    orgIdOrSlug: string,
    params: OrgJobQueryParams,
    userId?: string,
  ): Promise<OrgJobListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getAccessibleProjectIds(orgId, userId);

    const limit = params.limit ?? 50;
    const result = await this.queries.findJobsAcrossProjects(projectIds, {
      status: params.status,
      agent_slug: params.agent_slug,
      project_id: params.project_id,
      limit,
      cursor: params.cursor,
    });

    return {
      items: result.items.map((row) => ({
        id: row.id,
        project_id: row.project_id,
        project_slug: row.project_slug,
        project_name: row.project_name,
        title: row.title,
        phase: row.phase,
        priority: row.priority,
        assignee: row.assignee,
        labels: row.labels,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
      pagination: {
        limit,
        has_more: result.next_cursor !== null,
        next_cursor: result.next_cursor,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Job Stats
  // --------------------------------------------------------------------------

  async jobStats(
    orgIdOrSlug: string,
    userId?: string,
  ): Promise<OrgJobStatsResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getAccessibleProjectIds(orgId, userId);

    const stats = await this.queries.jobStats(projectIds);

    const byPhase: Record<string, number> = {};
    for (const row of stats.byPhase) {
      byPhase[row.phase] = row.count;
    }

    return {
      total: stats.total,
      by_phase: byPhase,
      by_project: stats.byProject.map((row) => ({
        project_id: row.project_id,
        project_name: row.project_name,
        count: row.count,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Events
  // --------------------------------------------------------------------------

  async findEvents(
    orgIdOrSlug: string,
    params: OrgEventQueryParams,
    userId?: string,
  ): Promise<OrgEventListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getAccessibleProjectIds(orgId, userId);

    const limit = params.limit ?? 50;
    const result = await this.queries.findEventsAcrossProjects(projectIds, {
      type: params.type,
      since: params.since,
      limit,
      cursor: params.cursor,
    });

    return {
      items: result.items.map((row) => ({
        id: row.id,
        project_id: row.project_id,
        project_slug: row.project_slug,
        type: row.type,
        source: row.source,
        status: row.status,
        created_at: row.created_at.toISOString(),
      })),
      pagination: {
        limit,
        has_more: result.next_cursor !== null,
        next_cursor: result.next_cursor,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Agents
  // --------------------------------------------------------------------------

  async findAgents(
    orgIdOrSlug: string,
    userId?: string,
  ): Promise<OrgAgentsListResponse> {
    const orgId = await this.resolveOrgId(orgIdOrSlug);
    const projectIds = await this.getAccessibleProjectIds(orgId, userId);

    const rows = await this.queries.findAgentsAcrossProjects(projectIds);

    return {
      items: rows.map((row) => ({
        project_id: row.project_id,
        project_slug: row.project_slug,
        project_name: row.project_name,
        agent_id: row.agent_id,
        agent_slug: row.agent_slug,
        agent_name: row.agent_name,
        agent_description: row.agent_description,
        role: row.role,
        workflow: row.workflow,
        gateway_policy: row.gateway_policy,
      })),
      total: rows.length,
    };
  }
}

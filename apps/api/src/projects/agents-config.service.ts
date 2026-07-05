import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { Db } from '@eve/db';
import {
  projectQueries,
  orgQueries,
  projectManifestQueries,
  agentConfigQueries,
  agentQueries,
  teamQueries,
  teamMemberQueries,
} from '@eve/db';
import {
  generateAgentConfigId,
  type AgentsSyncRequest,
  type AgentsSyncResponse,
  type AgentsConfigResponse,
  type TeamListResponse,
  ManifestSchema,
  AgentsYamlSchema,
  TeamsYamlSchema,
  ChatYamlSchema,
  listHarnesses,
  getHarnessInfo,
  getHarnessAuthStatus,
  listHarnessVariants,
  getHarnessCapability,
  isReservedAgentAlias,
  isValidPermission,
} from '@eve/shared';
import * as yaml from 'yaml';

@Injectable()
export class AgentsConfigService {
  private projects: ReturnType<typeof projectQueries>;
  private orgs: ReturnType<typeof orgQueries>;
  private manifests: ReturnType<typeof projectManifestQueries>;
  private agentConfigs: ReturnType<typeof agentConfigQueries>;
  private agents: ReturnType<typeof agentQueries>;
  private teams: ReturnType<typeof teamQueries>;
  private teamMembers: ReturnType<typeof teamMemberQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.projects = projectQueries(db);
    this.orgs = orgQueries(db);
    this.manifests = projectManifestQueries(db);
    this.agentConfigs = agentConfigQueries(db);
    this.agents = agentQueries(db);
    this.teams = teamQueries(db);
    this.teamMembers = teamMemberQueries(db);
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
}

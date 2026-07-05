import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Bot } from 'lucide-react';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { SectionHeading } from '@/components/section-heading';
import { StatPill } from '@/components/stat-pill';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { normalizeAgents, type Agent, type AgentConfigResponse, type Route } from '../shared';
import { ChatSlideOver } from './chat-slide-over';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Team {
  id: string;
  lead_agent_id?: string | null;
  dispatch?: Record<string, unknown> | null;
  members: string[];
}

interface Thread {
  id: string;
  key: string;
  summary?: string | null;
  workspace_key?: string | null;
  created_at: string;
  updated_at: string;
}

interface RuntimeStatus {
  status?: string;
  org_id?: string;
  warm_agents?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readableRouteTarget(target: string): string {
  const [kind, id] = target.split(':', 2);
  if (!kind || !id) return target;
  return `${kind[0]!.toUpperCase()}${kind.slice(1)} · ${id}`;
}

function gatewayPolicyLabel(agent: Agent): string {
  if (agent.gateway_policy === 'routable') return 'Routable';
  if (agent.gateway_policy === 'discoverable') return 'Discoverable';
  return 'Internal';
}

function permissionPolicyLabel(agent: Agent): string | null {
  const policy = agent.policies?.permission_policy;
  return typeof policy === 'string' ? policy : null;
}

// ---------------------------------------------------------------------------
// Agents Tab
// ---------------------------------------------------------------------------

export function AgentsTab({ projectId, orgId }: { projectId: string; orgId: string }) {
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);

  const { data: agentsData, isLoading, error } = useQuery({
    queryKey: ['project-agents', projectId],
    queryFn: () => api<AgentConfigResponse>(`/projects/${projectId}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: threadsData } = useQuery({
    queryKey: ['project-threads', projectId],
    queryFn: () => api<{ threads?: Thread[]; data?: Thread[] }>(`/projects/${projectId}/threads`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const { data: teamsData } = useQuery({
    queryKey: ['project-teams', projectId],
    queryFn: () => api<{ teams?: Team[]; data?: Team[] }>(`/projects/${projectId}/teams`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: routesData } = useQuery({
    queryKey: ['project-routes', projectId],
    queryFn: () => api<{ routes?: Route[]; data?: Route[] }>(`/projects/${projectId}/routes`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: runtimeData } = useQuery({
    queryKey: ['agent-runtime-status', orgId],
    queryFn: () => api<RuntimeStatus>(`/orgs/${orgId}/agent-runtime/status`),
    enabled: !!orgId,
    staleTime: 10_000,
    retry: 1,
  });

  const agents = normalizeAgents(agentsData);
  const threads = threadsData?.threads ?? threadsData?.data ?? [];
  const teams = teamsData?.teams ?? teamsData?.data ?? [];
  const routes = routesData?.routes ?? routesData?.data ?? [];
  const warmAgents = new Set(runtimeData?.warm_agents ?? []);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load agents" />;

  if (agents.length === 0) {
    const title = agentsData?.config_source === 'manifest'
      ? 'No repo-synced agents yet'
      : 'No agents synced for this project';
    const subtitle = agentsData?.config_source === 'manifest'
      ? 'This project has agent policy, but no concrete agents/teams have been synced from the repo yet.'
      : 'Sync the project repo to load agent definitions, teams, and chat routes.';
    return (
      <EmptyState
        icon={Bot}
        title={title}
        subtitle={subtitle}
      />
    );
  }

  const recentThreads = [...threads]
    .sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime())
    .slice(0, 8);
  const warmCount = agents.filter((agent) => warmAgents.has(agent.slug) || agent.status === 'warm').length;
  const routableCount = agents.filter((agent) => agent.gateway_policy === 'routable').length;

  return (
    <div>
      {agentsData?.synced_at && (
        <div className="mb-4 text-label text-[var(--text-muted)]">
          Agent config synced {timeAgo(agentsData.synced_at)}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <StatPill label="Agents" value={agents.length} color="var(--purple)" />
        <StatPill label="Warm" value={warmCount} color="var(--green)" />
        <StatPill label="Routable" value={routableCount} color="var(--blue)" />
        <StatPill label="Teams" value={teams.length} />
        <StatPill label="Routes" value={routes.length} />
      </div>

      {/* Agent cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
        {agents.map((agent) => {
          const isWarm = warmAgents.has(agent.slug) || agent.status === 'warm';
          const permissionPolicy = permissionPolicyLabel(agent);

          return (
            <Card key={agent.id || agent.slug} accent="var(--purple)">
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${isWarm ? 'bg-[var(--green)]' : 'bg-[var(--text-muted)]'}`} />
                    <span className="text-body font-medium text-[var(--text-primary)]">{agent.name || agent.slug}</span>
                  </div>
                  {agent.harness_profile && (
                    <span className="font-mono text-label px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">
                      {agent.harness_profile}
                    </span>
                  )}
                </div>

                {agent.description && (
                  <p className="text-label text-[var(--text-secondary)] mb-3 line-clamp-2" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {agent.description}
                  </p>
                )}

                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge color="var(--bg-3)" textColor="var(--text-secondary)">{gatewayPolicyLabel(agent)}</Badge>
                  {agent.workflow && (
                    <Badge color="var(--blue-dim)" textColor="var(--blue)">{agent.workflow}</Badge>
                  )}
                  {permissionPolicy && (
                    <Badge color="var(--amber-dim)" textColor="var(--amber)">{permissionPolicy}</Badge>
                  )}
                </div>

                <div className="flex items-center justify-between mt-auto">
                  <div className="text-label text-[var(--text-muted)]">
                    {agent.role ?? agent.slug}
                  </div>
                  <button
                    onClick={() => setChatAgent(agent)}
                    className="flex items-center gap-1.5 text-label font-medium px-2.5 py-1 rounded-md transition-colors"
                    style={{ color: 'var(--blue)', background: 'var(--blue-dim)' }}
                  >
                    <MessageSquare size={12} />
                    Thread
                  </button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {(teams.length > 0 || routes.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
          {teams.length > 0 && (
            <Card>
              <div className="p-4">
                <SectionHeading>Teams</SectionHeading>
                <div className="space-y-3">
                  {teams.map((team) => {
                    const lead = team.lead_agent_id ? agentsById.get(team.lead_agent_id) : null;
                    return (
                      <div key={team.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3">
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <div className="text-body font-medium text-[var(--text-primary)]">{team.id}</div>
                          <div className="text-label text-[var(--text-muted)]">{team.members.length} members</div>
                        </div>
                        <div className="text-label text-[var(--text-secondary)]">
                          Lead: {lead?.name ?? team.lead_agent_id ?? 'Unassigned'}
                        </div>
                        {team.dispatch && (
                          <div className="text-label text-[var(--text-muted)] mt-1">
                            Mode: {typeof team.dispatch.mode === 'string' ? team.dispatch.mode : 'custom'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </Card>
          )}

          {routes.length > 0 && (
            <Card>
              <div className="p-4">
                <SectionHeading>Chat Routes</SectionHeading>
                <div className="space-y-3">
                  {routes.map((route) => (
                    <div key={route.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-3">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="text-body font-medium text-[var(--text-primary)]">{route.id}</div>
                        <Badge color="var(--blue-dim)" textColor="var(--blue)">{readableRouteTarget(route.target)}</Badge>
                      </div>
                      <div className="font-mono text-label text-[var(--text-muted)] break-all">{route.match}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Recent Threads */}
      {recentThreads.length > 0 && (
        <div>
          <SectionHeading>Recent Threads</SectionHeading>
          <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
            {recentThreads.map((thread) => {
              const title = thread.summary || thread.workspace_key || thread.key || `Thread ${thread.id.slice(0, 8)}`;
              return (
                <div key={thread.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Bot size={14} className="text-[var(--purple)] flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-body text-[var(--text-primary)] truncate">{title}</div>
                      <div className="text-label text-[var(--text-muted)] truncate">{thread.key}</div>
                    </div>
                  </div>
                  <span className="text-label text-[var(--text-muted)] flex-shrink-0 ml-4">
                    {timeAgo(thread.updated_at ?? thread.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chat slide-over */}
      <ChatSlideOver agent={chatAgent} orgId={orgId} onClose={() => setChatAgent(null)} />
    </div>
  );
}

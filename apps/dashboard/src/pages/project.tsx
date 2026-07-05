import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ExternalLink,
  Calendar,
  Users,
  GitBranch,
  Zap,
  Workflow,
  Link2,
  Package,
  Bot,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { LayoutContext } from '@/components/layout';
import {
  normalizeAgents,
  normalizePipelines,
  type AgentConfigResponse,
  type RawPipeline,
} from './project/shared';
import { ArchitectureTab } from './project/tabs/architecture';
import { AgentsTab } from './project/tabs/agents';
import { PipelinesTab } from './project/tabs/pipelines';
import { WorkflowsTab } from './project/tabs/workflows';
import { IntegrationsTab } from './project/tabs/integrations';
import { ReleasesTab } from './project/tabs/releases';
import { SchedulesTab } from './project/tabs/schedules';
import { MembersTab } from './project/tabs/members';

// ---------------------------------------------------------------------------
// Tab definition
// ---------------------------------------------------------------------------

type TabId = 'architecture' | 'agents' | 'pipelines' | 'workflows' | 'integrations' | 'releases' | 'schedules' | 'members';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof Bot;
  badgeKey?: 'agents' | 'pipelines';
}

const TABS: TabDef[] = [
  { id: 'architecture', label: 'Architecture', icon: Zap },
  { id: 'agents', label: 'Agents', icon: Bot, badgeKey: 'agents' },
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch, badgeKey: 'pipelines' },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'integrations', label: 'Integrations', icon: Link2 },
  { id: 'releases', label: 'Releases', icon: Package },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'members', label: 'Members', icon: Users },
];

// ---------------------------------------------------------------------------
// Main ProjectPage
// ---------------------------------------------------------------------------

export function ProjectPage() {
  const { selectedProject, activeOrg, selectedEnv } = useOutletContext<LayoutContext>();
  const [activeTab, setActiveTab] = useState<TabId>('architecture');

  // Fetch agent and pipeline counts for tab badges
  const projectId = selectedProject?.id ?? null;
  const orgId = activeOrg?.id ?? '';

  const { data: agentsData } = useQuery({
    queryKey: ['project-agents', projectId],
    queryFn: () => api<AgentConfigResponse>(`/projects/${projectId}/agents`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const { data: pipelinesData } = useQuery({
    queryKey: ['project-pipelines', projectId],
    queryFn: () => api<{ pipelines?: RawPipeline[]; data?: RawPipeline[] }>(`/projects/${projectId}/pipelines`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const agentCount = normalizeAgents(agentsData).length;
  const pipelineCount = normalizePipelines(pipelinesData).length;

  const badgeCounts: Record<string, number> = {
    agents: agentCount,
    pipelines: pipelineCount,
  };

  // No project selected
  if (!selectedProject) {
    return (
      <div className="page">
        <div className="page-inner">
          <h1 className="page-title mb-4">App detail</h1>
          <div className="card card-pad py-14 text-center">
            <div className="w-12 h-12 rounded-xl bg-[var(--bg-3)] flex items-center justify-center mx-auto mb-4">
              <Zap size={24} className="text-[var(--text-muted)]" />
            </div>
            <div className="text-body text-[var(--text-secondary)]">
              Pick an app from the Apps page (or the top bar) to see its anatomy
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="px-4 sm:px-6 pt-5 pb-0 flex-shrink-0">
        <h1 className="page-title mb-1">{selectedProject.name}</h1>
        {selectedProject.repo_url && (
          <a
            href={selectedProject.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-label text-[var(--text-muted)] hover:text-[var(--blue)] transition-colors"
          >
            <ExternalLink size={11} />
            {selectedProject.repo_url.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
          </a>
        )}
      </div>

      {/* Tab bar */}
      <div className="px-4 sm:px-6 flex-shrink-0">
        <div className="chip-row border-b mt-3" style={{ borderColor: 'var(--border)' }}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const count = tab.badgeKey ? badgeCounts[tab.badgeKey] : undefined;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex items-center gap-1.5 px-3 py-2.5 text-body transition-colors whitespace-nowrap flex-shrink-0"
                style={{
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {tab.label}
                {count != null && count > 0 && (
                  <span
                    className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-label px-1"
                    style={{
                      background: isActive ? 'var(--blue-dim)' : 'var(--bg-3)',
                      color: isActive ? 'var(--blue)' : 'var(--text-muted)',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {count}
                  </span>
                )}
                {/* Active underline */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-2 right-2 h-[2.5px] rounded-t horizon-bar"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        {activeTab === 'architecture' && (
          <ArchitectureTab projectId={selectedProject.id} envName={selectedEnv} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab projectId={selectedProject.id} orgId={orgId} />
        )}
        {activeTab === 'pipelines' && (
          <PipelinesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'workflows' && (
          <WorkflowsTab projectId={selectedProject.id} />
        )}
        {activeTab === 'integrations' && (
          <IntegrationsTab orgId={orgId} />
        )}
        {activeTab === 'releases' && (
          <ReleasesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'schedules' && (
          <SchedulesTab projectId={selectedProject.id} />
        )}
        {activeTab === 'members' && (
          <MembersTab projectId={selectedProject.id} />
        )}
      </div>
    </div>
  );
}

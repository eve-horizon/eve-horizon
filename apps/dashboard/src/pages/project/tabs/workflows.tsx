import { useQuery } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDef {
  id?: string;
  name: string;
  trigger_label?: string | null;
  steps?: Array<{ name: string; agent?: string; condition?: string }>;
  permission_mode?: string;
  last_triggered_at?: string;
  daily_run_count?: number;
  timeout_seconds?: number;
  api_count?: number;
  created_at?: string;
}

interface RawWorkflowDef {
  id?: string;
  name: string;
  trigger_event?: string;
  steps?: Array<{ name: string; agent?: string; condition?: string }>;
  permission_mode?: string;
  last_triggered_at?: string;
  daily_run_count?: number;
  created_at?: string;
  definition?: {
    trigger?: Record<string, unknown>;
    steps?: Array<{
      name?: string;
      agent?: string | { name?: string };
      condition?: string;
    }>;
    hints?: {
      permission_policy?: string;
      timeout_seconds?: number;
    };
    with_apis?: Array<{ service: string; description?: string }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function workflowTriggerLabel(trigger: unknown): string | null {
  if (!isRecord(trigger)) return null;

  const appTrigger = isRecord(trigger.app) ? trigger.app : null;
  if (appTrigger && typeof appTrigger.event === 'string') {
    return `app:${appTrigger.event}`;
  }
  const systemTrigger = isRecord(trigger.system) ? trigger.system : null;
  if (systemTrigger && typeof systemTrigger.event === 'string') {
    return `system:${systemTrigger.event}`;
  }
  if (typeof trigger.event === 'string') {
    return trigger.event;
  }

  return null;
}

function normalizeWorkflows(data: { workflows?: RawWorkflowDef[]; data?: RawWorkflowDef[] } | null | undefined): WorkflowDef[] {
  const workflows = data?.workflows ?? data?.data ?? [];
  return workflows.map((workflow, index) => {
    const steps = workflow.steps
      ?? workflow.definition?.steps?.map((step, stepIndex) => ({
        name: step.name ?? `step-${stepIndex + 1}`,
        agent:
          typeof step.agent === 'string'
            ? step.agent
            : isRecord(step.agent) && typeof step.agent.name === 'string'
              ? step.agent.name
              : undefined,
        condition: typeof step.condition === 'string' ? step.condition : undefined,
      }))
      ?? [];

    return {
      id: workflow.id ?? workflow.name ?? String(index),
      name: workflow.name,
      trigger_label: workflow.trigger_event ?? workflowTriggerLabel(workflow.definition?.trigger) ?? null,
      steps,
      permission_mode: workflow.permission_mode ?? workflow.definition?.hints?.permission_policy,
      last_triggered_at: workflow.last_triggered_at,
      daily_run_count: workflow.daily_run_count,
      timeout_seconds: workflow.definition?.hints?.timeout_seconds,
      api_count: workflow.definition?.with_apis?.length ?? 0,
      created_at: workflow.created_at,
    };
  });
}

// ---------------------------------------------------------------------------
// Workflows Tab
// ---------------------------------------------------------------------------

export function WorkflowsTab({ projectId }: { projectId: string }) {
  const { data: workflowsData, isLoading, error } = useQuery({
    queryKey: ['project-workflows', projectId],
    queryFn: () => api<{ workflows?: RawWorkflowDef[]; data?: RawWorkflowDef[] }>(`/projects/${projectId}/workflows`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const workflows = normalizeWorkflows(workflowsData);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load workflows" />;

  if (workflows.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title="No workflows configured"
        subtitle="Define workflows in your .eve/manifest.yaml to automate multi-step processes."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {workflows.map((wf, i) => (
        <Card key={wf.id ?? wf.name ?? i}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-body font-medium text-[var(--text-primary)]">{wf.name}</span>
              {wf.trigger_label && (
                <Badge color="var(--amber-dim)" textColor="var(--amber)">{wf.trigger_label}</Badge>
              )}
            </div>

            {/* Step sequence */}
            {wf.steps && wf.steps.length > 0 && (
              <div className="space-y-1 mt-3 mb-3">
                {wf.steps.map((step, si) => (
                  <div key={si} className="flex items-center gap-2 text-label">
                    <span className="w-5 h-5 rounded-full bg-[var(--bg-3)] text-[var(--text-muted)] flex items-center justify-center text-label font-mono" style={{ fontSize: 10 }}>
                      {si + 1}
                    </span>
                    <span className="text-[var(--text-secondary)]">{step.name}</span>
                    {step.agent && (
                      <span className="text-[var(--purple)] font-mono text-label">@{step.agent}</span>
                    )}
                    {step.condition && (
                      <span className="text-[var(--text-muted)] italic">if {step.condition}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-4 text-label text-[var(--text-muted)] mt-2">
              {wf.permission_mode && (
                <span>Mode: {wf.permission_mode}</span>
              )}
              {wf.timeout_seconds != null && (
                <span>{wf.timeout_seconds}s timeout</span>
              )}
              {wf.api_count != null && wf.api_count > 0 && (
                <span>{wf.api_count} API{wf.api_count > 1 ? 's' : ''}</span>
              )}
              {wf.last_triggered_at && (
                <span>Last: {timeAgo(wf.last_triggered_at)}</span>
              )}
              {wf.daily_run_count != null && (
                <span>{wf.daily_run_count} runs today</span>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

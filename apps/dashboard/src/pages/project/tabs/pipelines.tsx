import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { HealthDot } from '@/components/health-dot';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { normalizePipelines, type RawPipeline } from '../shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineRun {
  id: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  steps?: Array<{ name: string; status: string }>;
}

// ---------------------------------------------------------------------------
// Pipelines Tab
// ---------------------------------------------------------------------------

export function PipelinesTab({ projectId }: { projectId: string }) {
  const [expandedPipeline, setExpandedPipeline] = useState<string | null>(null);

  const { data: pipelinesData, isLoading, error } = useQuery({
    queryKey: ['project-pipelines', projectId],
    queryFn: () => api<{ pipelines?: RawPipeline[]; data?: RawPipeline[] }>(`/projects/${projectId}/pipelines`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const pipelines = normalizePipelines(pipelinesData);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load pipelines" />;

  if (pipelines.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No pipelines configured"
        subtitle="Define pipelines in your .eve/manifest.yaml to see them here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {pipelines.map((pipeline) => {
        const isExpanded = expandedPipeline === pipeline.name;
        return (
          <Card key={pipeline.name}>
            <div
              className="p-4 cursor-pointer"
              onClick={() => setExpandedPipeline(isExpanded ? null : pipeline.name)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <GitBranch size={16} className="text-[var(--blue)]" />
                  <span className="text-body font-medium text-[var(--text-primary)]">{pipeline.name}</span>
                </div>
                {pipeline.trigger && (
                  <Badge color="var(--blue-dim)" textColor="var(--blue)">{pipeline.trigger}</Badge>
                )}
              </div>

              {/* Step visualization */}
              {pipeline.steps && pipeline.steps.length > 0 && (
                <div className="flex items-center gap-1 mt-3">
                  {pipeline.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-1">
                      {i > 0 && <div className="w-4 h-px bg-[var(--border-bright)]" />}
                      <StepIndicator name={step.name} status={step.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {isExpanded && (
              <div className="border-t border-[var(--border)] px-4 py-3">
                <PipelineRuns projectId={projectId} pipelineName={pipeline.name} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function StepIndicator({ name, status }: { name: string; status?: string }) {
  const bg =
    status === 'done' || status === 'completed' || status === 'success'
      ? 'var(--green)'
      : status === 'running' || status === 'active'
        ? 'var(--blue)'
        : status === 'failed' || status === 'error'
          ? 'var(--red)'
          : 'var(--text-muted)';
  const symbol =
    status === 'done' || status === 'completed' || status === 'success'
      ? '\u2713'
      : status === 'running' || status === 'active'
        ? '\u25CF'
        : status === 'failed' || status === 'error'
          ? '\u2717'
          : '\u2014';

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-label font-bold"
        style={{ background: bg, color: '#fff', fontSize: 10 }}
      >
        {symbol}
      </span>
      <span className="text-label text-[var(--text-secondary)]">{name}</span>
    </div>
  );
}

function PipelineRuns({ projectId, pipelineName }: { projectId: string; pipelineName: string }) {
  const { data: runsData, isLoading } = useQuery({
    queryKey: ['pipeline-runs', projectId, pipelineName],
    queryFn: () => api<{ runs?: PipelineRun[]; data?: PipelineRun[] }>(`/projects/${projectId}/pipelines/${encodeURIComponent(pipelineName)}/runs`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const runs = runsData?.runs ?? runsData?.data ?? [];

  if (isLoading) return <div className="text-label text-[var(--text-muted)] py-2">Loading runs...</div>;
  if (runs.length === 0) return <div className="text-label text-[var(--text-muted)] py-2">No runs yet</div>;

  return (
    <div className="space-y-1.5">
      <div className="text-label text-[var(--text-muted)] uppercase tracking-wide mb-1">Recent Runs</div>
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="flex items-center justify-between py-1.5 text-body">
          <div className="flex items-center gap-2">
            <HealthDot status={run.status === 'completed' || run.status === 'success' ? 'healthy' : run.status === 'failed' ? 'failed' : run.status === 'running' ? 'deploying' : 'unknown'} />
            <span className="font-mono text-label text-[var(--text-secondary)]">{run.id.slice(0, 10)}</span>
          </div>
          <span className="text-label text-[var(--text-muted)]">
            {timeAgo(run.completed_at ?? run.started_at ?? run.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

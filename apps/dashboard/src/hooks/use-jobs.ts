import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Types matching actual API response shapes
export interface Job {
  id: string;
  project_id?: string;
  title: string;
  description?: string;
  phase: string;
  priority: number;
  harness?: string;
  assignee?: string;
  review_required?: string | null;
  review_status?: string | null;
  reviewer?: string;
  failure_disposition?: 'cancelled' | 'failed' | 'upstream_failed' | null;
  close_reason?: string | null;
  env_name?: string | null;
  step_name?: string | null;
  execution_type?: string | null;
  action_type?: string | null;
  labels: string[];
  parent_id?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
  git_branch?: string;
  git_ref?: string;
}

export interface OrgJobItem {
  id: string;
  project_id: string;
  project_slug: string;
  project_name: string;
  title: string;
  phase: string;
  priority: number;
  assignee?: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface JobStats {
  total: number;
  by_phase: Record<string, number>;
  by_project: Array<{ project_id: string; project_name: string; count: number }>;
}

export type JobStatusTone = 'default' | 'success' | 'info' | 'warning' | 'error';

export function jobStatusLabel(job: Job): string {
  if (job.phase === 'review') return 'Needs review';
  if (job.phase === 'active') return 'Running';
  if (job.phase === 'done') return 'Done';
  if (job.phase === 'ready') return 'Ready';
  if (job.phase === 'cancelled') {
    if (job.failure_disposition === 'upstream_failed') return 'Blocked';
    if (job.failure_disposition === 'failed') return 'Failed';
    return 'Cancelled';
  }
  return job.phase;
}

export function jobStatusTone(job: Job): JobStatusTone {
  if (job.phase === 'done') return 'success';
  if (job.phase === 'active') return 'info';
  if (job.phase === 'review') return 'warning';
  if (job.phase === 'cancelled') {
    return job.failure_disposition === 'upstream_failed' ? 'warning' : 'error';
  }
  return 'default';
}

export function jobNeedsAttention(job: Job): boolean {
  return job.phase === 'review' || job.phase === 'cancelled';
}

export function jobStatusDetail(job: Job): string | null {
  if (job.phase === 'review') {
    return 'Awaiting human review before it can complete';
  }

  if (job.phase === 'cancelled') {
    if (job.close_reason) return job.close_reason;
    if (job.failure_disposition === 'upstream_failed') return 'Blocked by an upstream job failure';
    if (job.failure_disposition === 'failed') return 'Execution failed';
    return 'Job was cancelled';
  }

  if (job.phase === 'active') {
    if (job.env_name) return `Running in ${job.env_name}`;
    return 'Execution in progress';
  }

  if (job.phase === 'done') {
    return 'Completed successfully';
  }

  return null;
}

// Group jobs by phase for the kanban board
export function groupByPhase(jobs: Job[]): Record<string, Job[]> {
  const groups: Record<string, Job[]> = { ready: [], active: [], review: [], cancelled: [], done: [] };
  for (const job of jobs) {
    const phase = job.phase in groups ? job.phase : 'done';
    groups[phase]!.push(job);
  }
  return groups;
}

/** Fetch project-scoped jobs (full objects) */
export function useProjectJobs(projectId: string | null, phase?: string) {
  return useQuery({
    queryKey: ['project-jobs', projectId, phase],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '200' });
      if (phase) params.set('phase', phase);
      const res = await api<{ jobs: Job[]; pagination?: { total: number } }>(
        `/projects/${projectId}/jobs?${params}`,
      );
      return { items: res.jobs ?? [], pagination: res.pagination ?? { total: 0 } };
    },
    enabled: !!projectId,
    refetchInterval: 3000,
  });
}

/** Fetch org-scoped jobs (lightweight items) */
export function useOrgJobs(orgId: string | null, status?: string) {
  return useQuery({
    queryKey: ['org-jobs', orgId, status],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (status) params.set('status', status);
      return api<{ items: OrgJobItem[]; pagination: { has_more: boolean; next_cursor?: string } }>(
        `/orgs/${orgId}/jobs?${params}`,
      );
    },
    enabled: !!orgId,
    refetchInterval: 3000,
  });
}

/** Fetch org job stats (cheap counters) */
export function useJobStats(orgId: string | null) {
  return useQuery({
    queryKey: ['job-stats', orgId],
    queryFn: () => api<JobStats>(`/orgs/${orgId}/jobs/stats`),
    enabled: !!orgId,
    refetchInterval: 3000,
  });
}

/** Fetch single job detail */
export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<Job>(`/jobs/${jobId}`),
    enabled: !!jobId,
  });
}

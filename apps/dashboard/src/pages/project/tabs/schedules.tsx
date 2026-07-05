import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';
import { cronToHuman, formatDate, timeAgo } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Schedule {
  id: string;
  name?: string;
  cron: string;
  event_type?: string;
  next_run_at?: string;
  last_run_at?: string;
  status?: string;
  enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Schedules Tab
// ---------------------------------------------------------------------------

export function SchedulesTab({ projectId }: { projectId: string }) {
  const { data: schedData, isLoading, error } = useQuery({
    queryKey: ['project-schedules', projectId],
    queryFn: () => api<{ schedules?: Schedule[]; data?: Schedule[] }>(`/projects/${projectId}/schedules?limit=20`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const schedules = schedData?.schedules ?? schedData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load schedules" />;

  if (schedules.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No schedules configured"
        subtitle="Define cron schedules in your manifest or via eve schedule create."
      />
    );
  }

  return (
    <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Name</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Cron</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Human</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Next Run</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Last Run</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((sched) => {
            const isActive = sched.status === 'active' || sched.enabled !== false;
            const name = sched.name ?? sched.event_type ?? sched.id;
            return (
              <tr key={sched.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
                <td className="px-4 py-3 text-[var(--text-primary)] font-medium">{name}</td>
                <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{sched.cron}</td>
                <td className="px-4 py-3 text-label text-[var(--text-secondary)]">{cronToHuman(sched.cron)}</td>
                <td className="px-4 py-3 text-label text-[var(--text-muted)]">{formatDate(sched.next_run_at)}</td>
                <td className="px-4 py-3 text-label text-[var(--text-muted)]">{sched.last_run_at ? timeAgo(sched.last_run_at) : '\u2014'}</td>
                <td className="px-4 py-3">
                  <Badge
                    color={isActive ? 'var(--green-dim)' : 'var(--bg-3)'}
                    textColor={isActive ? 'var(--green)' : 'var(--text-muted)'}
                  >
                    {isActive ? 'Active' : 'Paused'}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

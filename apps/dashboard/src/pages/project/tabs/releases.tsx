import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Package } from 'lucide-react';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';
import { formatDate, shortSha } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Release {
  id: string;
  tag: string;
  git_sha?: string;
  environment?: string;
  created_by?: string;
  is_active?: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Releases Tab
// ---------------------------------------------------------------------------

export function ReleasesTab({ projectId }: { projectId: string }) {
  const { data: relData, isLoading, error } = useQuery({
    queryKey: ['project-releases', projectId],
    queryFn: () => api<{ releases?: Release[]; data?: Release[] }>(`/projects/${projectId}/releases?limit=20`),
    enabled: !!projectId,
    staleTime: 15_000,
    retry: 1,
  });

  const releases = relData?.releases ?? relData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load releases" />;

  if (releases.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No releases yet"
        subtitle="Create a release by running a pipeline or using eve release create."
      />
    );
  }

  return (
    <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Tag</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">SHA</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Environment</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Created By</th>
            <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Date</th>
            <th className="w-12"></th>
          </tr>
        </thead>
        <tbody>
          {releases.map((rel) => (
            <tr key={rel.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[var(--text-primary)]">{rel.tag}</span>
                  {rel.is_active && (
                    <Badge color="var(--green-dim)" textColor="var(--green)">active</Badge>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{shortSha(rel.git_sha)}</td>
              <td className="px-4 py-3 text-[var(--text-secondary)]">{rel.environment ?? '\u2014'}</td>
              <td className="px-4 py-3 text-[var(--text-secondary)]">{rel.created_by ?? '\u2014'}</td>
              <td className="px-4 py-3 text-label text-[var(--text-muted)]">{formatDate(rel.created_at)}</td>
              <td className="px-4 py-3">
                <ExternalLink size={14} className="text-[var(--text-muted)]" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { StatPill } from '@/components/stat-pill';
import { api } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectMember {
  project_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Members Tab
// ---------------------------------------------------------------------------

export function MembersTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<{ data: ProjectMember[] }>(`/projects/${projectId}/members`),
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });

  const members = data?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load project members" />;

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No explicit project members"
        subtitle="This project currently inherits access from org membership only."
      />
    );
  }

  const roleCounts = {
    owner: members.filter((member) => member.role === 'owner').length,
    admin: members.filter((member) => member.role === 'admin').length,
    member: members.filter((member) => member.role === 'member').length,
  };

  const roleStyles: Record<ProjectMember['role'], { bg: string; fg: string }> = {
    owner: { bg: 'var(--purple-dim)', fg: 'var(--purple)' },
    admin: { bg: 'var(--blue-dim)', fg: 'var(--blue)' },
    member: { bg: 'var(--bg-3)', fg: 'var(--text-secondary)' },
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <StatPill label="Owners" value={roleCounts.owner} color="var(--purple)" />
        <StatPill label="Admins" value={roleCounts.admin} color="var(--blue)" />
        <StatPill label="Members" value={roleCounts.member} />
      </div>

      <div className="bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Person</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Role</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">User ID</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Added</th>
              <th className="text-left px-4 py-3 text-label font-medium text-[var(--text-muted)] uppercase tracking-wide">Updated</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const roleStyle = roleStyles[member.role];
              const initials = (member.display_name ?? member.email).slice(0, 2).toUpperCase();

              return (
                <tr key={member.user_id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-2)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-[var(--bg-3)] border border-[var(--border)] flex items-center justify-center text-label font-semibold text-[var(--text-secondary)] flex-shrink-0">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <div className="text-body font-medium text-[var(--text-primary)] truncate">
                          {member.display_name ?? member.email}
                        </div>
                        <div className="text-label text-[var(--text-muted)] truncate">{member.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={roleStyle.bg} textColor={roleStyle.fg}>{member.role}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-label text-[var(--text-secondary)]">{member.user_id}</td>
                  <td className="px-4 py-3 text-label text-[var(--text-secondary)]">{formatDate(member.created_at)}</td>
                  <td className="px-4 py-3 text-label text-[var(--text-muted)]">{timeAgo(member.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-label text-[var(--text-muted)]">
        Shows explicit project memberships. Org-wide membership may still grant broader read access outside this table.
      </div>
    </div>
  );
}

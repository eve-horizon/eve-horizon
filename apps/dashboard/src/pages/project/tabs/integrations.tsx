import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LoadingState } from '@/components/loading-state';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Integration {
  id: string;
  provider?: string;
  type?: string;
  account_id?: string;
  name?: string;
  status?: string;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Integrations Tab
// ---------------------------------------------------------------------------

export function IntegrationsTab({ orgId }: { orgId: string }) {
  const { data: intData, isLoading, error } = useQuery({
    queryKey: ['org-integrations', orgId],
    queryFn: () => api<{ integrations?: Integration[]; data?: Integration[] }>(`/orgs/${orgId}/integrations`),
    enabled: !!orgId,
    staleTime: 30_000,
    retry: 1,
  });

  const integrations = intData?.integrations ?? intData?.data ?? [];

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message="Failed to load integrations" />;

  const providerNames: Record<string, string> = {
    github: 'GitHub',
    google_drive: 'Google Drive',
    'google-drive': 'Google Drive',
    slack: 'Slack',
    nostr: 'Nostr',
    webhook: 'Webhook',
  };

  if (integrations.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title="No integrations configured"
        subtitle="Connect GitHub, Slack, or other services to enable event-driven workflows."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {integrations.map((integ) => {
        const provider = integ.provider ?? integ.type ?? 'integration';
        const label = providerNames[provider] ?? provider.replace(/[_-]/g, ' ');
        const isConnected = integ.status === 'connected' || integ.status === 'active';
        return (
          <Card key={integ.id}>
            <div className="p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-[var(--bg-3)] border border-[var(--border)] flex items-center justify-center text-label font-semibold text-[var(--text-secondary)] uppercase">
                  {label.slice(0, 2)}
                </div>
                <div>
                  <div className="text-body font-medium text-[var(--text-primary)]">{integ.name ?? label}</div>
                  <div className="text-label text-[var(--text-muted)]">{integ.account_id ?? provider}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[var(--green)]' : 'bg-[var(--text-muted)]'}`} />
                  <span className="text-label text-[var(--text-secondary)]">
                    {isConnected ? 'Connected' : integ.status ?? 'Disconnected'}
                  </span>
                </div>
                <span className="text-label text-[var(--text-muted)]">
                  {timeAgo(integ.updated_at ?? integ.created_at ?? new Date().toISOString())}
                </span>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

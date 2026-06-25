import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HealthDot } from '@/components/health-dot';
import { useSystemStatus, useSystemPods } from '@/hooks/use-system';
import { useEnvHealth } from '@/hooks/use-analytics';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClusterEvent {
  type: string;
  reason: string;
  message: string;
  timestamp: string;
  involvedObject: {
    kind: string;
    name: string;
    namespace: string;
  };
}

interface SystemUser {
  id: string;
  email: string;
  is_admin?: boolean;
  created_at: string;
  last_login_at?: string | null;
  memberships?: Array<{
    org_id: string;
    org_name?: string;
    role: string;
  }>;
}

interface SystemSetting {
  key: string;
  value: string;
  description?: string;
  updated_at?: string;
  updated_by?: string;
}

interface LogEntry {
  timestamp: string;
  line: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useSystemEvents(enabled: boolean, limit = 50) {
  return useQuery({
    queryKey: ['system-events', limit],
    queryFn: () => api<ClusterEvent[]>(`/system/events?limit=${limit}`),
    enabled,
    refetchInterval: 10_000,
  });
}

function useSystemUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['system-users'],
    queryFn: () => api<SystemUser[]>('/system/users'),
    enabled,
    refetchInterval: 60_000,
  });
}

function useSystemSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api<SystemSetting[]>('/system/settings'),
    enabled,
    refetchInterval: 60_000,
  });
}

function useServiceLogs(service: string | null) {
  return useQuery({
    queryKey: ['system-logs', service],
    queryFn: () => api<LogEntry[]>(`/system/logs/${service}?tail=100`),
    enabled: !!service,
    refetchInterval: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = 'services' | 'events' | 'environments' | 'users' | 'settings';

interface TabDef {
  id: TabId;
  label: string;
  adminOnly?: boolean; // platform admin only
}

function getTabs(isAdmin: boolean): TabDef[] {
  const tabs: TabDef[] = [
    { id: 'services', label: 'Services' },
    { id: 'events', label: 'Events' },
    { id: 'environments', label: 'Environments' },
  ];
  if (isAdmin) {
    tabs.push({ id: 'users', label: 'Users', adminOnly: true });
    tabs.push({ id: 'settings', label: 'Settings', adminOnly: true });
  }
  return tabs;
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function ServicesPanel({
  isAdmin,
}: {
  isAdmin: boolean;
}) {
  const { data: status } = useSystemStatus(true);
  const { data: pods } = useSystemPods(true);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const { data: logs, isLoading: logsLoading } = useServiceLogs(
    isAdmin ? selectedService : null,
  );

  return (
    <div className="space-y-4">
      {/* Service list */}
      <div className="bg-[var(--bg-1)] rounded-lg p-4">
        <h3 className="text-emphasis font-medium mb-3">Platform Services</h3>
        <div className="space-y-1">
          {(status?.services ?? []).length === 0 ? (
            <div className="text-label text-[var(--text-muted)] py-2">
              Loading services...
            </div>
          ) : (
            (status?.services ?? []).map((svc) => (
              <button
                key={svc.name}
                className={`w-full flex items-center justify-between py-2 px-3 rounded transition-colors text-left ${
                  selectedService === svc.name
                    ? 'bg-[var(--bg-3)]'
                    : 'hover:bg-[var(--bg-2)]'
                } ${isAdmin ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={() => {
                  if (isAdmin) {
                    setSelectedService(
                      selectedService === svc.name ? null : svc.name,
                    );
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  <HealthDot status={svc.status} />
                  <span className="text-body font-medium">{svc.name}</span>
                </div>
                <div className="flex items-center gap-4 text-label text-[var(--text-secondary)]">
                  {svc.pods != null && (
                    <span>
                      {svc.ready_pods ?? svc.pods}/{svc.pods} pods
                    </span>
                  )}
                  {svc.restarts != null && svc.restarts > 0 && (
                    <span className="text-[var(--amber)]">
                      {svc.restarts} restarts
                    </span>
                  )}
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-label font-medium ${
                      svc.status === 'healthy'
                        ? 'bg-[var(--green-dim)] text-[var(--green)]'
                        : svc.status === 'degraded'
                          ? 'bg-[var(--amber-dim)] text-[var(--amber)]'
                          : svc.status === 'down' || svc.status === 'failed'
                            ? 'bg-[var(--red-dim)] text-[var(--red)]'
                            : 'bg-[var(--bg-4)] text-[var(--text-muted)]'
                    }`}
                  >
                    {svc.status}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Service log tail (admin only, when a service is selected) */}
      {isAdmin && selectedService && (
        <div className="bg-[var(--bg-1)] rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-emphasis font-medium">
              Logs: {selectedService}
            </h3>
            <button
              className="text-label text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              onClick={() => setSelectedService(null)}
            >
              Close
            </button>
          </div>
          {logsLoading ? (
            <div className="text-label text-[var(--text-muted)] py-4">
              Loading logs...
            </div>
          ) : !logs || logs.length === 0 ? (
            <div className="text-label text-[var(--text-muted)] py-4">
              No log entries
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto bg-[var(--bg-0)] rounded p-3">
              <pre className="font-mono text-label text-[var(--text-secondary)] whitespace-pre-wrap break-all leading-relaxed">
                {logs.map((entry, i) => (
                  <div key={i} className="hover:bg-[var(--bg-2)] py-0.5 px-1 rounded">
                    <span className="text-[var(--text-muted)] select-none mr-2">
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleTimeString()
                        : ''}
                    </span>
                    {entry.line}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Pods table */}
      <div className="bg-[var(--bg-1)] rounded-lg p-4">
        <h3 className="text-emphasis font-medium mb-3">Pods</h3>
        {!pods || (pods.pods ?? []).length === 0 ? (
          <div className="text-label text-[var(--text-muted)] py-2">
            No pod information available
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                    Name
                  </th>
                  <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                    Status
                  </th>
                  <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                    Restarts
                  </th>
                  <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                    Age
                  </th>
                </tr>
              </thead>
              <tbody>
                {(pods.pods ?? []).map((pod) => (
                  <tr
                    key={pod.name}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-2)] transition-colors"
                  >
                    <td className="py-2 font-mono text-label">{pod.name}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        <HealthDot
                          status={pod.ready ? 'healthy' : pod.status.toLowerCase()}
                        />
                        <span className="text-body">{pod.status}</span>
                      </div>
                    </td>
                    <td className="py-2 text-body">
                      {pod.restarts > 0 ? (
                        <span className="text-[var(--amber)]">{pod.restarts}</span>
                      ) : (
                        <span className="text-[var(--text-muted)]">0</span>
                      )}
                    </td>
                    <td className="py-2 text-label text-[var(--text-secondary)]">
                      {pod.age}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function EventsPanel() {
  const { data: events, isLoading, error } = useSystemEvents(true);

  return (
    <div className="bg-[var(--bg-1)] rounded-lg p-4">
      <h3 className="text-emphasis font-medium mb-3">Cluster Events</h3>
      {isLoading ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          Loading events...
        </div>
      ) : error ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          Cluster events are unavailable on this environment
        </div>
      ) : !events || events.length === 0 ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          No recent cluster events
        </div>
      ) : (
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {events.map((event, i) => (
            <div
              key={`${event.involvedObject.name}-${event.reason}-${i}`}
              className="flex items-start gap-3 py-2 px-2 rounded hover:bg-[var(--bg-2)] transition-colors"
            >
              <span
                className={`flex-shrink-0 mt-0.5 inline-block w-2 h-2 rounded-full ${
                  event.type === 'Warning'
                    ? 'bg-[var(--amber)]'
                    : event.type === 'Normal'
                      ? 'bg-[var(--green)]'
                      : 'bg-[var(--text-muted)]'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-body font-medium">{event.reason}</span>
                  <span className="text-label text-[var(--text-muted)]">
                    {event.involvedObject.kind}/{event.involvedObject.name}
                  </span>
                </div>
                <p className="text-label text-[var(--text-secondary)] break-words">
                  {event.message}
                </p>
                {event.timestamp && (
                  <span className="text-label text-[var(--text-muted)]">
                    {timeAgo(event.timestamp)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnvironmentsPanel({ orgId }: { orgId: string | null }) {
  const { data: envHealth } = useEnvHealth(orgId);

  return (
    <div className="bg-[var(--bg-1)] rounded-lg p-4">
      <h3 className="text-emphasis font-medium mb-3">Environment Health</h3>
      {!envHealth || envHealth.total === 0 ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          No environments deployed
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary bars */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[var(--bg-2)] rounded-lg p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <HealthDot status="healthy" size="md" />
                <span className="text-page font-semibold text-[var(--green)]">
                  {envHealth.healthy}
                </span>
              </div>
              <div className="text-label text-[var(--text-muted)]">Healthy</div>
            </div>
            <div className="bg-[var(--bg-2)] rounded-lg p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <HealthDot status="degraded" size="md" />
                <span
                  className={`text-page font-semibold ${
                    envHealth.degraded > 0
                      ? 'text-[var(--amber)]'
                      : 'text-[var(--text-primary)]'
                  }`}
                >
                  {envHealth.degraded}
                </span>
              </div>
              <div className="text-label text-[var(--text-muted)]">Degraded</div>
            </div>
            <div className="bg-[var(--bg-2)] rounded-lg p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <HealthDot status="unknown" size="md" />
                <span className="text-page font-semibold text-[var(--text-primary)]">
                  {envHealth.unknown}
                </span>
              </div>
              <div className="text-label text-[var(--text-muted)]">Unknown</div>
            </div>
          </div>

          {/* Health bar */}
          <div className="h-3 rounded-full overflow-hidden flex bg-[var(--bg-3)]">
            {envHealth.healthy > 0 && (
              <div
                className="bg-[var(--green)] transition-all"
                style={{
                  width: `${(envHealth.healthy / envHealth.total) * 100}%`,
                }}
              />
            )}
            {envHealth.degraded > 0 && (
              <div
                className="bg-[var(--amber)] transition-all"
                style={{
                  width: `${(envHealth.degraded / envHealth.total) * 100}%`,
                }}
              />
            )}
            {envHealth.unknown > 0 && (
              <div
                className="bg-[var(--text-muted)] transition-all"
                style={{
                  width: `${(envHealth.unknown / envHealth.total) * 100}%`,
                }}
              />
            )}
          </div>

          <div className="text-label text-[var(--text-muted)] text-center">
            {envHealth.total} environment{envHealth.total !== 1 ? 's' : ''} total
            {envHealth.as_of && (
              <> &middot; as of {timeAgo(envHealth.as_of)}</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UsersPanel() {
  const { data: users, isLoading } = useSystemUsers(true);

  return (
    <div className="bg-[var(--bg-1)] rounded-lg p-4">
      <h3 className="text-emphasis font-medium mb-3">Users</h3>
      {isLoading ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          Loading users...
        </div>
      ) : !users || users.length === 0 ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          No users found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                  Email
                </th>
                <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                  Orgs
                </th>
                <th className="text-left text-label text-[var(--text-muted)] font-medium py-2">
                  Roles
                </th>
                <th className="text-right text-label text-[var(--text-muted)] font-medium py-2">
                  Last Active
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const orgList = user.memberships ?? [];
                const roles = [
                  ...new Set(orgList.map((m) => m.role)),
                ];
                if (user.is_admin) roles.unshift('system_admin');

                return (
                  <tr
                    key={user.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-2)] transition-colors"
                  >
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-body font-medium">
                          {user.email}
                        </span>
                        {user.is_admin && (
                          <span className="inline-block px-1.5 py-0.5 rounded text-label font-medium bg-[var(--purple-dim)] text-[var(--purple)]">
                            admin
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-label text-[var(--text-secondary)]">
                      {orgList.length === 0
                        ? '—'
                        : orgList
                            .map((m) => m.org_name ?? m.org_id.slice(0, 10))
                            .join(', ')}
                    </td>
                    <td className="py-2.5">
                      <div className="flex gap-1 flex-wrap">
                        {roles.map((role) => (
                          <span
                            key={role}
                            className="inline-block px-1.5 py-0.5 rounded text-label bg-[var(--bg-3)] text-[var(--text-secondary)]"
                          >
                            {role}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 text-right text-label text-[var(--text-secondary)]">
                      {user.last_login_at
                        ? timeAgo(user.last_login_at)
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SettingsPanel() {
  const { data: settings, isLoading } = useSystemSettings(true);

  return (
    <div className="bg-[var(--bg-1)] rounded-lg p-4">
      <h3 className="text-emphasis font-medium mb-3">System Settings</h3>
      {isLoading ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          Loading settings...
        </div>
      ) : !settings || settings.length === 0 ? (
        <div className="text-label text-[var(--text-muted)] py-4 text-center">
          No settings configured
        </div>
      ) : (
        <div className="space-y-2">
          {settings.map((setting) => (
            <div
              key={setting.key}
              className="flex items-start justify-between py-2.5 px-3 rounded bg-[var(--bg-2)] hover:bg-[var(--bg-3)] transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium font-mono">
                  {setting.key}
                </div>
                {setting.description && (
                  <div className="text-label text-[var(--text-muted)] mt-0.5">
                    {setting.description}
                  </div>
                )}
              </div>
              <div className="flex-shrink-0 ml-4 text-right">
                <div className="text-body font-mono text-[var(--text-secondary)] max-w-[300px] truncate">
                  {setting.value}
                </div>
                {setting.updated_at && (
                  <div className="text-label text-[var(--text-muted)] mt-0.5">
                    {timeAgo(setting.updated_at)}
                    {setting.updated_by ? ` by ${setting.updated_by}` : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SystemPage() {
  const { isAdmin, isOrgAdmin, activeOrg } = useOutletContext<LayoutContext>();
  const orgId = activeOrg?.id ?? null;

  // System page is accessible to org admins AND platform admins
  const hasAccess = isAdmin || isOrgAdmin;

  const tabs = getTabs(isAdmin);
  const [activeTab, setActiveTab] = useState<TabId>('services');

  if (!hasAccess) {
    return (
      <div className="page">
        <div className="page-inner">
          <h1 className="page-title mb-4">System</h1>
          <div className="card card-pad py-14 text-center text-label" style={{ color: 'var(--text-muted)' }}>
            System view requires admin access
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner space-y-5">
        <div className="rise-in">
          <h1 className="page-title">System</h1>
          <p className="page-subtitle">Cluster services, pods and platform health</p>
        </div>

        {/* Tab bar */}
        <div className="chip-row border-b rise-in" style={{ borderColor: 'var(--border)', animationDelay: '40ms' }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`px-3.5 py-2 text-body font-medium transition-colors relative whitespace-nowrap flex-shrink-0 ${
                activeTab === tab.id
                  ? 'text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.adminOnly && (
                <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--purple)]" />
              )}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-2 right-2 h-[2.5px] rounded-t horizon-bar" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="rise-in" style={{ animationDelay: '80ms' }}>
          {activeTab === 'services' && <ServicesPanel isAdmin={isAdmin} />}
          {activeTab === 'events' && <EventsPanel />}
          {activeTab === 'environments' && <EnvironmentsPanel orgId={orgId} />}
          {activeTab === 'users' && isAdmin && <UsersPanel />}
          {activeTab === 'settings' && isAdmin && <SettingsPanel />}
        </div>
      </div>
    </div>
  );
}

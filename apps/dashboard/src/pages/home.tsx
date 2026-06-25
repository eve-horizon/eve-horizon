import { useMemo } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Eye,
  Layers,
  Play,
  XCircle,
} from 'lucide-react';
import { StatCard } from '@/components/stat-card';
import { ActivityFeed } from '@/components/activity-feed';
import { HealthDot } from '@/components/health-dot';
import { useJobStats, useOrgJobs } from '@/hooks/use-jobs';
import { useAnalyticsSummary, useOrgEvents, useEnvHealth, useOrgSpend } from '@/hooks/use-analytics';
import { useSystemStatus } from '@/hooks/use-system';
import { formatCount, formatUsd } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

/** How many minutes before an active job is considered "stuck" */
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  const { selectedProject, activeOrg, isAdmin, isOrgAdmin, adminScope } =
    useOutletContext<LayoutContext>();
  const [searchParams] = useSearchParams();
  const orgId = activeOrg?.id ?? null;
  const showAdminView = (isAdmin || isOrgAdmin) && adminScope && !selectedProject;

  const { data: stats } = useJobStats(orgId);
  const { data: summary } = useAnalyticsSummary(orgId, '1d');
  const { data: events } = useOrgEvents(orgId, 18);
  const { data: envHealth } = useEnvHealth(orgId);
  const { data: spend } = useOrgSpend(orgId, new Date(Date.now() - 7 * 86400000).toISOString());
  const { data: orgJobs } = useOrgJobs(showAdminView ? orgId : null, 'active');
  const { data: systemStatus } = useSystemStatus(isAdmin && showAdminView);

  const byPhase = stats?.by_phase ?? {};
  const failed = summary?.jobs?.failed ?? 0;

  // Preserve project/env context in deep links
  const ctxSearch = useMemo(() => {
    const params = new URLSearchParams();
    const project = searchParams.get('project');
    const env = searchParams.get('env');
    if (project) params.set('project', project);
    if (env) params.set('env', env);
    return params;
  }, [searchParams]);

  const linkTo = (pathname: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams(ctxSearch);
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    const search = params.toString();
    return { pathname, search: search ? `?${search}` : '' };
  };

  // Attention items with deep links
  const attentionItems = useMemo(() => {
    const items: Array<{
      key: string;
      label: string;
      severity: 'warning' | 'error';
      to: ReturnType<typeof linkTo>;
    }> = [];

    const review = byPhase['review'] ?? 0;
    if (review > 0) {
      items.push({
        key: 'review',
        label: `${review} job${review > 1 ? 's' : ''} awaiting review`,
        severity: 'warning',
        to: linkTo('/jobs', { phase: 'review' }),
      });
    }

    if (failed > 0) {
      items.push({
        key: 'failed',
        label: `${failed} job${failed > 1 ? 's' : ''} failed in the last 24h`,
        severity: 'error',
        to: linkTo('/jobs', { phase: 'attention' }),
      });
    }

    if (orgJobs?.items) {
      const now = Date.now();
      const stuck = orgJobs.items.filter(
        (j) => now - new Date(j.updated_at).getTime() > STUCK_THRESHOLD_MS,
      );
      if (stuck.length > 0) {
        items.push({
          key: 'stuck-jobs',
          label: `${stuck.length} job${stuck.length > 1 ? 's' : ''} stuck (no update in 30+ min)`,
          severity: 'warning',
          to: linkTo('/jobs', { phase: 'active' }),
        });
      }
    }

    if (envHealth && envHealth.degraded > 0) {
      items.push({
        key: 'degraded-envs',
        label: `${envHealth.degraded} environment${envHealth.degraded > 1 ? 's' : ''} degraded`,
        severity: 'error',
        to: linkTo('/apps'),
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byPhase, failed, orgJobs, envHealth, ctxSearch]);

  const projectsList = stats?.by_project ?? [];
  const envTotal = envHealth?.total ?? 0;

  return (
    <div className="page">
      <div className="page-inner space-y-5">
        {/* Header */}
        <div className="rise-in">
          <h1 className="page-title">
            {greeting()}
            {showAdminView && <span className="horizon-text"> · operations</span>}
          </h1>
          <p className="page-subtitle">
            {selectedProject
              ? `${selectedProject.name} — ${activeOrg?.name ?? activeOrg?.slug ?? ''}`
              : (activeOrg?.name ?? activeOrg?.slug ?? 'Eve Horizon')}
            {' · '}
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 rise-in" style={{ animationDelay: '40ms' }}>
          {showAdminView ? (
            <>
              <StatCard value={summary?.projects ?? 0} label="active projects" icon={<Layers size={15} />} />
              <StatCard value={summary?.jobs?.created ?? 0} label="jobs today" icon={<Play size={15} />} />
              <StatCard
                value={failed}
                label="failed (24h)"
                accent={failed > 0 ? 'error' : 'default'}
                icon={<XCircle size={15} />}
              />
              <StatCard
                value={`${summary?.environments?.healthy ?? 0}/${summary?.environments?.total ?? 0}`}
                label="envs healthy"
                accent={
                  (summary?.environments?.degraded ?? 0) > 0 ? 'warning' : 'success'
                }
              />
            </>
          ) : (
            <>
              <StatCard value={formatCount(byPhase['active'] ?? 0)} label="active jobs" accent="info" icon={<Play size={15} />} />
              <StatCard
                value={formatCount(byPhase['review'] ?? 0)}
                label="in review"
                accent={(byPhase['review'] ?? 0) > 0 ? 'warning' : 'default'}
                icon={<Eye size={15} />}
              />
              <StatCard value={formatCount(byPhase['done'] ?? 0)} label="done" accent="success" />
              <StatCard
                value={failed}
                label="failed (24h)"
                accent={failed > 0 ? 'error' : 'default'}
                icon={<XCircle size={15} />}
              />
            </>
          )}
        </div>

        {/* Attention strip */}
        {attentionItems.length > 0 && (
          <div className="space-y-2 rise-in" style={{ animationDelay: '80ms' }}>
            {attentionItems.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                className="card card-hover flex items-center gap-3 px-4 py-3 group"
                style={{
                  borderColor: item.severity === 'error' ? 'var(--red)' : 'var(--amber)',
                }}
              >
                <AlertTriangle
                  size={15}
                  style={{ color: item.severity === 'error' ? 'var(--red)' : 'var(--amber)' }}
                  className="flex-shrink-0"
                />
                <span className="text-body flex-1">{item.label}</span>
                <ArrowRight
                  size={14}
                  className="flex-shrink-0 opacity-40 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
                />
              </Link>
            ))}
          </div>
        )}

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5 rise-in" style={{ animationDelay: '120ms' }}>
          {/* Activity feed */}
          <div className="lg:col-span-2 card card-pad">
            <h2 className="card-title mb-3">Recent activity</h2>
            <ActivityFeed events={events?.items ?? []} />
          </div>

          {/* Right column */}
          <div className="space-y-4">
            {/* Spend */}
            <Link to={linkTo('/costs')} className="card card-pad card-hover block group">
              <div className="flex items-center justify-between">
                <h2 className="card-title">Spend · 7d</h2>
                <CircleDollarSign size={15} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div className="stat-value mt-2">
                {spend?.summary ? formatUsd(spend.summary.base_total_usd) : '$0.00'}
              </div>
              <div className="text-label mt-1 flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
                <span>{spend?.summary?.attempts ?? 0} agent runs</span>
                <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--accent)' }}>
                  breakdown <ArrowRight size={11} />
                </span>
              </div>
            </Link>

            {/* Environments */}
            <Link to={linkTo('/apps')} className="card card-pad card-hover block group">
              <div className="flex items-center justify-between">
                <h2 className="card-title">Environments</h2>
                <Layers size={15} style={{ color: 'var(--text-muted)' }} />
              </div>
              {envTotal === 0 ? (
                <div className="text-label mt-2" style={{ color: 'var(--text-muted)' }}>
                  No environments deployed
                </div>
              ) : (
                <>
                  {/* Health distribution bar */}
                  <div className="mt-3 h-2 rounded-full overflow-hidden flex" style={{ background: 'var(--bg-3)' }}>
                    {(envHealth?.healthy ?? 0) > 0 && (
                      <div
                        style={{
                          width: `${((envHealth?.healthy ?? 0) / envTotal) * 100}%`,
                          background: 'var(--green)',
                        }}
                      />
                    )}
                    {(envHealth?.degraded ?? 0) > 0 && (
                      <div
                        style={{
                          width: `${((envHealth?.degraded ?? 0) / envTotal) * 100}%`,
                          background: 'var(--red)',
                        }}
                      />
                    )}
                    {(envHealth?.unknown ?? 0) > 0 && (
                      <div
                        style={{
                          width: `${((envHealth?.unknown ?? 0) / envTotal) * 100}%`,
                          background: 'var(--bg-4)',
                        }}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-2.5 text-label" style={{ color: 'var(--text-secondary)' }}>
                    <span className="flex items-center gap-1.5">
                      <HealthDot status="healthy" /> {envHealth?.healthy ?? 0} healthy
                    </span>
                    {(envHealth?.degraded ?? 0) > 0 && (
                      <span className="flex items-center gap-1.5">
                        <HealthDot status="failed" /> {envHealth?.degraded} degraded
                      </span>
                    )}
                    {(envHealth?.unknown ?? 0) > 0 && (
                      <span className="flex items-center gap-1.5">
                        <HealthDot status="unknown" /> {envHealth?.unknown} unknown
                      </span>
                    )}
                  </div>
                </>
              )}
            </Link>

            {/* Admin: projects by job count */}
            {showAdminView && projectsList.length > 0 && (
              <div className="card card-pad">
                <h2 className="card-title mb-3">Projects</h2>
                <div className="space-y-2">
                  {projectsList.slice(0, 8).map((p) => (
                    <div key={p.project_id} className="flex items-center justify-between text-body">
                      <span className="truncate">{p.project_name}</span>
                      <span
                        className="badge flex-shrink-0 ml-2"
                        style={{ background: 'var(--bg-3)', color: 'var(--text-secondary)' }}
                      >
                        {p.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Admin: system health */}
            {isAdmin && showAdminView && systemStatus?.services && (
              <Link to={linkTo('/system')} className="card card-pad card-hover block">
                <h2 className="card-title mb-3">Platform health</h2>
                <div className="space-y-2">
                  {systemStatus.services.map((svc) => (
                    <div key={svc.name} className="flex items-center justify-between text-body">
                      <div className="flex items-center gap-2">
                        <HealthDot status={svc.status} />
                        <span>{svc.name}</span>
                      </div>
                      <span className="text-label" style={{ color: 'var(--text-muted)' }}>
                        {svc.status}
                      </span>
                    </div>
                  ))}
                </div>
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

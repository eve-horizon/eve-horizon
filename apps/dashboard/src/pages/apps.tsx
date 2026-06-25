import { useMemo } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Boxes, ExternalLink, Clock, GitBranch, ArrowUpRight } from 'lucide-react';
import { HealthDot } from '@/components/health-dot';
import { StatCard } from '@/components/stat-card';
import { useEnvHealth } from '@/hooks/use-analytics';
import { useProjects, type Project } from '@/hooks/use-projects';
import type { EnvironmentRecord } from '@/hooks/use-environments';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

const MAX_PROJECT_FETCHES = 24;

interface ProjectEnvsResponse {
  data: EnvironmentRecord[];
  pagination: { total: number; limit: number; offset: number };
}

interface AppEntry {
  project: Project;
  env: EnvironmentRecord;
}

function deployStatusToHealth(env: EnvironmentRecord): string {
  if (env.status === 'suspended') return 'warning';
  switch (env.deploy_status) {
    case 'deployed':
      return 'healthy';
    case 'deploying':
      return 'deploying';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function statusLabel(env: EnvironmentRecord): string {
  if (env.status === 'suspended') return 'suspended';
  return env.deploy_status ?? 'unknown';
}

const HEALTH_RANK: Record<string, number> = { failed: 0, warning: 1, deploying: 2, unknown: 3, healthy: 4 };

// ---------------------------------------------------------------------------
// App card
// ---------------------------------------------------------------------------
function AppCard({ app, to }: { app: AppEntry; to: { pathname: string; search: string } }) {
  const { project, env } = app;
  const health = deployStatusToHealth(env);
  const services = env.ingress_aliases ?? [];

  return (
    <Link to={to} className="card card-hover card-pad flex flex-col gap-3 group min-w-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold font-display truncate">{project.name}</span>
            <ArrowUpRight
              size={13}
              className="flex-shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
            />
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-label" style={{ color: 'var(--text-secondary)' }}>
            <HealthDot status={health} />
            <span>{env.name}</span>
            <span style={{ color: 'var(--text-muted)' }}>· {statusLabel(env)}</span>
          </div>
        </div>
        <span
          className="badge flex-shrink-0"
          style={
            env.type === 'persistent'
              ? { background: 'var(--blue-dim)', color: 'var(--blue)' }
              : { background: 'var(--purple-dim)', color: 'var(--purple)' }
          }
        >
          {env.type === 'persistent' ? 'persistent' : 'preview'}
        </span>
      </div>

      {/* Services / links */}
      {services.length > 0 ? (
        <div className="space-y-1.5">
          {services.slice(0, 3).map((svc) => (
            <span
              key={svc.alias}
              className="flex items-center justify-between gap-2 text-label rounded-lg px-2.5 py-1.5 hover:opacity-80 transition-opacity"
              style={{ background: 'var(--bg-2)' }}
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(`http://${svc.alias}`, '_blank', 'noopener,noreferrer');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(`http://${svc.alias}`, '_blank', 'noopener,noreferrer');
                }
              }}
            >
              <span className="font-medium truncate">{svc.service_name}</span>
              <span className="mono truncate flex items-center gap-1" style={{ color: 'var(--blue)' }}>
                {svc.alias}
                <ExternalLink size={10} className="flex-shrink-0" />
              </span>
            </span>
          ))}
          {services.length > 3 && (
            <div className="text-label px-2.5" style={{ color: 'var(--text-muted)' }}>
              +{services.length - 3} more
            </div>
          )}
        </div>
      ) : (
        <div className="text-label rounded-lg px-2.5 py-1.5" style={{ background: 'var(--bg-2)', color: 'var(--text-muted)' }}>
          No public endpoints
        </div>
      )}

      {/* Footer meta */}
      <div className="flex items-center gap-3 text-label mt-auto pt-1" style={{ color: 'var(--text-muted)' }}>
        {env.current_release_id && (
          <span className="flex items-center gap-1 mono">
            <GitBranch size={10} />
            {env.current_release_id.replace(/^rel_/, '').slice(0, 8)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {timeAgo(env.updated_at)}
        </span>
        {env.namespace && <span className="mono truncate hidden sm:inline">{env.namespace}</span>}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function AppsPage() {
  const { selectedProject, activeOrg } = useOutletContext<LayoutContext>();
  const [searchParams] = useSearchParams();
  const orgId = activeOrg?.id ?? null;

  const { data: healthData } = useEnvHealth(orgId);
  const { data: projectsData, isLoading: projectsLoading } = useProjects(orgId);
  const allProjects = projectsData?.items ?? [];

  // Scope: a selected project narrows the grid to that app's environments
  const projects = useMemo(
    () => (selectedProject ? [selectedProject] : allProjects.slice(0, MAX_PROJECT_FETCHES)),
    [selectedProject, allProjects],
  );

  const envQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['project-envs', p.id],
      queryFn: () => api<ProjectEnvsResponse>(`/projects/${p.id}/envs?limit=50`),
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });

  const loading = projectsLoading || envQueries.some((q) => q.isLoading);
  const envDataKey = envQueries.map((q) => q.dataUpdatedAt).join(',');

  const apps: AppEntry[] = useMemo(() => {
    const entries: AppEntry[] = [];
    projects.forEach((project, i) => {
      const envs = envQueries[i]?.data?.data ?? [];
      for (const env of envs) {
        entries.push({ project, env });
      }
    });
    // Worst health first, then most recently updated
    return entries.sort((a, b) => {
      const rank =
        (HEALTH_RANK[deployStatusToHealth(a.env)] ?? 3) - (HEALTH_RANK[deployStatusToHealth(b.env)] ?? 3);
      if (rank !== 0) return rank;
      return new Date(b.env.updated_at).getTime() - new Date(a.env.updated_at).getTime();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, envDataKey]);

  const detailLink = (app: AppEntry) => {
    const params = new URLSearchParams(searchParams);
    params.set('project', app.project.id);
    params.set('env', app.env.name);
    return { pathname: '/apps/project', search: `?${params.toString()}` };
  };

  const totalEnvs = healthData?.total ?? 0;
  const degraded = healthData?.degraded ?? 0;
  const unknown = healthData?.unknown ?? 0;

  return (
    <div className="page">
      <div className="page-inner space-y-5">
        <div className="rise-in flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="page-title">Apps</h1>
            <p className="page-subtitle">
              {selectedProject
                ? `Deployments of ${selectedProject.name}`
                : 'Everything running across your projects'}
            </p>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 rise-in" style={{ animationDelay: '40ms' }}>
          <StatCard value={apps.length} label="deployed apps" icon={<Boxes size={15} />} />
          <StatCard value={healthData?.healthy ?? 0} label="healthy" accent="success" />
          <StatCard value={degraded} label="degraded" accent={degraded > 0 ? 'error' : 'default'} />
          <StatCard value={unknown} label="unknown" accent={unknown > 0 ? 'warning' : 'default'} hint={totalEnvs ? `${totalEnvs} tracked` : undefined} />
        </div>

        {/* App grid */}
        {loading && apps.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card card-pad h-[150px] animate-skeleton" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="card card-pad py-16 text-center rise-in">
            <Boxes size={32} className="mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
            <div className="text-emphasis font-medium">Nothing deployed yet</div>
            <p className="text-label mt-1 max-w-sm mx-auto" style={{ color: 'var(--text-muted)' }}>
              When projects in this organization deploy environments, they appear here with health,
              endpoints and releases.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 rise-in" style={{ animationDelay: '80ms' }}>
            {apps.map((app) => (
              <AppCard key={`${app.project.id}-${app.env.id}`} app={app} to={detailLink(app)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

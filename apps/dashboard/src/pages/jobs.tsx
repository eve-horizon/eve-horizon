import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { Search, Briefcase, Columns3, List, X } from 'lucide-react';
import { PriorityBadge } from '@/components/priority-badge';
import { HealthDot } from '@/components/health-dot';
import { JobCard } from '@/components/job-card';
import { JobDetail } from '@/components/job-detail';
import {
  useProjectJobs,
  useOrgJobs,
  groupByPhase,
  type Job,
  type OrgJobItem,
  jobNeedsAttention,
  jobStatusDetail,
  jobStatusLabel,
  jobStatusTone,
} from '@/hooks/use-jobs';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

type ViewMode = 'list' | 'board';
type SortField = 'updated' | 'created' | 'priority';
type PhaseFilter = '' | 'attention' | 'ready' | 'active' | 'review' | 'done' | 'cancelled';

const PHASE_CHIPS: Array<{ value: PhaseFilter; label: string; tone?: string }> = [
  { value: '', label: 'All' },
  { value: 'attention', label: 'Attention', tone: 'var(--amber)' },
  { value: 'ready', label: 'Ready' },
  { value: 'active', label: 'Running', tone: 'var(--blue)' },
  { value: 'review', label: 'Review', tone: 'var(--amber)' },
  { value: 'done', label: 'Done', tone: 'var(--green)' },
  { value: 'cancelled', label: 'Stopped', tone: 'var(--red)' },
];

const BOARD_COLUMNS = ['ready', 'active', 'review', 'cancelled', 'done'] as const;

const columnLabels: Record<string, string> = {
  ready: 'Ready',
  active: 'Active',
  review: 'Review',
  cancelled: 'Stopped',
  done: 'Done',
};

function phaseToHealthStatus(phase: string): string {
  switch (phase) {
    case 'done': return 'healthy';
    case 'active': return 'running';
    case 'cancelled': return 'failed';
    case 'review': return 'warning';
    default: return 'unknown';
  }
}

type JobRow = Job & { _projectName?: string };

export function JobsPage() {
  const { selectedProject, activeOrg } = useOutletContext<LayoutContext>();
  const [searchParams, setSearchParams] = useSearchParams();

  const view: ViewMode = searchParams.get('view') === 'board' ? 'board' : 'list';
  const phaseFilter = (searchParams.get('phase') ?? '') as PhaseFilter;

  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('updated');
  const [doneExpanded, setDoneExpanded] = useState(false);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  // Org-wide mode whenever no project is selected — RBAC is enforced server-side
  const useOrgMode = !selectedProject;
  const projectId = selectedProject?.id ?? null;
  const orgId = activeOrg?.id ?? null;
  const serverPhaseFilter =
    view === 'board' || phaseFilter === 'attention' ? undefined : phaseFilter || undefined;

  const { data: projectData } = useProjectJobs(useOrgMode ? null : projectId, serverPhaseFilter);
  const { data: orgData } = useOrgJobs(useOrgMode ? orgId : null, serverPhaseFilter);

  const jobs: JobRow[] = useMemo(() => {
    if (useOrgMode && orgData?.items) {
      return orgData.items.map((item: OrgJobItem) => ({
        id: item.id,
        title: item.title,
        phase: item.phase,
        priority: item.priority,
        assignee: item.assignee,
        labels: item.labels,
        created_at: item.created_at,
        updated_at: item.updated_at,
        _projectName: item.project_name,
      } as JobRow));
    }
    return projectData?.items ?? [];
  }, [useOrgMode, orgData, projectData]);

  // ── Job detail (URL-synced) ──
  const linkedJobId = searchParams.get('job');
  const [clickedJob, setClickedJob] = useState<JobRow | null>(null);

  const selectedJob = useMemo(() => {
    if (clickedJob) return clickedJob;
    if (linkedJobId && jobs.length > 0) {
      return jobs.find((j) => j.id === linkedJobId) ?? null;
    }
    return null;
  }, [clickedJob, linkedJobId, jobs]);

  const openJob = useCallback(
    (job: JobRow) => {
      setClickedJob(job);
      setParam('job', job.id);
    },
    [setParam],
  );

  const closeJob = useCallback(() => {
    setClickedJob(null);
    setParam('job', null);
  }, [setParam]);

  const navigateToJob = useCallback(
    async (jobId: string) => {
      const existing = jobs.find((job) => job.id === jobId);
      if (existing) {
        openJob(existing);
        return;
      }
      try {
        const fetched = await api<Job>(`/jobs/${jobId}`);
        openJob(fetched as JobRow);
      } catch {
        // keep current detail open
      }
    },
    [jobs, openJob],
  );

  useEffect(() => {
    if (clickedJob) {
      const updated = jobs.find((j) => j.id === clickedJob.id);
      if (updated && updated !== clickedJob) {
        setClickedJob(updated);
      }
    }
  }, [jobs, clickedJob]);

  // ── Board move animation bookkeeping ──
  const prevJobPositions = useRef<Record<string, string>>({});
  const [transitioningJobs, setTransitioningJobs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (view !== 'board') return;
    const newPositions: Record<string, string> = {};
    const movedIds = new Set<string>();
    for (const job of jobs) {
      newPositions[job.id] = job.phase;
      const prev = prevJobPositions.current[job.id];
      if (prev && prev !== job.phase) movedIds.add(job.id);
    }
    prevJobPositions.current = newPositions;
    if (movedIds.size > 0) {
      setTransitioningJobs(movedIds);
      const timer = setTimeout(() => setTransitioningJobs(new Set()), 600);
      return () => clearTimeout(timer);
    }
  }, [jobs, view]);

  // ── Filter + sort ──
  const filtered = useMemo(() => {
    let result = jobs;

    if (view === 'list' && phaseFilter === 'attention') {
      result = result.filter((job) => jobNeedsAttention(job));
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (j) =>
          j.title.toLowerCase().includes(q) ||
          j.id.toLowerCase().includes(q) ||
          (j.close_reason ?? '').toLowerCase().includes(q) ||
          (j.env_name ?? '').toLowerCase().includes(q) ||
          (j.harness ?? '').toLowerCase().includes(q) ||
          j.labels.some((label) => label.toLowerCase().includes(q)),
      );
    }

    result = [...result].sort((a, b) => {
      switch (sortField) {
        case 'updated':
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        case 'created':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'priority':
          return a.priority - b.priority;
      }
    });

    return result;
  }, [jobs, view, phaseFilter, search, sortField]);

  const counts = useMemo(
    () => ({
      '': jobs.length,
      attention: jobs.filter((job) => jobNeedsAttention(job)).length,
      ready: jobs.filter((j) => j.phase === 'ready').length,
      active: jobs.filter((j) => j.phase === 'active').length,
      review: jobs.filter((j) => j.phase === 'review').length,
      cancelled: jobs.filter((j) => j.phase === 'cancelled').length,
      done: jobs.filter((j) => j.phase === 'done').length,
    }),
    [jobs],
  );

  const grouped = useMemo(() => groupByPhase(filtered), [filtered]);

  const emptyMessage = useMemo(() => {
    if (!selectedProject && !useOrgMode) return 'Select a project to view its jobs';
    if (search) return `No jobs matching "${search}"`;
    if (phaseFilter) return 'No jobs in this phase';
    return 'No jobs yet';
  }, [selectedProject, useOrgMode, search, phaseFilter]);

  return (
    <div className="page !pb-0 flex flex-col">
      <div className="page-inner flex flex-col flex-1 min-h-0 space-y-4">
        {/* Header row */}
        <div className="rise-in flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="page-title">Jobs</h1>
            <p className="page-subtitle">
              {useOrgMode ? 'Every job across the organization' : selectedProject?.name ?? 'Agent work, live'}
            </p>
          </div>

          <div className="segmented">
            <button
              className={`segmented-item focus-ring ${view === 'list' ? 'active' : ''}`}
              onClick={() => setParam('view', null)}
            >
              <List size={13} /> List
            </button>
            <button
              className={`segmented-item focus-ring ${view === 'board' ? 'active' : ''}`}
              onClick={() => setParam('view', 'board')}
            >
              <Columns3 size={13} /> Board
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="rise-in space-y-3" style={{ animationDelay: '40ms' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-2 flex-1 min-w-[180px] max-w-md"
              style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
            >
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search title, ID, label…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-transparent text-body outline-none flex-1 min-w-0 placeholder:text-[var(--text-muted)]"
              />
              {search && (
                <button onClick={() => setSearch('')} className="focus-ring rounded">
                  <X size={13} style={{ color: 'var(--text-muted)' }} />
                </button>
              )}
            </div>

            {view === 'list' && (
              <select
                value={sortField}
                onChange={(e) => setSortField(e.target.value as SortField)}
                className="rounded-xl px-3 py-2 text-body outline-none"
                style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                <option value="updated">Recently updated</option>
                <option value="created">Recently created</option>
                <option value="priority">Priority</option>
              </select>
            )}

            {useOrgMode && (
              <span className="badge" style={{ background: 'var(--purple-dim)', color: 'var(--purple)' }}>
                <Briefcase size={11} /> org-wide
              </span>
            )}
          </div>

          {/* Phase chips (list view) */}
          {view === 'list' && (
            <div className="chip-row">
              {PHASE_CHIPS.map((chip) => {
                const active = phaseFilter === chip.value;
                const count = counts[chip.value as keyof typeof counts] ?? 0;
                return (
                  <button
                    key={chip.value || 'all'}
                    onClick={() => setParam('phase', chip.value || null)}
                    className="badge focus-ring flex-shrink-0 transition-all"
                    style={{
                      padding: '5px 12px',
                      fontSize: 12,
                      background: active ? 'var(--bg-4)' : 'var(--bg-1)',
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                      border: `1px solid ${active ? 'var(--border-bright)' : 'var(--border)'}`,
                      cursor: 'pointer',
                    }}
                  >
                    {chip.tone && (
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: chip.tone }} />
                    )}
                    {chip.label}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── LIST VIEW ── */}
        {view === 'list' && (
          <div className="flex-1 min-h-0 overflow-y-auto pb-8 rise-in" style={{ animationDelay: '80ms' }}>
            {/* Desktop table */}
            <div className="card overflow-hidden hidden md:block">
              <div className="table-wrap">
                <table className="htable">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Job</th>
                      {useOrgMode && <th>Project</th>}
                      <th>Priority</th>
                      <th>Harness</th>
                      <th className="num">{sortField === 'created' ? 'Created' : 'Updated'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((job) => {
                      const tone = jobStatusTone(job);
                      const toneColor =
                        tone === 'error' ? 'var(--red)'
                        : tone === 'warning' ? 'var(--amber)'
                        : tone === 'info' ? 'var(--blue)'
                        : tone === 'success' ? 'var(--green)'
                        : 'var(--text-primary)';
                      return (
                        <tr
                          key={job.id}
                          onClick={() => openJob(job)}
                          style={{
                            cursor: 'pointer',
                            background: selectedJob?.id === job.id ? 'var(--blue-dim)' : undefined,
                          }}
                        >
                          <td>
                            <div className="flex items-center gap-2 min-w-[7rem]">
                              <HealthDot status={phaseToHealthStatus(job.phase)} />
                              <span className="text-label font-semibold" style={{ color: toneColor }}>
                                {jobStatusLabel(job)}
                              </span>
                            </div>
                          </td>
                          <td className="max-w-md">
                            <div className="text-body font-medium truncate">{job.title}</div>
                            <div className="flex items-center gap-2 mt-0.5 text-label" style={{ color: 'var(--text-muted)' }}>
                              <span className="mono">{job.id}</span>
                              {job.env_name && (
                                <span className="badge" style={{ background: 'var(--bg-3)', fontSize: 10 }}>
                                  {job.env_name}
                                </span>
                              )}
                              {jobStatusDetail(job) && (
                                <span className="truncate">{jobStatusDetail(job)}</span>
                              )}
                            </div>
                          </td>
                          {useOrgMode && (
                            <td>
                              <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-secondary)' }}>
                                {job._projectName ?? '—'}
                              </span>
                            </td>
                          )}
                          <td><PriorityBadge priority={job.priority} /></td>
                          <td className="mono text-label" style={{ color: 'var(--text-secondary)' }}>
                            {job.harness ?? '—'}
                          </td>
                          <td className="num text-label" style={{ color: 'var(--text-muted)' }}>
                            {timeAgo(sortField === 'created' ? job.created_at : job.updated_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filtered.length === 0 && <EmptyJobs message={emptyMessage} />}
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {filtered.map((job) => (
                <button
                  key={job.id}
                  onClick={() => openJob(job)}
                  className="card card-pad w-full text-left card-hover"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <HealthDot status={phaseToHealthStatus(job.phase)} />
                        <span className="text-body font-medium truncate">{job.title}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-label flex-wrap" style={{ color: 'var(--text-muted)' }}>
                        <span className="mono">{job.id.slice(0, 20)}</span>
                        {job._projectName && <span>· {job._projectName}</span>}
                        <span>· {timeAgo(job.updated_at)}</span>
                      </div>
                      {jobStatusDetail(job) && (
                        <div className="text-label mt-1 line-clamp-1" style={{ color: 'var(--text-secondary)' }}>
                          {jobStatusDetail(job)}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                      <span className="text-label font-semibold" style={{
                        color: jobStatusTone(job) === 'error' ? 'var(--red)'
                          : jobStatusTone(job) === 'warning' ? 'var(--amber)'
                          : jobStatusTone(job) === 'info' ? 'var(--blue)'
                          : jobStatusTone(job) === 'success' ? 'var(--green)'
                          : 'var(--text-secondary)',
                      }}>
                        {jobStatusLabel(job)}
                      </span>
                      <PriorityBadge priority={job.priority} />
                    </div>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="card"><EmptyJobs message={emptyMessage} /></div>
              )}
            </div>
          </div>
        )}

        {/* ── BOARD VIEW ── */}
        {view === 'board' && (
          <div className="flex-1 min-h-0 overflow-x-auto -mx-4 px-4 rise-in" style={{ animationDelay: '80ms' }}>
            <div className="flex gap-4 min-w-max h-full pb-6">
              {BOARD_COLUMNS.map((column) => {
                const columnJobs = grouped[column] ?? [];
                const isDone = column === 'done';
                const showCollapsed = isDone && !doneExpanded && columnJobs.length > 3;
                const visibleJobs = showCollapsed ? columnJobs.slice(0, 3) : columnJobs;
                const headerColor =
                  column === 'cancelled' ? 'var(--red)'
                  : column === 'review' ? 'var(--amber)'
                  : column === 'active' ? 'var(--blue)'
                  : 'var(--text-secondary)';

                return (
                  <div key={column} className="board-col w-[280px] sm:w-72 flex flex-col">
                    <div className="flex items-center justify-between mb-2.5 px-0.5">
                      <h3 className="text-body font-semibold" style={{ color: headerColor }}>
                        {columnLabels[column]}
                      </h3>
                      <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-muted)' }}>
                        {columnJobs.length}
                      </span>
                    </div>

                    <div className="flex-1 space-y-2 overflow-y-auto">
                      {showCollapsed && (
                        <button
                          onClick={() => setDoneExpanded(true)}
                          className="w-full text-center py-2 rounded-xl text-label transition-colors"
                          style={{ background: 'var(--bg-2)', color: 'var(--text-secondary)' }}
                        >
                          {columnJobs.length} done — show all
                        </button>
                      )}
                      {isDone && doneExpanded && columnJobs.length > 3 && (
                        <button
                          onClick={() => setDoneExpanded(false)}
                          className="w-full text-center py-2 rounded-xl text-label transition-colors"
                          style={{ background: 'var(--bg-2)', color: 'var(--text-secondary)' }}
                        >
                          Collapse
                        </button>
                      )}
                      {visibleJobs.map((job) => (
                        <div key={job.id} className={transitioningJobs.has(job.id) ? 'board-enter' : ''}>
                          <JobCard
                            job={job}
                            showProject={useOrgMode ? (job as JobRow)._projectName : undefined}
                            onClick={() => openJob(job as JobRow)}
                          />
                        </div>
                      ))}
                      {columnJobs.length === 0 && (
                        <div
                          className="text-center text-label py-8 rounded-xl border border-dashed"
                          style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}
                        >
                          Empty
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <JobDetail job={selectedJob} onClose={closeJob} onNavigateJob={navigateToJob} />
    </div>
  );
}

function EmptyJobs({ message }: { message: string }) {
  return (
    <div className="px-4 py-14 text-center" style={{ color: 'var(--text-muted)' }}>
      <Briefcase size={30} className="mx-auto mb-2 opacity-40" />
      <div className="text-body">{message}</div>
    </div>
  );
}

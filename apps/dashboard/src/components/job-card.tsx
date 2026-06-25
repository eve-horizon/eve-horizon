import { elapsed } from '@/lib/format';
import { PriorityBadge } from './priority-badge';
import {
  jobStatusDetail,
  jobStatusLabel,
  jobStatusTone,
  type Job,
} from '@/hooks/use-jobs';

interface JobCardProps {
  job: Job;
  showProject?: string;
  onClick?: () => void;
}

export function JobCard({ job, showProject, onClick }: JobCardProps) {
  const isActive = job.phase === 'active';
  const statusLabel = jobStatusLabel(job);
  const statusDetail = jobStatusDetail(job);
  const statusTone = jobStatusTone(job);

  const toneClasses =
    statusTone === 'error'
      ? 'border-[var(--red)] bg-[var(--red-dim)]/40'
      : statusTone === 'warning'
        ? 'border-[var(--amber)] bg-[var(--amber-dim)]/40'
        : statusTone === 'info'
          ? 'border-[var(--blue)]'
          : 'border-[var(--color-border)]';

  const badgeClasses =
    statusTone === 'error'
      ? 'bg-[var(--red-dim)] text-[var(--red)]'
      : statusTone === 'warning'
        ? 'bg-[var(--amber-dim)] text-[var(--amber)]'
        : statusTone === 'info'
          ? 'bg-[var(--blue-dim)] text-[var(--blue)]'
          : statusTone === 'success'
            ? 'bg-[var(--green-dim)] text-[var(--green)]'
            : 'bg-[var(--bg-3)] text-[var(--color-text-secondary)]';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg bg-[var(--color-surface)] border p-3 hover:border-[var(--color-accent)] transition-colors cursor-pointer ${toneClasses}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-body font-medium truncate">{job.title}</div>
          {statusDetail && (
            <div className="mt-1 text-label text-[var(--color-text-secondary)] line-clamp-2">
              {statusDetail}
            </div>
          )}
        </div>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${badgeClasses}`}>
          {statusLabel}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1.5 text-label text-[var(--color-text-secondary)]">
        <PriorityBadge priority={job.priority} />
        {job.env_name && <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5">{job.env_name}</span>}
        {job.harness && <span className="font-mono">{job.harness}</span>}
        {isActive && job.started_at && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
            {elapsed(job.started_at)}
          </span>
        )}
        {showProject && (
          <span className="ml-auto text-[var(--color-text-muted)] truncate">{showProject}</span>
        )}
      </div>
    </button>
  );
}

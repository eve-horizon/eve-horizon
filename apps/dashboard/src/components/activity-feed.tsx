import { timeAgo, formatEventDescription } from '@/lib/format';
import type { OrgEvent } from '@/hooks/use-analytics';

interface ActivityFeedProps {
  events: OrgEvent[];
}

const eventDotColors: Record<string, string> = {
  'job.failed': 'bg-[var(--color-error)]',
  'deploy.failed': 'bg-[var(--color-error)]',
  'pipeline.run_failed': 'bg-[var(--color-error)]',
  'job.completed': 'bg-[var(--color-success)]',
  'deploy.completed': 'bg-[var(--color-success)]',
  'pipeline.run_completed': 'bg-[var(--color-success)]',
  'job.phase_changed': 'bg-[var(--color-accent)]',
  'deploy.started': 'bg-[var(--color-accent)]',
};

export function ActivityFeed({ events }: ActivityFeedProps) {
  if (!events.length) {
    return <div className="text-label text-[var(--color-text-muted)] py-4">No recent activity</div>;
  }

  return (
    <div className="space-y-2">
      {events.map((event) => {
        const dotColor = eventDotColors[event.type] ?? 'bg-[var(--color-text-muted)]';
        return (
          <div key={event.id} className="flex items-start gap-2 text-body">
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
            <span className="flex-1 truncate">{formatEventDescription(event)}</span>
            <span className="text-label text-[var(--color-text-muted)] flex-shrink-0">
              {timeAgo(event.created_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

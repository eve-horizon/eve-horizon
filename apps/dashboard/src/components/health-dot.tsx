interface HealthDotProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusColors: Record<string, string> = {
  healthy: 'bg-[var(--color-success)]',
  ready: 'bg-[var(--color-success)]',
  running: 'bg-[var(--color-success)]',
  deploying: 'bg-[var(--color-accent)]',
  degraded: 'bg-[var(--color-warning)]',
  warning: 'bg-[var(--color-warning)]',
  down: 'bg-[var(--color-error)]',
  failed: 'bg-[var(--color-error)]',
  critical: 'bg-[var(--color-error)]',
  unknown: 'bg-[var(--color-text-muted)]',
};

const sizeClasses = { sm: 'w-2 h-2', md: 'w-2.5 h-2.5' };

export function HealthDot({ status, size = 'sm' }: HealthDotProps) {
  const color = statusColors[status] ?? statusColors['unknown']!;
  return (
    <span
      className={`inline-block rounded-full ${color} ${sizeClasses[size]}`}
      title={status}
    />
  );
}

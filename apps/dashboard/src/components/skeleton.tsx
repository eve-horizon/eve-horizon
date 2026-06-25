// ---------------------------------------------------------------------------
// Skeleton — loading placeholders
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`animate-skeleton rounded ${className ?? ''}`}
      style={{ background: 'var(--bg-3)' }}
    />
  );
}

export function StatCardSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg p-4"
          style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
        >
          <Skeleton className="h-3 w-20 mb-3" />
          <Skeleton className="h-7 w-14 mb-2" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div
        className="flex gap-4 px-4 py-3"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20 ml-auto" />
        <Skeleton className="h-3 w-16" />
      </div>

      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3"
          style={{ borderBottom: i < rows - 1 ? '1px solid var(--border)' : undefined }}
        >
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-16 ml-auto" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div
      className="rounded-lg p-4"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      <Skeleton className="h-4 w-32 mb-3" />
      <Skeleton className="h-3 w-full mb-2" />
      <Skeleton className="h-3 w-3/4 mb-2" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

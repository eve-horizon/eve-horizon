export function StatPill({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-label text-[var(--text-secondary)] bg-[var(--bg-1)] border border-[var(--border)] rounded-full px-3 py-1">
      <span className="font-semibold" style={color ? { color } : undefined}>{value}</span>
      {label}
    </span>
  );
}

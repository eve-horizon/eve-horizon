import type { ReactNode } from 'react';

interface StatCardProps {
  value: number | string;
  label: string;
  accent?: 'default' | 'error' | 'success' | 'warning' | 'info';
  hint?: string;
  icon?: ReactNode;
}

const accentColors: Record<string, string> = {
  default: 'var(--text-primary)',
  error: 'var(--red)',
  success: 'var(--green)',
  warning: 'var(--amber)',
  info: 'var(--blue)',
};

export function StatCard({ value, label, accent = 'default', hint, icon }: StatCardProps) {
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-2">
        <div className="stat-label">{label}</div>
        {icon && <div style={{ color: 'var(--text-muted)' }}>{icon}</div>}
      </div>
      <div className="stat-value mt-1.5" style={{ color: accentColors[accent] }}>
        {value}
      </div>
      {hint && (
        <div className="text-label mt-1" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

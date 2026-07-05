import type { ReactNode } from 'react';

export function Badge({ children, color = 'var(--bg-3)', textColor = 'var(--text-secondary)' }: { children: ReactNode; color?: string; textColor?: string }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-label font-medium"
      style={{ background: color, color: textColor }}
    >
      {children}
    </span>
  );
}

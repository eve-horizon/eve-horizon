import type { ReactNode } from 'react';

export function Card({ children, accent, onClick, className = '' }: { children: ReactNode; accent?: string; onClick?: () => void; className?: string }) {
  return (
    <div
      onClick={onClick}
      className={`bg-[var(--bg-1)] rounded-lg border border-[var(--border)] overflow-hidden ${onClick ? 'cursor-pointer hover:border-[var(--border-bright)] transition-colors' : ''} ${className}`}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      {children}
    </div>
  );
}

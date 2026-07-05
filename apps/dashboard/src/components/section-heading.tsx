import type { ReactNode } from 'react';

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-emphasis font-medium text-[var(--text-primary)] mb-3">{children}</h3>;
}

import { Bot } from 'lucide-react';

export function EmptyState({ icon: Icon, title, subtitle }: { icon: typeof Bot; title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-[var(--bg-3)] flex items-center justify-center mb-4">
        <Icon size={24} className="text-[var(--text-muted)]" />
      </div>
      <div className="text-body font-medium text-[var(--text-secondary)] mb-1">{title}</div>
      {subtitle && <div className="text-label text-[var(--text-muted)] max-w-xs">{subtitle}</div>}
    </div>
  );
}

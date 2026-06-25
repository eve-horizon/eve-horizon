import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  width?: string;
}

export function SlideOver({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 'w-full sm:w-[72%] sm:max-w-3xl',
}: SlideOverProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    if (open) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-fade-in" style={{ background: 'var(--backdrop)' }} onClick={onClose} />
      <div
        className={`relative ${width} h-full overflow-y-auto animate-slide-in`}
        style={{ background: 'var(--bg-1)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)' }}
      >
        <div
          className="sticky top-0 z-10 flex items-center justify-between px-4 sm:px-6 py-4"
          style={{ background: 'var(--bg-1)', borderBottom: '1px solid var(--border)' }}
        >
          <div className="min-w-0">
            {title && <h2 className="text-section font-medium font-display truncate">{title}</h2>}
            {subtitle && (
              <p className="text-label mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors flex-shrink-0 ml-2 focus-ring hover:bg-[var(--bg-3)]"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

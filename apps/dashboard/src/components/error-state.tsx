export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="text-label" style={{ color: 'var(--red)' }}>{message}</div>
    </div>
  );
}

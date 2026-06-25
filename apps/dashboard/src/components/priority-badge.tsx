interface PriorityBadgeProps {
  priority: number;
}

const priorityColors: Record<number, string> = {
  0: 'bg-red-500 text-white',
  1: 'bg-amber-500 text-white',
  2: 'bg-blue-500 text-white',
  3: 'bg-gray-500 text-white',
  4: 'bg-gray-700 text-white',
};

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  const color = priorityColors[priority] ?? priorityColors[3]!;
  return (
    <span className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      P{priority}
    </span>
  );
}

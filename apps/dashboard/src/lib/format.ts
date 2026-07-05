/** Format a date as relative time (e.g. "2m ago") */
export function timeAgo(date: string | Date): string {
  const now = Date.now();
  const then = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format elapsed duration from a start time */
export function elapsed(startedAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Format USD currency from a string decimal */
export function formatUsd(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

/** Map event types to human-readable text */
export function formatEventDescription(event: {
  type: string;
  source?: string;
  status?: string;
  project_slug?: string;
}): string {
  const src = event.source ?? 'unknown';
  const status = event.status ?? '';
  const templates: Record<string, string> = {
    'job.phase_changed': `Job ${src} moved to ${status}`,
    'job.created': `Job ${src} created`,
    'job.completed': `Job ${src} completed`,
    'job.failed': `Job ${src} failed`,
    'deploy.completed': `Deploy ${src} completed`,
    'deploy.started': `Deploy ${src} started`,
    'deploy.failed': `Deploy ${src} failed`,
    'pipeline.step_completed': `Pipeline step ${src} ${status}`,
    'pipeline.run_completed': `Pipeline ${src} completed`,
    'pipeline.run_failed': `Pipeline ${src} failed`,
    'agent.started': `Agent ${src} started`,
    'agent.stopped': `Agent ${src} stopped`,
    'env.health_changed': `Environment ${src} is now ${status}`,
  };
  const known = templates[event.type];
  if (known) return known;

  // Fallback: turn "system.job.attempt.completed" into "Job attempt completed"
  const pretty = event.type
    .replace(/^system\./, '')
    .replace(/[._]/g, ' ')
    .trim();
  const sentence = pretty.charAt(0).toUpperCase() + pretty.slice(1);
  const boring = ['system', 'unknown', 'runner', 'cron', 'orchestrator'];
  const suffix = src && !boring.includes(src) ? ` · ${src}` : '';
  return `${sentence}${suffix}`;
}

/** Compact number with thousands separators */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Translate a cron expression into a human-readable string */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, , dow] = parts;

  if (min === '*' && hour === '*') return 'Every minute';
  if (hour === '*' && min !== '*') return `Every hour at :${min!.padStart(2, '0')}`;

  const dayNames: Record<string, string> = { '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };

  let timeStr = '';
  if (hour !== '*' && min !== '*') {
    timeStr = `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
  }

  if (dow !== '*' && dow !== '?') {
    const days = dow!.split(',').map((d) => dayNames[d] ?? d).join(', ');
    return timeStr ? `${days} at ${timeStr}` : `${days}`;
  }
  if (dom !== '*' && dom !== '?') {
    return timeStr ? `Day ${dom} at ${timeStr}` : `Day ${dom}`;
  }
  return timeStr ? `Daily at ${timeStr}` : cron;
}

/** Format a date for table display */
export function formatDate(d: string | undefined | null): string {
  if (!d) return '\u2014';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '\u2014';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Truncate a git SHA */
export function shortSha(sha: string | undefined | null): string {
  if (!sha) return '\u2014';
  return sha.slice(0, 8);
}

/**
 * Lifecycle event phases for job execution observability.
 * These map to type = 'lifecycle_<phase>_<action>' in execution_logs.
 */
export type LifecyclePhase = 'workspace' | 'hook' | 'secrets' | 'services' | 'harness' | 'runner';

export type LifecycleAction = 'start' | 'end' | 'log';

/**
 * Structured lifecycle event for job execution debugging.
 * Stored in execution_logs with type = 'lifecycle_<phase>_<action>'.
 */
export interface LifecycleEvent extends Record<string, unknown> {
  ts: string;              // ISO timestamp
  phase: LifecyclePhase;
  action: LifecycleAction;
  duration_ms?: number;    // For end events
  success?: boolean;       // For end events
  error?: string;          // For failed end events
  meta: Record<string, unknown>;
}

/**
 * Helper to generate lifecycle log type string.
 */
export function lifecycleLogType(phase: LifecyclePhase, action: LifecycleAction): string {
  return `lifecycle_${phase}_${action}`;
}

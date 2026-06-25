import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export const CORRELATION_HEADER = 'x-eve-correlation-id';

export type CorrelationContext = {
  correlationId: string;
  traceId: string;
  jobId?: string;
  attemptId?: string;
  eventId?: string;
};

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function ensureCorrelationId(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value[0] || randomUUID();
  }

  if (value && value.trim().length > 0) {
    return value.trim();
  }

  return randomUUID();
}

export function runWithCorrelationContext<T>(
  context: CorrelationContext,
  fn: () => T,
): T {
  return correlationStorage.run(context, fn);
}

export function withCorrelationContext<T>(
  partial: Partial<CorrelationContext>,
  fn: () => T,
): T {
  const current = correlationStorage.getStore();
  const generated = ensureCorrelationId();
  const base = current ?? {
    correlationId: generated,
    traceId: generated,
  };

  return correlationStorage.run({ ...base, ...partial }, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationHeaders(): Record<string, string> {
  const context = correlationStorage.getStore();
  if (!context?.correlationId) {
    return {};
  }

  return { [CORRELATION_HEADER]: context.correlationId };
}

export function getCorrelationLogFields(): Record<string, string> {
  const context = correlationStorage.getStore();
  if (!context) {
    return {};
  }

  return {
    correlation_id: context.correlationId,
    trace_id: context.traceId,
    ...(context.jobId ? { job_id: context.jobId } : {}),
    ...(context.attemptId ? { attempt_id: context.attemptId } : {}),
    ...(context.eventId ? { event_id: context.eventId } : {}),
  };
}

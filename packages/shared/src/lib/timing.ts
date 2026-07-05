/**
 * Parse a positive timeout expressed in seconds from job hints or env
 * config. Accepts finite positive numbers or numeric strings; anything else
 * resolves to null so callers can apply their own default.
 */
export function readPositiveTimeoutSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export interface WaitForOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Called once per poll tick, after the predicate returns falsy. */
  onTick?: (elapsedMs: number) => void;
  /** Label used in the timeout error message. */
  label?: string;
}

/**
 * Poll `predicate` until it returns a truthy value or the timeout elapses.
 * Resolves with the predicate's value; throws on timeout.
 */
export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined | false>,
  options: WaitForOptions,
): Promise<T> {
  const intervalMs = options.intervalMs ?? 2000;
  const start = Date.now();
  for (;;) {
    const result = await predicate();
    if (result) {
      return result as T;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= options.timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${options.label ?? 'condition'}`,
      );
    }
    options.onTick?.(elapsed);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

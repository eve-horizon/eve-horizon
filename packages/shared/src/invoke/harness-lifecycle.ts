/**
 * Thin wrappers for harness start/end lifecycle events.
 *
 * Provides a structured API so callers don't need to assemble the raw
 * lifecycle event shape themselves. Both agent-runtime and worker can
 * import these instead of inlining the same meta-building logic.
 */

import type { LifecycleLogger } from './types.js';

/**
 * Emit a `harness:start` lifecycle event with the given harness metadata.
 */
export async function logHarnessStart(
  logLifecycle: LifecycleLogger,
  attemptId: string,
  meta: {
    harness: string;
    permission: string;
    variant?: string;
    model?: string;
    reasoning?: string;
    harness_options?: Record<string, unknown>;
  },
): Promise<void> {
  await logLifecycle(attemptId, 'harness', 'start', {
    harness: meta.harness,
    permission: meta.permission,
    ...(meta.variant ? { variant: meta.variant } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.reasoning ? { reasoning: meta.reasoning } : {}),
    ...(meta.harness_options && Object.keys(meta.harness_options).length > 0
      ? { harness_options: meta.harness_options }
      : {}),
  });
}

/**
 * Emit a `harness:end` lifecycle event with exit code, duration, and
 * optional error details.
 */
export async function logHarnessEnd(
  logLifecycle: LifecycleLogger,
  attemptId: string,
  meta: {
    harness: string;
    permission: string;
    reasoning?: string;
    harness_options?: Record<string, unknown>;
    exit_code: number;
  },
  durationMs: number,
  errorMessage?: string,
): Promise<void> {
  await logLifecycle(
    attemptId,
    'harness',
    'end',
    {
      harness: meta.harness,
      permission: meta.permission,
      ...(meta.harness_options && Object.keys(meta.harness_options).length > 0
        ? { harness_options: meta.harness_options }
        : {}),
      ...(meta.reasoning ? { reasoning: meta.reasoning } : {}),
      exit_code: meta.exit_code,
    },
    {
      duration_ms: durationMs,
      success: meta.exit_code === 0,
      error: meta.exit_code !== 0 ? errorMessage : undefined,
    },
  );
}

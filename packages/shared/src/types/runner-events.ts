import type { HarnessResult } from './harness.js';

/**
 * Runner event payload types for event-driven worker-runner communication.
 * Events follow the pattern: runner.<event_type>
 */

/** Base payload fields required for all runner events */
export interface RunnerEventBasePayload {
  attempt_id: string;
  job_id: string;
}

/** Payload for runner.started - Runner accepted job and is executing */
export interface RunnerStartedPayload extends RunnerEventBasePayload {
  // No additional fields beyond base
}

/** Payload for runner.progress - Optional progress updates during execution */
export interface RunnerProgressPayload extends RunnerEventBasePayload {
  message: string;
  percentage?: number;
}

/** Payload for runner.completed - Job finished successfully */
export interface RunnerCompletedPayload extends RunnerEventBasePayload {
  result: HarnessResult;
}

/** Payload for runner.failed - Job failed with error */
export interface RunnerFailedPayload extends RunnerEventBasePayload {
  error: string;
  exit_code?: number;
}

/** Union type of all runner event payloads */
export type RunnerEventPayload =
  | RunnerStartedPayload
  | RunnerProgressPayload
  | RunnerCompletedPayload
  | RunnerFailedPayload;

/** Runner event type constants */
export const RunnerEventType = {
  STARTED: 'runner.started',
  PROGRESS: 'runner.progress',
  COMPLETED: 'runner.completed',
  FAILED: 'runner.failed',
} as const;

export type RunnerEventTypeValue = (typeof RunnerEventType)[keyof typeof RunnerEventType];

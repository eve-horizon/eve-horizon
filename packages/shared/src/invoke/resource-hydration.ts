/**
 * Resource hydration event emission — emits system.resource.hydration.* events
 * during workspace provisioning.
 *
 * Extracted from the worker's invoke.service.ts. Both worker and agent-runtime
 * can use this via dependency injection of the EventCreator interface.
 */

import { generateEventId } from '../ids.js';
import type { HarnessInvocation } from '../types/harness.js';
import type { ResourceHydrationEventType } from './types.js';

interface EventCreator {
  create(event: {
    id: string;
    project_id: string;
    type: string;
    source: string;
    env_name: string | null;
    ref_sha: string | null;
    ref_branch: string | null;
    actor_type: string;
    actor_id: string | null;
    payload_json: Record<string, unknown>;
    dedupe_key: string;
  }): Promise<unknown>;
}

export async function emitResourceHydrationEvent(
  events: EventCreator,
  invocation: HarnessInvocation,
  type: ResourceHydrationEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await events.create({
      id: generateEventId(),
      project_id: invocation.projectId,
      type,
      source: 'system',
      env_name: null,
      ref_sha: null,
      ref_branch: null,
      actor_type: 'system',
      actor_id: null,
      payload_json: payload,
      dedupe_key: `resource:${invocation.attemptId}:${type}`,
    });
  } catch (err) {
    console.warn(`[resources] Failed to emit ${type}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

import {
  loadConfig,
  getCorrelationHeaders,
  type HarnessResult,
} from '../index.js';

export type RunnerEmitterEventType =
  | 'runner.started'
  | 'runner.progress'
  | 'runner.completed'
  | 'runner.failed';

export interface RunnerEmitterEventPayload {
  attemptId: string;
  jobId: string;
  result?: HarnessResult;
  error?: string;
  exitCode?: number;
  message?: string;
  percentage?: number;
}

export interface EmitEventResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Emit a runner event to the Eve API.
 *
 * This function sends lifecycle events from the runner back to the API for tracking
 * job execution progress. It uses the same auth pattern as secret resolution.
 *
 * @param projectId - The project ID
 * @param eventType - The type of runner event
 * @param payload - The event payload containing attempt/job IDs and result data
 * @returns Result indicating success/failure and the event ID if successful
 */
export async function emitRunnerEvent(
  projectId: string,
  eventType: RunnerEmitterEventType,
  payload: RunnerEmitterEventPayload,
): Promise<EmitEventResult> {
  try {
    const config = loadConfig();

    // Check if API connection is configured
    if (!config.EVE_INTERNAL_API_KEY || !config.EVE_API_URL) {
      console.warn(
        `[emitRunnerEvent] API connection not configured (missing EVE_API_URL or EVE_INTERNAL_API_KEY), skipping event emission for ${eventType}`
      );
      return { success: false, error: 'API connection not configured' };
    }

    // Build the event body
    const eventBody = {
      type: eventType,
      source: 'runner',
      payload_json: payload,
    };

    // Make the API request
    const url = `${config.EVE_API_URL}/internal/projects/${projectId}/events`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': config.EVE_INTERNAL_API_KEY,
        ...getCorrelationHeaders(),
      },
      body: JSON.stringify(eventBody),
    });

    if (!response.ok) {
      const errMsg = `HTTP ${response.status}: ${response.statusText}`;
      console.warn(`[emitRunnerEvent] Failed to emit ${eventType}: ${errMsg}`);
      return { success: false, error: errMsg };
    }

    // Parse the response to extract the event ID
    const json = (await response.json()) as Record<string, unknown>;
    const data = json?.data as Record<string, unknown> | undefined;
    const eventId = (data?.id || json?.id) as string | undefined;

    if (!eventId) {
      console.warn(`[emitRunnerEvent] Event emitted but no ID returned for ${eventType}`);
    }

    return { success: true, eventId };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[emitRunnerEvent] Error emitting ${eventType}: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

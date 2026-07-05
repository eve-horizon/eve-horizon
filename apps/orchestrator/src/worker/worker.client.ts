import {
  ensureCorrelationId,
  getCorrelationContext,
  getCorrelationHeaders,
  loadConfig,
  withCorrelationContext,
  parseWorkerUrlMapping,
} from '@eve/shared';
import type { AttemptId, HarnessInvocation, HarnessResult } from '@eve/shared';

interface RunnerEvent {
  id: string;
  type: string;
  payload_json: {
    attemptId: string;
    jobId: string;
    result?: HarnessResult;
    error?: string;
    exitCode?: number;
  };
}

function resolvePollIntervalMs(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 100) {
    return fallback;
  }
  return parsed;
}

/**
 * Poll for runner completion events.
 * The worker now returns 202 immediately and reports results via events.
 */
async function pollForCompletion(
  projectId: string,
  attemptId: string,
  jobId: string,
  pollIntervalMs: number = 5000,
  timeoutMs: number = 1800000,
  timeoutErrorCode?: string,
): Promise<HarnessResult> {
  const config = loadConfig();
  const startTime = Date.now();
  let pollCount = 0;
  let lastLoggedStatus = 0;
  const jobStatusCheckIntervalMs = Math.max(5000, pollIntervalMs * 6);
  let nextJobStatusCheckMs = jobStatusCheckIntervalMs;

  // Narrow to this attempt to avoid losing completion events in high-volume projects.
  const since = new Date(startTime - 60_000).toISOString();
  const url =
    `${config.EVE_API_URL}/internal/projects/${projectId}/events` +
    `?type=runner.completed,runner.failed` +
    `&attempt_id=${encodeURIComponent(attemptId)}` +
    `&since=${encodeURIComponent(since)}` +
    `&limit=5`;
  console.log(`[orch-poll] Starting poll for attemptId=${attemptId} jobId=${jobId} projectId=${projectId}`);
  console.log(`[orch-poll] URL: ${url}`);
  console.log(`[orch-poll] Has internal API key: ${!!config.EVE_INTERNAL_API_KEY}`);

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    try {
      const response = await fetch(url, {
        headers: {
          'x-eve-internal-token': config.EVE_INTERNAL_API_KEY!,
          ...getCorrelationHeaders(),
        },
      });

      if (response.ok) {
        const json = await response.json();
        const events = json.data || [];

        // Find event matching our attemptId
        const completionEvent = events.find((e: RunnerEvent) =>
          e.payload_json?.attemptId === attemptId &&
          (e.type === 'runner.completed' || e.type === 'runner.failed')
        );

        if (completionEvent) {
          console.log(`[orch-poll] Found completion event after ${pollCount} polls (${Date.now() - startTime}ms): type=${completionEvent.type}`);
          if (completionEvent.type === 'runner.completed') {
            return completionEvent.payload_json.result!;
          } else {
            // runner.failed
            return {
              attemptId: attemptId as AttemptId,
              success: false,
              exitCode: completionEvent.payload_json.exitCode ?? 1,
              error: completionEvent.payload_json.error || 'Runner failed',
            };
          }
        }

        // Log periodically when no match found (every 30s)
        const elapsed = Date.now() - startTime;
        if (elapsed - lastLoggedStatus >= 30000) {
          lastLoggedStatus = elapsed;
          const attemptIds = events.map((e: RunnerEvent) => e.payload_json?.attemptId).filter(Boolean);
          console.log(`[orch-poll] Poll #${pollCount} (${Math.round(elapsed / 1000)}s): ${events.length} events returned, none match attemptId=${attemptId}. Response keys: ${Object.keys(json).join(',')}. Event attemptIds: [${attemptIds.join(', ')}]`);
        }
      } else {
        const body = await response.text().catch(() => '<unreadable>');
        if (pollCount <= 3 || Date.now() - startTime - lastLoggedStatus >= 30000) {
          lastLoggedStatus = Date.now() - startTime;
          console.error(`[orch-poll] Poll #${pollCount}: HTTP ${response.status} ${response.statusText}. Body: ${body.slice(0, 500)}`);
        }
      }
    } catch (err) {
      console.warn(`[orch-poll] Poll #${pollCount} exception: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check job phase periodically to detect cancellation.
    if (Date.now() - startTime >= nextJobStatusCheckMs) {
      nextJobStatusCheckMs += jobStatusCheckIntervalMs;
      try {
        const jobUrl = `${config.EVE_API_URL}/jobs/${jobId}`;
        const jobResponse = await fetch(jobUrl, {
          headers: {
            'x-eve-internal-token': config.EVE_INTERNAL_API_KEY!,
            ...getCorrelationHeaders(),
          },
        });
        if (jobResponse.ok) {
          const jobData = await jobResponse.json();
          const phase = jobData.phase ?? jobData.data?.phase;
          if (phase === 'cancelled' || phase === 'done') {
            console.log(`[orch-poll] Job ${jobId} phase changed to '${phase}' during polling — aborting wait`);
            return {
              attemptId: attemptId as AttemptId,
              success: false,
              exitCode: 1,
              error: `Job ${jobId} was ${phase} during execution`,
            };
          }
        }
      } catch (err) {
        console.warn(`[orch-poll] Job status check error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout
  console.error(`[orch-poll] TIMEOUT after ${pollCount} polls (${timeoutMs}ms) for attemptId=${attemptId} jobId=${jobId}`);
  const timeoutMessage = `Runner timed out after ${timeoutMs}ms`;
  return {
    attemptId: attemptId as AttemptId,
    success: false,
    exitCode: 1,
    error: timeoutErrorCode ? `${timeoutErrorCode}: ${timeoutMessage}` : timeoutMessage,
  };
}

/**
 * Worker HTTP client for Phase 4.
 *
 * Invokes the worker service via HTTP POST to /invoke endpoint.
 * Worker returns 202 immediately, then reports results via events.
 * This function polls for the completion event.
 *
 * Configuration:
 * - EVE_WORKER_URLS: Comma-separated name=url list (e.g. "default-worker=http://worker:4711")
 * - WORKER_URL: Fallback worker URL (default: http://localhost:4749)
 * - WORKER_TIMEOUT_MS: Timeout in milliseconds (default: 1800000 / 30 minutes)
 */
export async function invokeWorker(
  invocation: HarnessInvocation,
  workerImage?: string,
  timeoutMs?: number,
): Promise<HarnessResult> {
  const workerUrl = resolveWorkerUrl(workerImage);
  const effectiveTimeout =
    timeoutMs ?? parseInt(process.env.WORKER_TIMEOUT_MS || '1800000', 10);
  const existing = getCorrelationContext();
  const correlationId = ensureCorrelationId(existing?.correlationId);

  try {
    return await withCorrelationContext({ correlationId, traceId: correlationId }, async () => {
      // Step 1: Submit job to worker (returns 202 immediately)
      const response = await fetch(`${workerUrl}/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCorrelationHeaders(),
        },
        body: JSON.stringify(invocation),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          attemptId: invocation.attemptId,
          success: false,
          exitCode: 1,
          error: `Worker returned ${response.status}: ${errorText}`,
        };
      }

      const submitResult = await response.json();
      if (!submitResult.accepted) {
        return {
          attemptId: invocation.attemptId,
          success: false,
          exitCode: 1,
          error: `Worker rejected job: ${submitResult.error || 'unknown'}`,
        };
      }

      // Step 2: Poll for completion event
      const pollInterval = resolvePollIntervalMs(process.env.EVE_WORKER_POLL_INTERVAL_MS, 5000);
      return await pollForCompletion(
        invocation.projectId,
        invocation.attemptId,
        invocation.jobId,
        pollInterval,
        effectiveTimeout,
      );
    });
  } catch (error) {
    const errorMessage = `Failed to invoke worker: ${error instanceof Error ? error.message : String(error)}`;

    return {
      attemptId: invocation.attemptId,
      success: false,
      exitCode: 1,
      error: errorMessage,
    };
  }
}

export async function invokeAgentRuntime(
  invocation: HarnessInvocation,
  timeoutMs?: number,
): Promise<HarnessResult> {
  const runtimeUrl = resolveAgentRuntimeUrl();
  if (!runtimeUrl) {
    return {
      attemptId: invocation.attemptId,
      success: false,
      exitCode: 1,
      error: 'Agent runtime URL not configured',
    };
  }

  const effectiveTimeout =
    timeoutMs ?? parseInt(process.env.WORKER_TIMEOUT_MS || '1800000', 10);
  const existing = getCorrelationContext();
  const correlationId = ensureCorrelationId(existing?.correlationId);

  try {
    return await withCorrelationContext({ correlationId, traceId: correlationId }, async () => {
      const response = await fetch(`${runtimeUrl}/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCorrelationHeaders(),
        },
        body: JSON.stringify(invocation),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          attemptId: invocation.attemptId,
          success: false,
          exitCode: 1,
          error: `Agent runtime returned ${response.status}: ${errorText}`,
        };
      }

      const submitResult = await response.json();
      if (!submitResult.accepted) {
        if (submitResult.error === 'agent-runtime-wrong-shard' && submitResult.target_pod) {
          const redirectedUrl = resolveAgentRuntimeUrl(submitResult.target_pod as string);
          if (!redirectedUrl) {
            return {
              attemptId: invocation.attemptId,
              success: false,
              exitCode: 1,
              error: `Agent runtime target ${submitResult.target_pod} not configured`,
            };
          }

          const retry = await fetch(`${redirectedUrl}/invoke`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...getCorrelationHeaders(),
            },
            body: JSON.stringify(invocation),
          });

          if (!retry.ok) {
            const errorText = await retry.text().catch(() => 'Unknown error');
            return {
              attemptId: invocation.attemptId,
              success: false,
              exitCode: 1,
              error: `Agent runtime retry returned ${retry.status}: ${errorText}`,
            };
          }

          const retryResult = await retry.json();
          if (!retryResult.accepted) {
            return {
              attemptId: invocation.attemptId,
              success: false,
              exitCode: 1,
              error: `Agent runtime rejected job after redirect: ${retryResult.error || 'unknown'}`,
            };
          }
        } else {
          return {
            attemptId: invocation.attemptId,
            success: false,
            exitCode: 1,
            error: `Agent runtime rejected job: ${submitResult.error || 'unknown'}`,
          };
        }
      }

      const pollInterval = resolvePollIntervalMs(process.env.EVE_AGENT_RUNTIME_POLL_INTERVAL_MS, 250);
      return await pollForCompletion(
        invocation.projectId,
        invocation.attemptId,
        invocation.jobId,
        pollInterval,
        effectiveTimeout,
      );
    });
  } catch (error) {
    const errorMessage = `Failed to invoke agent runtime: ${error instanceof Error ? error.message : String(error)}`;
    return {
      attemptId: invocation.attemptId,
      success: false,
      exitCode: 1,
      error: errorMessage,
    };
  }
}

export async function invokePipelineRun(
  runId: string,
  workerImage?: string,
  timeoutMs?: number,
): Promise<{ success: boolean; error?: string }> {
  const workerUrl = resolveWorkerUrl(workerImage);
  const effectiveTimeout =
    timeoutMs ?? parseInt(process.env.WORKER_TIMEOUT_MS || '1800000', 10);
  const existing = getCorrelationContext();
  const correlationId = ensureCorrelationId(existing?.correlationId);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeout);

  try {
    return await withCorrelationContext({ correlationId, traceId: correlationId }, async () => {
      const response = await fetch(`${workerUrl}/pipeline-runs/${runId}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCorrelationHeaders(),
        },
        body: JSON.stringify({}),
        signal: abortController.signal,
      });

    clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          error: `Worker returned ${response.status}: ${errorText}`,
        };
      }

      return response.json();
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    const errorMessage = isTimeout
      ? `Worker request timed out after ${effectiveTimeout}ms`
      : `Failed to invoke worker: ${error instanceof Error ? error.message : String(error)}`;

    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function invokeActionJob(
  jobId: string,
  attemptId: AttemptId,
  projectId: string,
  workerImage?: string,
  timeoutMs?: number,
): Promise<HarnessResult> {
  return invokeSubmitAndPollWorkerJob('actions/execute', jobId, attemptId, projectId, workerImage, timeoutMs);
}

export async function invokeScriptJob(
  jobId: string,
  attemptId: AttemptId,
  projectId: string,
  workerImage?: string,
  timeoutMs?: number,
): Promise<HarnessResult> {
  return invokeSubmitAndPollWorkerJob('scripts/execute', jobId, attemptId, projectId, workerImage, timeoutMs);
}

async function invokeSubmitAndPollWorkerJob(
  path: string,
  jobId: string,
  attemptId: AttemptId,
  projectId: string,
  workerImage?: string,
  timeoutMs?: number,
): Promise<HarnessResult> {
  const workerUrl = resolveWorkerUrl(workerImage);
  const effectiveTimeout =
    timeoutMs ?? parseInt(process.env.WORKER_TIMEOUT_MS || '1800000', 10);
  const submitTimeoutMs = resolvePollIntervalMs(process.env.EVE_WORKER_SUBMIT_TIMEOUT_MS, 30000);
  const existing = getCorrelationContext();
  const correlationId = ensureCorrelationId(existing?.correlationId);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), submitTimeoutMs);

  try {
    return await withCorrelationContext({ correlationId, traceId: correlationId }, async () => {
      let response: Response;
      try {
        response = await fetch(`${workerUrl}/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getCorrelationHeaders(),
          },
          body: JSON.stringify({ jobId, attemptId, projectId }),
          signal: abortController.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          attemptId,
          success: false,
          exitCode: 1,
          error: `worker_submit_failed: Worker returned ${response.status}: ${errorText}`,
        };
      }

      const submitResult = await response.json();
      if (!submitResult.accepted) {
        return {
          attemptId,
          success: false,
          exitCode: 1,
          error: `worker_submit_failed: Worker rejected job: ${submitResult.error || 'unknown'}`,
        };
      }

      const pollInterval = resolvePollIntervalMs(process.env.EVE_WORKER_POLL_INTERVAL_MS, 5000);
      return pollForCompletion(
        projectId,
        attemptId,
        jobId,
        pollInterval,
        effectiveTimeout,
        'poll_timeout',
      );
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    const errorMessage = isTimeout
      ? `worker_submit_failed: Worker submit request timed out after ${submitTimeoutMs}ms`
      : `worker_submit_failed: Failed to invoke worker: ${error instanceof Error ? error.message : String(error)}`;

    return {
      attemptId,
      success: false,
      exitCode: 1,
      error: errorMessage,
    };
  }
}

function resolveWorkerUrl(workerImage?: string): string {
  const mapping = parseWorkerUrlMapping(process.env.EVE_WORKER_URLS ?? '');
  const fallbackUrl = process.env.WORKER_URL || 'http://localhost:4749';

  if (!workerImage) {
    return mapping.get('default-worker') ?? fallbackUrl;
  }

  const match = mapping.get(workerImage);
  if (!match) {
    throw new Error(
      `Worker image "${workerImage}" is not mapped in EVE_WORKER_URLS and no fallback applies`,
    );
  }

  return match;
}

function resolveAgentRuntimeUrl(targetPod?: string): string | null {
  const mapping = parseWorkerUrlMapping(process.env.EVE_AGENT_RUNTIME_URLS ?? '');
  if (targetPod) {
    return mapping.get(targetPod) ?? null;
  }
  return process.env.EVE_AGENT_RUNTIME_URL ?? null;
}

import { Injectable, Inject, NotFoundException, MessageEvent } from '@nestjs/common';
import { Observable, interval, from } from 'rxjs';
import { switchMap, concatMap, takeWhile, share } from 'rxjs/operators';
import type { Db } from '@eve/db';
import { jobQueries, executionLogQueries } from '@eve/db';
import { renderLogText } from '@eve/shared';

/**
 * SSE log-streaming for job attempts.
 *
 * Extracted verbatim from JobsService (R-C5). JobsService delegates here so
 * the controller-facing surface is unchanged.
 */
@Injectable()
export class JobLogsService {
  private jobs: ReturnType<typeof jobQueries>;
  private logs: ReturnType<typeof executionLogQueries>;

  constructor(@Inject('DB') db: Db) {
    this.jobs = jobQueries(db);
    this.logs = executionLogQueries(db);
  }

  /**
   * Stream execution logs for a specific attempt (SSE)
   *
   * Polls for new logs every second and emits them as SSE events.
   * Emits 'complete' or 'error' event when the attempt finishes.
   */
  streamAttemptLogs(jobId: string, attemptNum: number): Observable<MessageEvent> {
    let lastSequence = 0;
    let isComplete = false;

    return interval(1000).pipe(
      // Fetch new logs and attempt status
      switchMap(() =>
        from(
          (async () => {
            // Find the attempt by number
            const attempts = await this.jobs.listAttempts(jobId);
            const attempt = attempts.find(a => a.attempt_number === attemptNum);
            if (!attempt) {
              throw new NotFoundException(`Attempt ${attemptNum} not found for job ${jobId}`);
            }

            // Get logs since lastSequence
            const executionLogs = await this.logs.listLogs(attempt.id, lastSequence);

            return { logs: executionLogs, attempt };
          })()
        )
      ),
      // Emit log events and check completion
      concatMap(({ logs, attempt }) => {
        const events: MessageEvent[] = [];

        // Emit each new log as a 'log' event
        for (const log of logs) {
          const content = log.content as Record<string, unknown>;
          const logType = log.type;
          lastSequence = log.seq;

          events.push({
            type: 'log',
            data: {
              sequence: log.seq,
              timestamp: (content.timestamp as string) || log.created_at.toISOString(),
              type: logType,
              line: content,
              text: renderLogText({ type: logType, line: content }),
            },
          });
        }

        // Check if attempt has finished
        if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'cancelled') {
          isComplete = true;

          if (attempt.status === 'succeeded') {
            events.push({
              type: 'complete',
              data: {
                status: 'succeeded',
                exitCode: attempt.exit_code ?? 0,
                resultText: attempt.result_text ?? null,
              },
            });
          } else {
            events.push({
              type: 'error',
              data: {
                status: attempt.status,
                exitCode: attempt.exit_code ?? 1,
                errorMessage: attempt.error_message ?? null,
              },
            });
          }
        }

        return from(events);
      }),
      // Keep the stream alive until complete
      takeWhile(() => !isComplete, true),
      share()
    );
  }

  /**
   * Stream execution logs for the current/latest attempt of a job (SSE)
   *
   * Convenience endpoint that finds the latest attempt and streams its logs.
   */
  streamJobLogs(jobId: string): Observable<MessageEvent> {
    // We need to find the current attempt number first
    // Then delegate to streamAttemptLogs
    let attemptNumResolved = false;
    let resolvedAttemptNum = 0;
    let lastSequence = 0;
    let isComplete = false;

    return interval(1000).pipe(
      // Fetch new logs and attempt status
      switchMap(() =>
        from(
          (async () => {
            // Get attempts to find the current one
            const attempts = await this.jobs.listAttempts(jobId);
            if (attempts.length === 0) {
              throw new NotFoundException(`No attempts found for job ${jobId}`);
            }

            // Use the latest attempt (first in list, sorted by attempt_number desc)
            const attempt = attempts[0];
            resolvedAttemptNum = attempt.attempt_number;
            attemptNumResolved = true;

            // Get logs since lastSequence
            const executionLogs = await this.logs.listLogs(attempt.id, lastSequence);

            return { logs: executionLogs, attempt };
          })()
        )
      ),
      // Emit log events and check completion
      concatMap(({ logs, attempt }) => {
        const events: MessageEvent[] = [];

        // Emit each new log as a 'log' event
        for (const log of logs) {
          const content = log.content as Record<string, unknown>;
          const logType = log.type;
          lastSequence = log.seq;

          events.push({
            type: 'log',
            data: {
              sequence: log.seq,
              timestamp: (content.timestamp as string) || log.created_at.toISOString(),
              type: logType,
              line: content,
              text: renderLogText({ type: logType, line: content }),
            },
          });
        }

        // Check if attempt has finished
        if (attempt.status === 'succeeded' || attempt.status === 'failed' || attempt.status === 'cancelled') {
          isComplete = true;

          if (attempt.status === 'succeeded') {
            events.push({
              type: 'complete',
              data: {
                status: 'succeeded',
                exitCode: attempt.exit_code ?? 0,
                resultText: attempt.result_text ?? null,
              },
            });
          } else {
            events.push({
              type: 'error',
              data: {
                status: attempt.status,
                exitCode: attempt.exit_code ?? 1,
                errorMessage: attempt.error_message ?? null,
              },
            });
          }
        }

        return from(events);
      }),
      // Keep the stream alive until complete
      takeWhile(() => !isComplete, true),
      share()
    );
  }
}

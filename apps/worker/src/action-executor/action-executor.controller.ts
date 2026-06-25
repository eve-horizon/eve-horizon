import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { emitRunnerEvent, withCorrelationContext } from '@eve/shared';
import type { AttemptId, HarnessResult } from '@eve/shared';
import { ActionExecutorService } from './action-executor.service';

@Controller()
export class ActionExecutorController {
  constructor(private readonly actionExecutor: ActionExecutorService) {}

  @Post('actions/execute')
  @HttpCode(202)
  async execute(
    @Body() body: { jobId?: string; attemptId?: string; projectId?: string },
  ): Promise<{ accepted: boolean; attemptId?: string; error?: string }> {
    const jobId = body.jobId ?? '';
    const attemptId = body.attemptId ?? '';
    const projectId = body.projectId ?? '';

    if (!jobId || !attemptId || !projectId) {
      return { accepted: false, error: 'Missing required fields: attemptId, jobId, or projectId' };
    }

    this.executeInBackground({ jobId, attemptId, projectId });
    return { accepted: true, attemptId };
  }

  private executeInBackground(invocation: { jobId: string; attemptId: string; projectId: string }): void {
    withCorrelationContext(
      { jobId: invocation.jobId, attemptId: invocation.attemptId },
      async () => {
        const startTime = Date.now();

        await emitRunnerEvent(invocation.projectId, 'runner.started', {
          attemptId: invocation.attemptId,
          jobId: invocation.jobId,
        });

        try {
          const result = await this.actionExecutor.execute(invocation.jobId, invocation.attemptId);
          await emitRunnerEvent(invocation.projectId, 'runner.completed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            result: this.toHarnessResult(invocation.attemptId, result, Date.now() - startTime),
          });
        } catch (err) {
          await emitRunnerEvent(invocation.projectId, 'runner.failed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            error: err instanceof Error ? err.message : String(err),
            exitCode: 1,
          });
        }
      },
    ).catch((err) => {
      console.error('[ActionExecutorController] Background execution failed:', err);
    });
  }

  private toHarnessResult(
    attemptId: string,
    result: Awaited<ReturnType<ActionExecutorService['execute']>>,
    durationMs: number,
  ): HarnessResult {
    return {
      attemptId: attemptId as AttemptId,
      success: result.success,
      exitCode: result.success ? 0 : 1,
      error: result.error,
      resultText: result.resultText,
      resultJson: result.output ?? undefined,
      durationMs,
      tokenInput: 0,
      tokenOutput: 0,
    };
  }
}

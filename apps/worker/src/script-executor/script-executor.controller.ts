import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { emitRunnerEvent, withCorrelationContext } from '@eve/shared';
import type { AttemptId, HarnessResult } from '@eve/shared';
import { ScriptExecutorService } from './script-executor.service';

@Controller()
export class ScriptExecutorController {
  constructor(private readonly scriptExecutor: ScriptExecutorService) {}

  @Post('scripts/execute')
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
        await emitRunnerEvent(invocation.projectId, 'runner.started', {
          attemptId: invocation.attemptId,
          jobId: invocation.jobId,
        });

        try {
          const result = await this.scriptExecutor.execute(invocation.jobId, invocation.attemptId);
          await emitRunnerEvent(invocation.projectId, 'runner.completed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            result: this.toHarnessResult(invocation.attemptId, result),
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
      console.error('[ScriptExecutorController] Background execution failed:', err);
    });
  }

  private toHarnessResult(
    attemptId: string,
    result: Awaited<ReturnType<ScriptExecutorService['execute']>>,
  ): HarnessResult {
    return {
      attemptId: attemptId as AttemptId,
      success: result.success,
      exitCode: result.exitCode,
      error: result.error,
      resultText: result.stdout?.trim() || (result.success ? 'Script completed' : undefined),
      resultJson: {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.exitCode,
      },
      durationMs: result.durationMs,
      tokenInput: 0,
      tokenOutput: 0,
    };
  }
}

import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { withCorrelationContext, type HarnessInvocation, emitRunnerEvent } from '@eve/shared';
import { InvokeService } from './invoke.service';

@Controller()
export class InvokeController {
  constructor(private readonly invokeService: InvokeService) {}

  private shouldSelfTerminateRunner(): boolean {
    const value = process.env.EVE_RUNNER_SELF_TERMINATE;
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }

  @Post('invoke')
  @HttpCode(202)
  async invoke(@Body() invocation: any): Promise<{ accepted: boolean; attemptId?: string; error?: string }> {
    // Validate invocation has required fields
    if (!invocation?.attemptId || !invocation?.jobId || !invocation?.projectId) {
      return { accepted: false, error: 'Missing required fields: attemptId, jobId, or projectId' };
    }

    // Start background execution (don't await)
    this.executeInBackground(invocation);

    return { accepted: true, attemptId: invocation.attemptId };
  }

  private executeInBackground(invocation: HarnessInvocation): void {
    // Wrap in correlation context
    withCorrelationContext(
      { jobId: invocation.jobId, attemptId: invocation.attemptId },
      async () => {
        const projectId = invocation.projectId;

        // Emit started event
        await emitRunnerEvent(projectId, 'runner.started', {
          attemptId: invocation.attemptId,
          jobId: invocation.jobId,
        });

        try {
          const result = await this.invokeService.execute(invocation);

          // Emit completed event
          await emitRunnerEvent(projectId, 'runner.completed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            result,
          });
        } catch (err) {
          // Emit failed event
          await emitRunnerEvent(projectId, 'runner.failed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // Ephemeral runner pods should exit after one invocation so the pod
          // transitions to Succeeded. Shared worker deployments must stay alive.
          if (this.shouldSelfTerminateRunner()) {
            console.log('[Runner] Job finished, shutting down in 2s');
            setTimeout(() => process.exit(0), 2000);
          }
        }
      }
    ).catch(err => {
      console.error('[InvokeController] Background execution failed:', err);
    });
  }
}

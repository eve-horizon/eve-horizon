import { Controller, Post, Body, HttpCode, Inject } from '@nestjs/common';
import { withCorrelationContext, type HarnessInvocation, emitRunnerEvent } from '@eve/shared';
import type { Db } from '@eve/db';
import { projectQueries } from '@eve/db';
import { InvokeService } from '../invoke/invoke.service.js';
import { RuntimeService } from './runtime.service';

@Controller()
export class RuntimeController {
  private readonly projects: ReturnType<typeof projectQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly runtimeService: RuntimeService,
    private readonly invokeService: InvokeService,
  ) {
    this.projects = projectQueries(db);
  }

  @Post('invoke')
  @HttpCode(202)
  async invoke(@Body() invocation: HarnessInvocation): Promise<{ accepted: boolean; attemptId?: string; error?: string; target_pod?: string }> {
    if (!invocation?.attemptId || !invocation?.jobId || !invocation?.projectId) {
      return { accepted: false, error: 'Missing required fields: attemptId, jobId, or projectId' };
    }

    const project = await this.projects.findById(invocation.projectId);
    if (!project) {
      return { accepted: false, attemptId: invocation.attemptId, error: `Project ${invocation.projectId} not found` };
    }

    this.runtimeService.registerOrg(project.org_id);
    const placement = await this.runtimeService.resolvePlacement(invocation.agentId ?? null, project.org_id);
    if (!placement.accepted) {
      return {
        accepted: false,
        attemptId: invocation.attemptId,
        error: placement.reason ?? 'agent-runtime-wrong-shard',
        target_pod: placement.targetPod,
      };
    }

    this.executeInBackground(invocation);
    return { accepted: true, attemptId: invocation.attemptId };
  }

  private executeInBackground(invocation: HarnessInvocation): void {
    withCorrelationContext(
      { jobId: invocation.jobId, attemptId: invocation.attemptId },
      async () => {
        const projectId = invocation.projectId;

        await emitRunnerEvent(projectId, 'runner.started', {
          attemptId: invocation.attemptId,
          jobId: invocation.jobId,
        });

        try {
          const result = await this.invokeService.execute(invocation);
          await emitRunnerEvent(projectId, 'runner.completed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            result,
          });
        } catch (err) {
          await emitRunnerEvent(projectId, 'runner.failed', {
            attemptId: invocation.attemptId,
            jobId: invocation.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    ).catch(err => {
      console.error('[AgentRuntime] Background execution failed:', err);
    });
  }
}

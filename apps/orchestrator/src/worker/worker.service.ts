import { Injectable } from '@nestjs/common';
import {
  invokeActionJob,
  invokePipelineRun,
  invokeScriptJob,
  invokeWorker,
  invokeAgentRuntime,
} from './worker.client';
import type { AttemptId, HarnessInvocation, HarnessResult } from '@eve/shared';

export interface ExecuteOptions {
  workerImage?: string;
  timeoutMs?: number;
}

/**
 * Worker service that handles job execution.
 *
 * Phase 4: Invokes the worker service via HTTP.
 */
@Injectable()
export class WorkerService {
  async execute(invocation: HarnessInvocation, options?: ExecuteOptions): Promise<HarnessResult> {
    return invokeWorker(invocation, options?.workerImage, options?.timeoutMs);
  }

  async executeAgentRuntime(invocation: HarnessInvocation, options?: ExecuteOptions): Promise<HarnessResult> {
    return invokeAgentRuntime(invocation, options?.timeoutMs);
  }

  async executeAction(jobId: string, attemptId: AttemptId, projectId: string, options?: ExecuteOptions): Promise<HarnessResult> {
    return invokeActionJob(jobId, attemptId, projectId, options?.workerImage, options?.timeoutMs);
  }

  async executeScript(jobId: string, attemptId: AttemptId, projectId: string, options?: ExecuteOptions): Promise<HarnessResult> {
    return invokeScriptJob(jobId, attemptId, projectId, options?.workerImage, options?.timeoutMs);
  }

  async executePipelineRun(runId: string, options?: ExecuteOptions): Promise<{ success: boolean; error?: string }> {
    return invokePipelineRun(runId, options?.workerImage, options?.timeoutMs);
  }
}

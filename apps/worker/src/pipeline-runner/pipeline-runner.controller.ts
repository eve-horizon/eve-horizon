import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { withCorrelationContext } from '@eve/shared';
import { PipelineRunnerService } from './pipeline-runner.service';

@Controller()
export class PipelineRunnerController {
  constructor(private readonly pipelineRunnerService: PipelineRunnerService) {}

  @Post('pipeline-runs/:runId/execute')
  @HttpCode(HttpStatus.OK)
  async execute(@Param('runId') runId: string): Promise<{ success: boolean; error?: string }> {
    return withCorrelationContext(
      { eventId: runId },
      () => this.pipelineRunnerService.executeRun(runId),
    );
  }
}

import { Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller.js';
import { PipelineRunsController } from './pipeline-runs.controller.js';
import { PipelineRunsInternalController } from './pipeline-runs.internal.controller.js';
import { PipelineExpanderController } from './pipeline-expander.controller.js';
import { PipelineExpanderInternalController } from './pipeline-expander.internal.controller.js';
import { PipelineRunsService } from './pipeline-runs.service.js';
import { PipelinesService } from './pipelines.service.js';
import { PipelineExpanderService } from './pipeline-expander.service.js';

@Module({
  controllers: [
    PipelinesController,
    PipelineRunsController,
    PipelineRunsInternalController,
    PipelineExpanderController,
    PipelineExpanderInternalController,
  ],
  providers: [PipelinesService, PipelineRunsService, PipelineExpanderService],
  exports: [PipelineRunsService],
})
export class PipelinesModule {}

import { Module } from '@nestjs/common';
import { DeployerModule } from '../deployer/deployer.module';
import { BuilderModule } from '../builder/builder.module.js';
import { PipelineRunnerController } from './pipeline-runner.controller';
import { PipelineRunnerService } from './pipeline-runner.service';

@Module({
  imports: [DeployerModule, BuilderModule],
  controllers: [PipelineRunnerController],
  providers: [PipelineRunnerService],
})
export class PipelineRunnerModule {}

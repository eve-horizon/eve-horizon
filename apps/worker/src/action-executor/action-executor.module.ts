import { Module } from '@nestjs/common';
import { DeployerModule } from '../deployer/deployer.module';
import { BuilderModule } from '../builder/builder.module.js';
import { ActionExecutorController } from './action-executor.controller';
import { ActionExecutorService } from './action-executor.service';

@Module({
  imports: [DeployerModule, BuilderModule],
  controllers: [ActionExecutorController],
  providers: [ActionExecutorService],
  exports: [ActionExecutorService],
})
export class ActionExecutorModule {}

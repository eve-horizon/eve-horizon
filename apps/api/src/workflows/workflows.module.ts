import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsInternalController } from './workflows.internal.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [WorkflowsController, WorkflowsInternalController],
  providers: [WorkflowsService],
})
export class WorkflowsModule {}

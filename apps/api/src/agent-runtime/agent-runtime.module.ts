import { Module } from '@nestjs/common';
import { AgentRuntimeController } from './agent-runtime.controller.js';
import { AgentRuntimeInternalController } from './agent-runtime.internal.controller.js';
import { AgentRuntimeService } from './agent-runtime.service.js';

@Module({
  controllers: [AgentRuntimeController, AgentRuntimeInternalController],
  providers: [AgentRuntimeService],
  exports: [AgentRuntimeService],
})
export class AgentRuntimeModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OrgDocumentsModule } from '../org-documents/org-documents.module.js';
import { AgentMemoryController } from './agent-memory.controller.js';
import { AgentMemoryService } from './agent-memory.service.js';

@Module({
  imports: [AuthModule, OrgDocumentsModule],
  controllers: [AgentMemoryController],
  providers: [AgentMemoryService],
  exports: [AgentMemoryService],
})
export class AgentMemoryModule {}

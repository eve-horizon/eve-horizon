import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WorkerModule } from '../worker/worker.module';
import { LoopService } from './loop.service';

/**
 * Loop module for Phase 3.
 *
 * Provides the orchestrator polling loop that claims jobs,
 * creates workspaces, manages attempts, and invokes workers.
 */
@Module({
  imports: [DatabaseModule, WorkerModule],
  providers: [LoopService],
  exports: [LoopService],
})
export class LoopModule {}

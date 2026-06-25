import { Module } from '@nestjs/common';
import { WorkerService } from './worker.service';

/**
 * Worker module for Phase 4.
 *
 * Provides the WORKER token backed by the HTTP worker client. The stub
 * remains available for isolated tests but is not wired here.
 */
@Module({
  providers: [
    {
      provide: 'WORKER',
      useClass: WorkerService,
    },
    WorkerService,
  ],
  exports: ['WORKER', WorkerService],
})
export class WorkerModule {}

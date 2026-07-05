import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobLogsService } from './job-logs.service.js';
import { JobReceiptsService } from './job-receipts.service.js';
import { JobBatchService } from './job-batch.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [JobsService, JobLogsService, JobReceiptsService, JobBatchService],
  exports: [JobsService],
})
export class JobsModule {}

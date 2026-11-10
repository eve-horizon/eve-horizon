import { Module } from '@nestjs/common';
import { JobAttachmentsController } from './job-attachments.controller.js';
import { JobAttachmentsService } from './job-attachments.service.js';
import { JobsModule } from '../jobs/jobs.module.js';

@Module({
  imports: [JobsModule],
  controllers: [JobAttachmentsController],
  providers: [JobAttachmentsService],
  exports: [JobAttachmentsService],
})
export class JobAttachmentsModule {}

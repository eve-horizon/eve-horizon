import { Module } from '@nestjs/common';
import { JobAttachmentsController } from './job-attachments.controller.js';
import { JobAttachmentsService } from './job-attachments.service.js';

@Module({
  controllers: [JobAttachmentsController],
  providers: [JobAttachmentsService],
  exports: [JobAttachmentsService],
})
export class JobAttachmentsModule {}

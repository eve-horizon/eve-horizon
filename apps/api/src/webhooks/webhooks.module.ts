import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { SesFeedbackController } from './ses-feedback.controller.js';
import { SesFeedbackService } from './ses-feedback.service.js';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController, SesFeedbackController],
  providers: [WebhooksService, SesFeedbackService],
  exports: [WebhooksService, SesFeedbackService],
})
export class WebhooksModule {}

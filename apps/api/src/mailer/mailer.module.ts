import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { EmailDeliveryAdminController } from './email-delivery-admin.controller.js';

@Module({
  controllers: [EmailDeliveryAdminController],
  providers: [MailerService, EmailDeliveryService],
  exports: [MailerService, EmailDeliveryService],
})
export class MailerModule {}

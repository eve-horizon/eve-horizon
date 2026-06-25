import { Module } from '@nestjs/common';
import { PlatformNotifyController } from './platform-notify.controller.js';
import { PlatformNotifyService } from './platform-notify.service.js';
import { PlatformResponderService } from './platform-responder.service.js';

@Module({
  providers: [PlatformNotifyService, PlatformResponderService],
  controllers: [PlatformNotifyController],
  exports: [PlatformNotifyService, PlatformResponderService],
})
export class PlatformNotifyModule {}

import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { ChatInternalController } from './chat.internal.controller.js';
import { ChatGatewayController } from './chat.gateway.controller.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [JobsModule, AuthModule],
  providers: [ChatService],
  controllers: [ChatController, ChatInternalController, ChatGatewayController],
  exports: [ChatService],
})
export class ChatModule {}

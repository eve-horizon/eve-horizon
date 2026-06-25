import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ThreadsService } from './threads.service.js';
import { ConversationEventsService } from './conversation-events.service.js';
import { ThreadsController } from './threads.controller.js';
import { OrgThreadsController } from './org-threads.controller.js';

@Module({
  imports: [AuthModule, ChatModule],
  providers: [ThreadsService, ConversationEventsService],
  controllers: [ThreadsController, OrgThreadsController],
  exports: [ThreadsService, ConversationEventsService],
})
export class ThreadsModule {}

import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsInternalController } from './events.internal.controller.js';
import { EventsService } from './events.service.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [DatabaseModule],
  controllers: [EventsController, EventsInternalController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}

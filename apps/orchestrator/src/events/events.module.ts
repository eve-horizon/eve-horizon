import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { EventRouterService } from './event-router.service';
import { TriggerMatcherService } from './trigger-matcher.service';

/**
 * Events module for Phase 5.
 *
 * Provides the event router polling loop that claims pending events
 * and routes them to appropriate handlers.
 */
@Module({
  imports: [DatabaseModule],
  providers: [EventRouterService, TriggerMatcherService],
  exports: [EventRouterService],
})
export class EventsModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LoopModule } from './loop/loop.module';
import { EventsModule } from './events/events.module';
import { CronModule } from './cron/cron.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [DatabaseModule, HealthModule, LoopModule, EventsModule, CronModule, SystemModule],
})
export class AppModule {}

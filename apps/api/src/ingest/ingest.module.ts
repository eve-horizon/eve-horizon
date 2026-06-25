import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';

@Module({
  imports: [AuthModule, StorageModule, EventsModule],
  controllers: [IngestController],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}

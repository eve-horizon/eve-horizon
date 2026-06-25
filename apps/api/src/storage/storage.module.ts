import { Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { StorageInternalController } from './storage.internal.controller.js';

@Module({
  controllers: [StorageInternalController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

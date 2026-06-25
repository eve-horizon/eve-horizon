import { Module } from '@nestjs/common';
import { OrgFsSyncController, OrgFsSyncInternalController, OrgFsPublicController } from './org-fs-sync.controller.js';
import { OrgFsSyncService } from './org-fs-sync.service.js';
import { OrgFsIndexProcessor } from './org-fs-index.processor.js';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [OrgFsSyncController, OrgFsSyncInternalController, OrgFsPublicController],
  providers: [OrgFsSyncService, OrgFsIndexProcessor],
  exports: [OrgFsSyncService, StorageModule],
})
export class OrgFsSyncModule {}

import { Module } from '@nestjs/common';
import { SecretsService } from './secrets.service.js';
import { ProjectSecretsController, OrgSecretsController, UserSecretsController, SystemSecretsController } from './secrets.controller.js';
import { SecretsInternalController, SecretsWriteBackController } from './secrets.internal.controller.js';

@Module({
  controllers: [ProjectSecretsController, OrgSecretsController, UserSecretsController, SystemSecretsController, SecretsInternalController, SecretsWriteBackController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}

import { Module } from '@nestjs/common';
import { HarnessesController } from './harnesses.controller.js';
import { HarnessesService } from './harnesses.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [SecretsModule, AuthModule],
  controllers: [HarnessesController],
  providers: [HarnessesService],
  exports: [HarnessesService],
})
export class HarnessesModule {}

import { Module } from '@nestjs/common';
import { AttemptsController } from './attempts.controller.js';
import { AttemptsInternalController } from './attempts.internal.controller.js';
import { AttemptsService } from './attempts.service.js';

@Module({
  controllers: [AttemptsController, AttemptsInternalController],
  providers: [AttemptsService],
  exports: [AttemptsService],
})
export class AttemptsModule {}

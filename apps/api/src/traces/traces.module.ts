import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TracesController } from './traces.controller.js';
import { TracesService } from './traces.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TracesController],
  providers: [TracesService],
  exports: [TracesService],
})
export class TracesModule {}

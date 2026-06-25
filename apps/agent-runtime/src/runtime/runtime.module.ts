import { Module } from '@nestjs/common';
import { RuntimeController } from './runtime.controller';
import { RuntimeService } from './runtime.service';
import { InvokeService } from '../invoke/invoke.service.js';

@Module({
  controllers: [RuntimeController],
  providers: [RuntimeService, InvokeService],
})
export class RuntimeModule {}

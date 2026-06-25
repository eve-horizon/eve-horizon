import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { LoopModule } from '../loop/loop.module';

@Module({
  imports: [LoopModule],
  controllers: [SystemController],
})
export class SystemModule {}

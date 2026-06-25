import { Module } from '@nestjs/common';
import { InvokeController } from './invoke.controller';
import { InvokeService } from './invoke.service';

@Module({
  controllers: [InvokeController],
  providers: [InvokeService],
})
export class InvokeModule {}

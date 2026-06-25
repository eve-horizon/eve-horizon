import { Module } from '@nestjs/common';
import { ScriptExecutorController } from './script-executor.controller';
import { ScriptExecutorService } from './script-executor.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [ScriptExecutorController],
  providers: [ScriptExecutorService],
  exports: [ScriptExecutorService],
})
export class ScriptExecutorModule {}

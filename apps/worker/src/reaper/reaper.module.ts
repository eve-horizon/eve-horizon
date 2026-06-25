import { Module } from '@nestjs/common';
import { RunnerReaperService } from './runner-reaper.service';

@Module({
  providers: [RunnerReaperService],
})
export class ReaperModule {}

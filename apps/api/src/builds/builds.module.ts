import { Module } from '@nestjs/common';
import { BuildsController } from './builds.controller.js';
import { BuildsService } from './builds.service.js';

@Module({
  controllers: [BuildsController],
  providers: [BuildsService],
})
export class BuildsModule {}

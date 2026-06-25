import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [ResourcesController],
  providers: [ResourcesService],
})
export class ResourcesModule {}

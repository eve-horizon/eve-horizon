import { Module } from '@nestjs/common';
import { PrivateEndpointsController } from './private-endpoints.controller.js';
import { PrivateEndpointsService } from './private-endpoints.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [PrivateEndpointsController],
  providers: [PrivateEndpointsService],
  exports: [PrivateEndpointsService],
})
export class PrivateEndpointsModule {}

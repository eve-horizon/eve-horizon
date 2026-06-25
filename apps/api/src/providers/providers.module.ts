import { Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller.js';
import { ProviderDiscoveryService } from './provider-discovery.service.js';

@Module({
  controllers: [ProvidersController],
  providers: [ProviderDiscoveryService],
  exports: [ProviderDiscoveryService],
})
export class ProvidersModule {}

import { Module } from '@nestjs/common';
import { RegistryTokenController } from './registry-token.controller.js';

@Module({
  controllers: [RegistryTokenController],
})
export class RegistryModule {}

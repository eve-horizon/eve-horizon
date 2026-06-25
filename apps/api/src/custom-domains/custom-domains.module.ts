import { Module } from '@nestjs/common';
import { CustomDomainsController } from './custom-domains.controller.js';
import { CustomDomainsService } from './custom-domains.service.js';

@Module({
  controllers: [CustomDomainsController],
  providers: [CustomDomainsService],
})
export class CustomDomainsModule {}

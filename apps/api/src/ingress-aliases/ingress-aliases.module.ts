import { Module } from '@nestjs/common';
import { IngressAliasesAdminController } from './ingress-aliases-admin.controller.js';
import { IngressAliasesAdminService } from './ingress-aliases-admin.service.js';

@Module({
  controllers: [IngressAliasesAdminController],
  providers: [IngressAliasesAdminService],
})
export class IngressAliasesModule {}

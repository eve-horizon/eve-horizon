import { Module } from '@nestjs/common';
import { ReceiptsAdminController } from './receipts-admin.controller.js';
import { ReceiptsAdminService } from './receipts-admin.service.js';
import { BalanceController } from './balance.controller.js';
import { BalanceService } from './balance.service.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';
import { CostController } from './cost.controller.js';
import { CostService } from './cost.service.js';
import { AppCostService } from './app-cost.service.js';
import { OrgCostController } from './org-cost.controller.js';

@Module({
  controllers: [ReceiptsAdminController, BalanceController, UsageController, CostController, OrgCostController],
  providers: [ReceiptsAdminService, BalanceService, UsageService, CostService, AppCostService],
})
export class BillingModule {}

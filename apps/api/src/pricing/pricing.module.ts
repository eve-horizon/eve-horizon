import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { RateCardRefreshService } from './rate-card-refresh.service.js';

@Module({
  controllers: [PricingController],
  providers: [PricingService, RateCardRefreshService],
})
export class PricingModule {}


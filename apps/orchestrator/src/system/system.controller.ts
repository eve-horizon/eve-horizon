import { Controller, Get, Post, Body, UseGuards, HttpCode, BadRequestException } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { LoopService } from '../loop/loop.service';

@Controller('system/orchestrator')
@UseGuards(InternalApiKeyGuard)
export class SystemController {
  constructor(private readonly loopService: LoopService) {}

  @Get('status')
  getStatus() {
    return {
      ...this.loopService.getConcurrencyStatus(),
      tuner: this.loopService.getTunerStatus(),
    };
  }

  @Post('concurrency')
  @HttpCode(200)
  setConcurrency(@Body() body: { limit: number }) {
    if (!body.limit || typeof body.limit !== 'number' || body.limit < 1) {
      throw new BadRequestException('Limit must be a number >= 1');
    }

    this.loopService.setConcurrency(body.limit);
    return this.loopService.getConcurrencyStatus();
  }
}

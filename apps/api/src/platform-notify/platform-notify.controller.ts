import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { PlatformNotifyService } from './platform-notify.service.js';
import type { PlatformAlert } from './platform-notify.service.js';
import { PlatformResponderService } from './platform-responder.service.js';

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class PlatformNotifyController {
  constructor(
    private readonly notifyService: PlatformNotifyService,
    private readonly responderService: PlatformResponderService,
  ) {}

  @Post('platform-notify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive structured platform alert (internal only)' })
  async notify(@Body() body: PlatformAlert) {
    return this.notifyService.notify(body);
  }

  @Post('platform-respond')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle inbound message from sentinel channel (internal only)' })
  async respond(@Body() body: { text: string; channel_id?: string; thread_ts?: string }) {
    const reply = await this.responderService.respond(body.text);
    return { text: reply };
  }

  @Get('sentinel-config')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return sentinel Slack channel config (internal only)' })
  async sentinelConfig() {
    return this.notifyService.getSentinelConfig();
  }
}

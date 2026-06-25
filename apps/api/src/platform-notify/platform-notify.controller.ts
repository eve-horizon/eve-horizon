import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { loadConfig } from '@eve/shared';
import { PlatformNotifyService } from './platform-notify.service.js';
import type { PlatformAlert } from './platform-notify.service.js';
import { PlatformResponderService } from './platform-responder.service.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

@ApiTags('internal')
@Controller('internal')
export class PlatformNotifyController {
  constructor(
    private readonly notifyService: PlatformNotifyService,
    private readonly responderService: PlatformResponderService,
  ) {}

  @Post('platform-notify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive structured platform alert (internal only)' })
  async notify(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: PlatformAlert,
  ) {
    this.requireInternalToken(token);
    return this.notifyService.notify(body);
  }

  @Post('platform-respond')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle inbound message from sentinel channel (internal only)' })
  async respond(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: { text: string; channel_id?: string; thread_ts?: string },
  ) {
    this.requireInternalToken(token);
    const reply = await this.responderService.respond(body.text);
    return { text: reply };
  }

  @Get('sentinel-config')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Return sentinel Slack channel config (internal only)' })
  async sentinelConfig(
    @Headers(INTERNAL_HEADER) token: string | undefined,
  ) {
    this.requireInternalToken(token);
    return this.notifyService.getSentinelConfig();
  }

  private requireInternalToken(token: string | undefined) {
    const config = loadConfig();
    if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
      throw new UnauthorizedException('Invalid internal token');
    }
  }
}

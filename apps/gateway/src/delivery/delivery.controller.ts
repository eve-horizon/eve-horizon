import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { GatewayProviderRegistry } from '../providers/provider-registry.js';
import { formatAgentReply } from '../providers/slack/slack-format.js';
import { createJsonLogger } from '@eve/shared';

const logger = createJsonLogger('gateway');
const INTERNAL_HEADER = 'x-eve-internal-token';

interface DeliveryRequest {
  provider: string;
  account_id: string;
  channel_id: string;
  thread_id?: string;
  text: string;
}

@Controller('internal')
export class DeliveryController {
  constructor(private readonly registry: GatewayProviderRegistry) {}

  @Post('deliver')
  @HttpCode(HttpStatus.OK)
  async handleDelivery(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body() body: DeliveryRequest,
  ) {
    if (!token || token !== (process.env.EVE_INTERNAL_API_KEY ?? '')) {
      throw new UnauthorizedException('Missing or invalid internal token');
    }

    if (!body.provider || !body.account_id || !body.channel_id || !body.text) {
      return { delivered: false, reason: 'missing_fields' };
    }

    const provider = this.registry.getInstance(body.provider, body.account_id);
    if (!provider) {
      logger.warn({
        event: 'delivery.provider_missing',
        provider: body.provider,
        accountId: body.account_id,
        msg: `No active provider instance for ${body.provider}:${body.account_id} — message already persisted, skipping push`,
      });
      return { delivered: false, reason: 'no_provider_instance' };
    }

    // Format with mrkdwn conversion + chunked Block Kit sections for Slack.
    // Non-Slack providers ignore blocks and use plain text.
    const formatted = formatAgentReply(body.text);

    await provider.sendMessage(
      {
        provider: body.provider,
        accountId: body.account_id,
        channel: body.channel_id,
        threadId: body.thread_id,
      },
      formatted,
    );

    return { delivered: true };
  }
}

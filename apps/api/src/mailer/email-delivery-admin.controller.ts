import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { EmailDeliveryService, type EmailDeliveryEventDto } from './email-delivery.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class EmailDeliveryAdminController {
  constructor(private readonly service: EmailDeliveryService) {}

  @Get('email-bounces')
  @ApiOperation({
    summary: 'List recent email delivery events (system-admin only).',
  })
  @ApiQuery({ name: 'recipient', required: false, type: String })
  @ApiQuery({ name: 'event_type', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listBounces(
    @CurrentUser() caller: AuthUser | undefined,
    @Query('recipient') recipient?: string,
    @Query('event_type') eventType?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ): Promise<{ events: EmailDeliveryEventDto[] }> {
    if (!caller?.is_admin) {
      throw new ForbiddenException('system admin required');
    }
    const events = await this.service.list({
      recipient: recipient?.toLowerCase(),
      eventTypes: eventType ? [eventType] : undefined,
      limit,
    });
    return { events };
  }
}

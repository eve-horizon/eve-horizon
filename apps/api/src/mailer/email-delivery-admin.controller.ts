import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { EmailDeliveryService, type EmailDeliveryEventDto } from './email-delivery.service.js';

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
    @Req() request: { user?: { user_id?: string; is_admin?: boolean } },
    @Query('recipient') recipient?: string,
    @Query('event_type') eventType?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ): Promise<{ events: EmailDeliveryEventDto[] }> {
    if (!request.user?.is_admin) {
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

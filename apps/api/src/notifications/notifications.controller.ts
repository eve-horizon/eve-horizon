import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  NotificationSendRequestSchema,
  NotificationSendResponseSchema,
  type NotificationSendRequest,
  type NotificationSendResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { NotificationsService } from './notifications.service.js';
import { CurrentUser } from '../common/request-decorators.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('projects/:project_id/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @RequirePermission('notifications:send')
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a project-scoped notification through an org integration' })
  @ApiBody({ schema: zodSchemaToOpenApi(NotificationSendRequestSchema, 'NotificationSendRequest') })
  @ApiOkResponse({
    description: 'Notification delivery result',
    schema: zodSchemaToOpenApi(NotificationSendResponseSchema, 'NotificationSendResponse'),
  })
  async send(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(NotificationSendRequestSchema)) body: NotificationSendRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<NotificationSendResponse> {
    const user = caller;
    return this.notificationsService.sendForProject(projectId, body, {
      callerProjectId: user?.is_job_token ? user.project_id : undefined,
    });
  }
}

import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { IngressAliasesAdminService } from './ingress-aliases-admin.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

const ReclaimIngressAliasRequestSchema = z.object({
  reason: z.string().min(1),
});

type ReclaimIngressAliasRequest = z.infer<typeof ReclaimIngressAliasRequestSchema>;

@ApiTags('ingress-aliases')
@ApiBearerAuth()
@Controller('admin/ingress-aliases')
export class IngressAliasesAdminController {
  constructor(private readonly ingressAliases: IngressAliasesAdminService) {}

  @RequirePermission('system:admin')
  @Get()
  @ApiOperation({ summary: 'List ingress alias claims (admin)' })
  async list(
    @Query('alias') alias: string | undefined,
    @Query('project_id') projectId: string | undefined,
    @Query('environment_id') environmentId: string | undefined,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    const normalizedEnvironmentId = environmentId === 'null' ? null : environmentId;
    return this.ingressAliases.list({
      alias,
      project_id: projectId,
      environment_id: normalizedEnvironmentId,
      limit,
      offset,
    });
  }

  @RequirePermission('system:admin')
  @Post(':alias/reclaim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force reclaim an ingress alias (admin)' })
  async reclaim(
    @Param('alias') alias: string,
    @Body(new ZodValidationPipe(ReclaimIngressAliasRequestSchema)) body: ReclaimIngressAliasRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ) {
    const callerId = (caller as { id?: unknown } | undefined)?.id;
    const actorUserId = callerId ? String(callerId) : null;
    return this.ingressAliases.reclaim(alias, body.reason, actorUserId);
  }
}

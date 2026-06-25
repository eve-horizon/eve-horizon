import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdminRecomputeReceiptsRequestSchema,
  AdminRecomputeReceiptsResponseSchema,
  type AdminRecomputeReceiptsRequest,
  type AdminRecomputeReceiptsResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { ReceiptsAdminService } from './receipts-admin.service.js';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('admin/receipts')
export class ReceiptsAdminController {
  constructor(private readonly receipts: ReceiptsAdminService) {}

  @RequirePermission('system:admin')
  @Post('recompute')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(AdminRecomputeReceiptsRequestSchema))
  @ApiOperation({ summary: 'Recompute and persist attempt receipts (admin)' })
  @ApiBody({ schema: zodSchemaToOpenApi(AdminRecomputeReceiptsRequestSchema, 'AdminRecomputeReceiptsRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AdminRecomputeReceiptsResponseSchema, 'AdminRecomputeReceiptsResponse') })
  async recompute(@Body() body: AdminRecomputeReceiptsRequest): Promise<AdminRecomputeReceiptsResponse> {
    return this.receipts.recompute(body);
  }
}


import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AgentRuntimeStatusResponseSchema,
  type AgentRuntimeStatusResponse,
} from '@eve/shared';
import { RequirePermission } from '../auth/permission.decorator.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { AgentRuntimeService } from './agent-runtime.service.js';

@ApiTags('agent-runtime')
@ApiBearerAuth()
@Controller('orgs/:org_id/agent-runtime')
export class AgentRuntimeController {
  constructor(private readonly agentRuntimeService: AgentRuntimeService) {}

  @RequirePermission('orgs:read')
  @Get('status')
  @ApiOperation({ summary: 'Get agent runtime status for an org' })
  @ApiOkResponse({
    description: 'Agent runtime status',
    schema: zodSchemaToOpenApi(AgentRuntimeStatusResponseSchema, 'AgentRuntimeStatusResponse'),
  })
  async status(@Param('org_id') orgId: string): Promise<AgentRuntimeStatusResponse> {
    return this.agentRuntimeService.listStatus(orgId);
  }
}

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AgentRuntimeHeartbeatRequestSchema,
  AgentRuntimePodSchema,
  type AgentRuntimeHeartbeatRequest,
  type AgentRuntimePod,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { AgentRuntimeService } from './agent-runtime.service.js';

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class AgentRuntimeInternalController {
  constructor(private readonly agentRuntimeService: AgentRuntimeService) {}

  @Public()
  @Get('agent-runtime/orgs')
  @ApiOperation({ summary: 'List org IDs for agent runtime auto-discovery (internal only)' })
  async listOrgs(): Promise<{ org_ids: string[] }> {
    const orgIds = await this.agentRuntimeService.listOrgIds();
    return { org_ids: orgIds };
  }

  @Public()
  @Post('orgs/:org_id/agent-runtime/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record agent runtime heartbeat (internal only)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(AgentRuntimeHeartbeatRequestSchema, 'AgentRuntimeHeartbeatRequest'),
  })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(AgentRuntimePodSchema, 'AgentRuntimePod'),
  })
  async heartbeat(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(AgentRuntimeHeartbeatRequestSchema)) body: AgentRuntimeHeartbeatRequest,
  ): Promise<AgentRuntimePod> {
    return this.agentRuntimeService.recordHeartbeat(orgId, body);
  }
}

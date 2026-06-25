import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AgentRuntimeHeartbeatRequestSchema,
  AgentRuntimePodSchema,
  type AgentRuntimeHeartbeatRequest,
  type AgentRuntimePod,
  loadConfig,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { AgentRuntimeService } from './agent-runtime.service.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

function validateInternalToken(token: string | undefined): void {
  const config = loadConfig();
  if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
    throw new UnauthorizedException('Invalid internal token');
  }
}

@ApiTags('internal')
@Controller('internal')
export class AgentRuntimeInternalController {
  constructor(private readonly agentRuntimeService: AgentRuntimeService) {}

  @Public()
  @Get('agent-runtime/orgs')
  @ApiOperation({ summary: 'List org IDs for agent runtime auto-discovery (internal only)' })
  async listOrgs(
    @Headers(INTERNAL_HEADER) token: string | undefined,
  ): Promise<{ org_ids: string[] }> {
    validateInternalToken(token);
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
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body(new ZodValidationPipe(AgentRuntimeHeartbeatRequestSchema)) body: AgentRuntimeHeartbeatRequest,
  ): Promise<AgentRuntimePod> {
    validateInternalToken(token);
    return this.agentRuntimeService.recordHeartbeat(orgId, body);
  }
}

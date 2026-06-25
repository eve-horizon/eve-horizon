import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  OrgAgentDirectoryResponseSchema,
  type OrgAgentDirectoryResponse,
  loadConfig,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { Public } from '../auth/auth.decorator.js';
import { OrgsService } from './orgs.service.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

@ApiTags('internal')
@Controller('internal/orgs/:org_id/agents')
export class OrgsInternalController {
  constructor(private readonly orgsService: OrgsService) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List agent directory for org (internal only)' })
  @ApiOkResponse({
    description: 'Agent directory list',
    schema: zodSchemaToOpenApi(OrgAgentDirectoryResponseSchema, 'OrgAgentDirectoryResponse'),
  })
  async listAgents(
    @Param('org_id') orgId: string,
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Query('client') client?: string,
  ): Promise<OrgAgentDirectoryResponse> {
    const config = loadConfig();
    if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
      throw new UnauthorizedException('Invalid internal token');
    }

    return this.orgsService.listAgentDirectory(orgId, { client });
  }
}

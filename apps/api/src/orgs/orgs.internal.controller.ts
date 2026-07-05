import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  OrgAgentDirectoryResponseSchema,
  type OrgAgentDirectoryResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { OrgsService } from './orgs.service.js';

@ApiTags('internal')
@Controller('internal/orgs/:org_id/agents')
@UseGuards(InternalTokenGuard)
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
    @Query('client') client?: string,
  ): Promise<OrgAgentDirectoryResponse> {
    return this.orgsService.listAgentDirectory(orgId, { client });
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permission.decorator.js';
import { IntegrationsService } from './integrations.service.js';
import {
  CreateOAuthAppConfigRequestSchema,
  type OAuthAppConfigResponse,
  type ProviderSetupInfoResponse,
} from '@eve/shared';

@ApiTags('integrations')
@Controller()
export class OAuthAppConfigController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @RequirePermission('integrations:write')
  @Post('orgs/:org_id/integrations/providers/:provider/config')
  @ApiOperation({ summary: 'Create or update OAuth app credentials for a provider' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'provider', description: 'Provider name (google_drive, slack)' })
  async upsertConfig(
    @Param('org_id') orgId: string,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<OAuthAppConfigResponse> {
    const payload = CreateOAuthAppConfigRequestSchema.parse(body);
    return this.integrationsService.upsertOAuthAppConfig(orgId, provider, payload);
  }

  @RequirePermission('integrations:read')
  @Get('orgs/:org_id/integrations/providers/:provider/config')
  @ApiOperation({ summary: 'Get OAuth app config for a provider (secrets redacted)' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'provider', description: 'Provider name' })
  async getConfig(
    @Param('org_id') orgId: string,
    @Param('provider') provider: string,
  ): Promise<OAuthAppConfigResponse> {
    const config = await this.integrationsService.getOAuthAppConfig(orgId, provider);
    if (!config) {
      throw new NotFoundException(`No OAuth app configured for provider "${provider}" in this org`);
    }
    return {
      id: config.id,
      org_id: config.org_id,
      provider: config.provider,
      client_id: config.client_id,
      label: config.label,
      status: config.status,
      has_signing_secret: !!(config.config_json as Record<string, unknown>)?.signing_secret,
      created_at: config.created_at instanceof Date ? config.created_at.toISOString() : String(config.created_at),
      updated_at: config.updated_at instanceof Date ? config.updated_at.toISOString() : String(config.updated_at),
    };
  }

  @RequirePermission('integrations:write')
  @Delete('orgs/:org_id/integrations/providers/:provider/config')
  @ApiOperation({ summary: 'Remove OAuth app config for a provider' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'provider', description: 'Provider name' })
  async removeConfig(
    @Param('org_id') orgId: string,
    @Param('provider') provider: string,
  ): Promise<{ ok: boolean }> {
    const removed = await this.integrationsService.removeOAuthAppConfig(orgId, provider);
    if (!removed) {
      throw new NotFoundException(`No OAuth app configured for provider "${provider}" in this org`);
    }
    return { ok: true };
  }

  @RequirePermission('integrations:read')
  @Get('orgs/:org_id/integrations/providers/:provider/setup-info')
  @ApiOperation({ summary: 'Get setup instructions and URLs for configuring an OAuth app' })
  @ApiParam({ name: 'org_id', description: 'Organization ID' })
  @ApiParam({ name: 'provider', description: 'Provider name' })
  getSetupInfo(
    @Param('provider') provider: string,
  ): ProviderSetupInfoResponse {
    return this.integrationsService.getProviderSetupInfo(provider);
  }
}

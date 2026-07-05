import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IntegrationResolveRequestSchema,
  IntegrationResolveResponseSchema,
  ExternalIdentityResolveRequestSchema,
  ExternalIdentityResolveResponseSchema,
  IdentityLinkRedeemRequestSchema,
  IdentityLinkRedeemResponseSchema,
  type IntegrationResolveRequest,
  type IntegrationResolveResponse,
  type ExternalIdentityResolveRequest,
  type ExternalIdentityResolveResponse,
  type IdentityLinkRedeemRequest,
  type IdentityLinkRedeemResponse,
} from '@eve/shared';
import { z } from 'zod';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { IntegrationsService } from './integrations.service.js';

const IntegrationTokensRequestSchema = z.object({
  integration_id: z.string().min(1),
});
const IntegrationTokensResponseSchema = z.object({
  tokens_json: z.record(z.unknown()).nullable(),
});

@ApiTags('internal')
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class IntegrationsInternalController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post('integrations/resolve')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve integration by provider + account (internal only)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(IntegrationResolveRequestSchema, 'IntegrationResolveRequest'),
  })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(IntegrationResolveResponseSchema, 'IntegrationResolveResponse'),
  })
  async resolveIntegration(
    @Body(new ZodValidationPipe(IntegrationResolveRequestSchema)) body: IntegrationResolveRequest,
  ): Promise<IntegrationResolveResponse> {
    return this.integrationsService.resolveIntegration(body.provider, body.account_id);
  }

  @Post('integrations/external-identities/resolve')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve external identity and create membership request (internal only)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(ExternalIdentityResolveRequestSchema, 'ExternalIdentityResolveRequest'),
  })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(ExternalIdentityResolveResponseSchema, 'ExternalIdentityResolveResponse'),
  })
  async resolveExternalIdentity(
    @Body(new ZodValidationPipe(ExternalIdentityResolveRequestSchema)) body: ExternalIdentityResolveRequest,
  ): Promise<ExternalIdentityResolveResponse> {
    return this.integrationsService.resolveExternalIdentity(
      body.org_id,
      body.provider,
      body.account_id,
      body.external_user_id,
      body.external_email,
    );
  }

  @Post('integrations/tokens')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fetch integration tokens (internal only)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(IntegrationTokensRequestSchema, 'IntegrationTokensRequest'),
  })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(IntegrationTokensResponseSchema, 'IntegrationTokensResponse'),
  })
  async fetchTokens(
    @Body(new ZodValidationPipe(IntegrationTokensRequestSchema)) body: { integration_id: string },
  ): Promise<{ tokens_json: Record<string, unknown> | null }> {
    const tokens = await this.integrationsService.getIntegrationTokens(body.integration_id);
    return { tokens_json: tokens };
  }

  @Post('identity-link-tokens/redeem')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem an identity link token (internal, called by gateway)' })
  @ApiBody({
    schema: zodSchemaToOpenApi(IdentityLinkRedeemRequestSchema, 'IdentityLinkRedeemRequest'),
  })
  @ApiOkResponse({
    schema: zodSchemaToOpenApi(IdentityLinkRedeemResponseSchema, 'IdentityLinkRedeemResponse'),
  })
  async redeemLinkToken(
    @Body(new ZodValidationPipe(IdentityLinkRedeemRequestSchema)) body: IdentityLinkRedeemRequest,
  ): Promise<IdentityLinkRedeemResponse> {
    return this.integrationsService.redeemLinkToken(
      body.token,
      body.provider,
      body.account_id,
      body.external_user_id,
    );
  }

  @Get('integrations/active')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List active integrations for gateway bootstrap (internal only)' })
  async listActiveIntegrations(): Promise<Array<{
    id: string; org_id: string; provider: string;
    account_id: string; tokens_json: Record<string, unknown> | null;
    settings_json: Record<string, unknown>; status: string;
  }>> {
    return this.integrationsService.listActiveIntegrations();
  }
}

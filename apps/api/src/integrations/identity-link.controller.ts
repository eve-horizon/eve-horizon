import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IdentityLinkTokenRequestSchema,
  IdentityLinkTokenResponseSchema,
  type IdentityLinkTokenRequest,
  type IdentityLinkTokenResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { IntegrationsService } from './integrations.service.js';

@ApiTags('identity')
@ApiBearerAuth()
@Controller('users/me/identity-link-tokens')
export class IdentityLinkController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a link token to bind an external identity to this Eve account' })
  @ApiBody({ schema: zodSchemaToOpenApi(IdentityLinkTokenRequestSchema, 'IdentityLinkTokenRequest') })
  @ApiOkResponse({
    description: 'Link token with instructions',
    schema: zodSchemaToOpenApi(IdentityLinkTokenResponseSchema, 'IdentityLinkTokenResponse'),
  })
  async generateLinkToken(
    @Req() request: { user?: { user_id?: string } },
    @Body(new ZodValidationPipe(IdentityLinkTokenRequestSchema)) body: IdentityLinkTokenRequest,
  ): Promise<IdentityLinkTokenResponse> {
    const userId = request.user?.user_id;
    if (!userId) {
      throw new Error('Authentication required');
    }

    const { token, expiresIn } = this.integrationsService.generateLinkToken(
      userId,
      body.provider,
      body.org_id,
    );

    return {
      token,
      expires_in: expiresIn,
      instructions: `To link your ${body.provider} identity, send this message to @eve in ${body.provider}:\n\n  @eve link ${token}\n\nToken expires in ${Math.floor(expiresIn / 60)} minutes.`,
    };
  }
}

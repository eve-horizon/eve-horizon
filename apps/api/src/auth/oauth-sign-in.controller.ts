import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthExchangeResponseSchema,
  OAuthSignInExchangeRequestSchema,
  type AuthExchangeResponse,
  type OAuthSignInExchangeRequest,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { Public } from './auth.decorator.js';
import { OAuthSignInService } from './oauth-sign-in.service.js';

@ApiTags('auth')
@Controller('auth/oauth')
export class OAuthSignInController {
  constructor(private readonly oauthSignIn: OAuthSignInService) {}

  @Post('exchange')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a verified Google GoTrue session for an Eve app token',
    description: 'Requires a GoTrue Bearer token and signs in an existing member only.',
  })
  @ApiBody({ schema: zodSchemaToOpenApi(OAuthSignInExchangeRequestSchema, 'OAuthSignInExchangeRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(AuthExchangeResponseSchema, 'AuthExchangeResponse') })
  async exchange(
    @Body(new ZodValidationPipe(OAuthSignInExchangeRequestSchema)) body: OAuthSignInExchangeRequest,
    @Headers('authorization') authorization?: string | string[],
  ): Promise<AuthExchangeResponse> {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header?.startsWith('Bearer ') || header.length <= 7 || header.length > 8_199) {
      throw new UnauthorizedException('Bearer token required');
    }

    const token = header.slice(7);
    if (/\s/.test(token)) {
      throw new UnauthorizedException('Bearer token required');
    }
    return this.oauthSignIn.exchange(token, body);
  }
}

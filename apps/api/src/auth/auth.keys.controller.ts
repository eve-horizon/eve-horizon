import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './auth.decorator.js';
import { AuthService } from './auth.service.js';

@ApiTags('auth')
@Controller()
export class AuthKeysController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Get('/.well-known/jwks.json')
  @ApiOperation({ summary: 'Get public JWKS for auth verification' })
  @ApiOkResponse({ description: 'JWKS' })
  jwks() {
    return this.authService.getJwks();
  }
}

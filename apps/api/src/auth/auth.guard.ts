import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC_KEY } from './auth.decorator.js';
import { IdentityProviderRegistry } from './providers/index.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly providerRegistry: IdentityProviderRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.authService.isEnabled()) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authorization = request?.headers?.authorization;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;

    // 1. Bearer JWT (existing path)
    if (header?.toLowerCase().startsWith('bearer ')) {
      request.user = await this.authService.verifyAuthorizationHeader(header);
      return true;
    }

    // 2. Provider-specific request auth (e.g. Nostr NIP-98)
    try {
      const extracted = this.providerRegistry.extractFromRequest(request);
      if (extracted) {
        const provider = this.providerRegistry.get(extracted.providerName);
        if (provider?.verifyRequestCredential) {
          const verified = await provider.verifyRequestCredential(extracted);
          if (verified) {
            request.user = await this.authService.resolveVerifiedIdentity(verified);
            return true;
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `Provider request auth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    throw new UnauthorizedException();
  }
}

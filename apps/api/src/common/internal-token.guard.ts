import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { loadConfig, INTERNAL_TOKEN_HEADER, internalTokenMatches } from '@eve/shared';

/**
 * Guards internal service-to-service endpoints authenticated by the shared
 * `x-eve-internal-token` header.
 *
 * Rejects with 401 `UnauthorizedException('Invalid internal token')` when
 * `EVE_INTERNAL_API_KEY` is unset or the header value does not match. The
 * comparison is constant-time (shared `internalTokenMatches`).
 *
 * Apply with `@UseGuards(InternalTokenGuard)` alongside `@Public()`
 * (which skips the global JWT auth guard).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const token = request.headers[INTERNAL_TOKEN_HEADER];
    const config = loadConfig();
    if (!internalTokenMatches(token, config.EVE_INTERNAL_API_KEY)) {
      throw new UnauthorizedException('Invalid internal token');
    }
    return true;
  }
}

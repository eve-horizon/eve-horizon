import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * Guard to protect internal admin endpoints with EVE_INTERNAL_API_KEY.
 *
 * Accepts the key via:
 * - `x-internal-api-key` header, OR
 * - `Authorization: Bearer <key>` header
 *
 * If EVE_INTERNAL_API_KEY is not configured, all requests are REJECTED (fail closed).
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const configuredKey = process.env.EVE_INTERNAL_API_KEY;

    // Fail closed: if no key is configured, reject all requests
    if (!configuredKey) {
      throw new UnauthorizedException('Internal API key not configured');
    }

    const request = context.switchToHttp().getRequest();
    const headers = request?.headers;

    if (!headers) {
      throw new UnauthorizedException('Missing headers');
    }

    // Try x-internal-api-key header first
    let providedKey = headers['x-internal-api-key'];
    if (Array.isArray(providedKey)) {
      providedKey = providedKey[0];
    }

    // Fallback to Authorization: Bearer <key>
    if (!providedKey) {
      const authorization = headers.authorization;
      const authHeader = Array.isArray(authorization) ? authorization[0] : authorization;
      if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match) {
          providedKey = match[1];
        }
      }
    }

    if (!providedKey) {
      throw new UnauthorizedException('Missing internal API key');
    }

    // Constant-time comparison to prevent timing attacks
    if (!this.secureCompare(providedKey, configuredKey)) {
      throw new UnauthorizedException('Invalid internal API key');
    }

    return true;
  }

  /**
   * Constant-time string comparison to prevent timing attacks.
   */
  private secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }
}

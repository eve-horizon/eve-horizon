import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Injects the authenticated principal (`request.user`, attached by the auth
 * guard). Resolves to `undefined` for unauthenticated requests.
 *
 * Custom param decorators are invisible to Swagger, so switching a handler
 * from `@Req()` to `@CurrentUser()` does not change the OpenAPI document.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    return request.user;
  },
);

/**
 * Injects the request correlation ID (`request.correlationId`, attached by
 * the correlation-ID onRequest hook in @eve/shared service bootstrap).
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<{ correlationId?: string }>();
    return request.correlationId;
  },
);

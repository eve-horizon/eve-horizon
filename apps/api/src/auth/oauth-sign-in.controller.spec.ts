import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { OAuthSignInExchangeRequestSchema } from '@eve/shared';
import { OAuthSignInController } from './oauth-sign-in.controller';
import type { OAuthSignInService } from './oauth-sign-in.service';

describe('OAuthSignInController', () => {
  it('passes a bounded Bearer token and strict request to the scoped service', async () => {
    const service = { exchange: vi.fn().mockResolvedValue({ access_token: 'eve', token_type: 'bearer', expires_at: 1, user_id: 'user_1' }) };
    const controller = new OAuthSignInController(service as unknown as OAuthSignInService);

    await expect(controller.exchange({ project_id: 'proj_1', provider: 'google' }, 'Bearer gotrue-token'))
      .resolves.toMatchObject({ user_id: 'user_1' });
    expect(service.exchange).toHaveBeenCalledWith('gotrue-token', { project_id: 'proj_1', provider: 'google' });
  });

  it('rejects missing, whitespace, and oversized Bearer tokens', async () => {
    const controller = new OAuthSignInController({ exchange: vi.fn() } as unknown as OAuthSignInService);
    const body = { project_id: 'proj_1', provider: 'google' } as const;
    await expect(controller.exchange(body, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.exchange(body, 'Bearer two tokens')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.exchange(body, `Bearer ${'a'.repeat(8_193)}`)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses a strict, bounded exchange body schema', () => {
    expect(OAuthSignInExchangeRequestSchema.safeParse({ project_id: '', provider: 'google' }).success).toBe(false);
    expect(OAuthSignInExchangeRequestSchema.safeParse({ project_id: 'x'.repeat(257), provider: 'google' }).success).toBe(false);
    expect(OAuthSignInExchangeRequestSchema.safeParse({ project_id: 'proj_1', provider: 'google', extra: true }).success).toBe(false);
  });
});

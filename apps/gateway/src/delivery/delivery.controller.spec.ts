import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryController } from './delivery.controller.js';

describe('DeliveryController internal token', () => {
  const getInstance = vi.fn().mockReturnValue(undefined);
  const controller = new DeliveryController({ getInstance } as any);
  const body = { provider: 'slack', account_id: 'acct', channel_id: 'chan', text: 'hi' };

  beforeEach(() => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', 'internal-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a missing or wrong token', async () => {
    await expect(controller.handleDelivery(undefined, body)).rejects.toThrow(UnauthorizedException);
    await expect(controller.handleDelivery('internal-kez', body)).rejects.toThrow(UnauthorizedException);
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('refuses everything when no key is configured', async () => {
    vi.stubEnv('EVE_INTERNAL_API_KEY', '');
    await expect(controller.handleDelivery('', body)).rejects.toThrow(UnauthorizedException);
  });

  it('accepts the configured key', async () => {
    await expect(controller.handleDelivery('internal-key', body)).resolves.toEqual({
      delivered: false,
      reason: 'no_provider_instance',
    });
  });
});

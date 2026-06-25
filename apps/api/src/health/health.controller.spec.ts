import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';

function createMockDb(shouldFail = false) {
  const fn = vi.fn().mockImplementation(() => {
    if (shouldFail) {
      return Promise.reject(new Error('CONNECT_TIMEOUT'));
    }
    return Promise.resolve([{ '?column?': 1 }]);
  });
  // Tagged template support: db`SELECT 1` calls db(['SELECT 1'], ...)
  return fn as unknown as import('@eve/db').Db;
}

describe('HealthController', () => {
  it('returns 200 with status ok when database is connected', async () => {
    const db = createMockDb(false);
    const controller = new HealthController(db);

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('connected');
    expect(result.timestamp).toBeDefined();
  });

  it('throws ServiceUnavailableException (503) when database is unreachable', async () => {
    const db = createMockDb(true);
    const controller = new HealthController(db);

    await expect(controller.check()).rejects.toThrow(ServiceUnavailableException);

    try {
      await controller.check();
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const response = (err as ServiceUnavailableException).getResponse();
      expect(response).toMatchObject({
        status: 'degraded',
        database: 'disconnected',
      });
    }
  });
});

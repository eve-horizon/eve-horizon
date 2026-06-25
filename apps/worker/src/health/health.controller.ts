import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Db } from '@eve/db';

@Controller('health')
export class HealthController {
  constructor(@Inject('DB') private readonly db: Db) {}

  @Get()
  async check() {
    try {
      await this.db`SELECT 1`;
      return {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[health] Database check failed: ${errMsg}`);
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

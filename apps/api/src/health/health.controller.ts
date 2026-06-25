import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { Public } from '../auth/auth.decorator.js';

// Build info from environment (set at build time via Docker ARG -> ENV)
const BUILD_INFO = {
  version: process.env.EVE_BUILD_VERSION || 'dev',
  gitSha: process.env.EVE_BUILD_SHA || 'unknown',
  buildTime: process.env.EVE_BUILD_TIME || 'unknown',
};

@Controller('health')
export class HealthController {
  constructor(@Inject('DB') private readonly db: Db) {}

  @Get()
  @Public()
  async check() {
    try {
      await this.db`SELECT 1`;
      return {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
        build: BUILD_INFO,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[health] Database check failed: ${errMsg}`);
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
        build: BUILD_INFO,
      });
    }
  }

  @Get('version')
  @Public()
  version() {
    return BUILD_INFO;
  }
}

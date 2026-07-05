import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Db } from '@eve/db';
import { checkDbHealth } from '@eve/db';

@Controller('health')
export class HealthController {
  constructor(@Inject('DB') private readonly db: Db) {}

  @Get()
  async check() {
    const result = await checkDbHealth(this.db);
    if (!result.ok) {
      throw new ServiceUnavailableException(result.body);
    }
    return result.body;
  }
}

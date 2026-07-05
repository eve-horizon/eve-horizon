import { Controller, Get } from '@nestjs/common';

/**
 * Deliberately DB-less: the gateway keeps serving webhook ingress even when
 * Postgres is down (deliveries queue via the API), so its liveness must not
 * couple to the database like the other services' checkDbHealth probes do.
 */
@Controller('health')
export class HealthController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}

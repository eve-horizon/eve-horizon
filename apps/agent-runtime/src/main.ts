import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService } from '@nestjs/common';
import { initServiceTelemetry, registerCorrelationIdHook } from '@eve/shared';
import { AppModule } from './app.module';

function resolvePort(): number {
  const raw = process.env.AGENT_RUNTIME_PORT ?? process.env.EVE_AGENT_RUNTIME_PORT;
  return raw ? parseInt(raw, 10) : 4812;
}

async function bootstrap() {
  const port = resolvePort();

  const logger = (await initServiceTelemetry('agent-runtime')) as LoggerService;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  registerCorrelationIdHook(app.getHttpAdapter().getInstance());

  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
  logger.log(`Agent runtime listening on port ${port}`);
}

bootstrap();

import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService } from '@nestjs/common';
import {
  initServiceTelemetry,
  logStartupConfigWarnings,
  registerCorrelationIdHook,
} from '@eve/shared';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT ? parseInt(process.env.ORCHESTRATOR_PORT, 10) : 4748;

  const logger = (await initServiceTelemetry('orchestrator')) as LoggerService;

  // Validate critical configuration at startup
  logStartupConfigWarnings(logger, 'ORCHESTRATOR');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  registerCorrelationIdHook(app.getHttpAdapter().getInstance());

  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
  logger.log(`Orchestrator listening on port ${port}`);
}

bootstrap();

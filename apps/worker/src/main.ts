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
import { AllExceptionsFilter } from './all-exceptions.filter';

async function bootstrap() {
  const port = process.env.WORKER_PORT ? parseInt(process.env.WORKER_PORT, 10) : 4749;
  // Default request timeout is 300s (5 min) - jobs can take 30+ minutes
  const requestTimeoutMs = parseInt(process.env.EVE_WORKER_REQUEST_TIMEOUT_MS || '3600000', 10);

  const logger = (await initServiceTelemetry('worker')) as LoggerService;

  // Validate critical configuration at startup
  logStartupConfigWarnings(logger, 'WORKER');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  // Register global exception filter to preserve error messages.
  // Opt-in per service — only the worker registers it today (XAP-4); see
  // all-exceptions.filter.ts for the adoption note.
  app.useGlobalFilters(new AllExceptionsFilter());

  registerCorrelationIdHook(app.getHttpAdapter().getInstance());

  // Set HTTP server timeout for long-running job requests (default 1 hour)
  const server = app.getHttpServer();
  server.setTimeout(requestTimeoutMs);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs + 1000; // Must be > requestTimeout

  await app.listen(port, '0.0.0.0');
  logger.log(`Worker listening on port ${port} (request timeout: ${requestTimeoutMs}ms)`);
}

bootstrap();

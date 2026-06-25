import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService } from '@nestjs/common';
import {
  CORRELATION_HEADER,
  createJsonLogger,
  ensureCorrelationId,
  initOtel,
  runWithCorrelationContext,
} from '@eve/shared';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './all-exceptions.filter';

async function bootstrap() {
  const port = process.env.WORKER_PORT ? parseInt(process.env.WORKER_PORT, 10) : 4749;
  // Default request timeout is 300s (5 min) - jobs can take 30+ minutes
  const requestTimeoutMs = parseInt(process.env.EVE_WORKER_REQUEST_TIMEOUT_MS || '3600000', 10);

  await initOtel('eve-worker');

  const logger = createJsonLogger('worker') as LoggerService;

  // Validate critical configuration at startup
  {
    const warnings: string[] = [];
    if (!process.env.EVE_INTERNAL_API_KEY) {
      warnings.push('EVE_INTERNAL_API_KEY is not set — secret resolution will be unavailable');
    }
    if (!process.env.EVE_API_URL) {
      warnings.push('EVE_API_URL is not set — API callbacks will be unavailable');
    }
    if (warnings.length > 0) {
      logger.warn('WORKER CONFIGURATION WARNINGS:');
      warnings.forEach(w => logger.warn(`  - ${w}`));
    }
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  // Register global exception filter to preserve error messages
  app.useGlobalFilters(new AllExceptionsFilter());

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const incoming = request.headers?.[CORRELATION_HEADER];
    const correlationId = ensureCorrelationId(incoming);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelationContext({ correlationId, traceId: correlationId }, done);
  });

  // Set HTTP server timeout for long-running job requests (default 1 hour)
  const server = app.getHttpServer();
  server.setTimeout(requestTimeoutMs);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs + 1000; // Must be > requestTimeout

  await app.listen(port, '0.0.0.0');
  logger.log(`Worker listening on port ${port} (request timeout: ${requestTimeoutMs}ms)`);
}

bootstrap();

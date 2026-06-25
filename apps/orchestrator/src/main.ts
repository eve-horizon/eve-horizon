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

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT ? parseInt(process.env.ORCHESTRATOR_PORT, 10) : 4748;

  await initOtel('eve-orchestrator');

  const logger = createJsonLogger('orchestrator') as LoggerService;

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
      logger.warn('ORCHESTRATOR CONFIGURATION WARNINGS:');
      warnings.forEach(w => logger.warn(`  - ${w}`));
    }
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const incoming = request.headers?.[CORRELATION_HEADER];
    const correlationId = ensureCorrelationId(incoming);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelationContext({ correlationId, traceId: correlationId }, done);
  });

  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
  logger.log(`Orchestrator listening on port ${port}`);
}

bootstrap();

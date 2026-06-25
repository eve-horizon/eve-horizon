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

function resolvePort(): number {
  const raw = process.env.AGENT_RUNTIME_PORT ?? process.env.EVE_AGENT_RUNTIME_PORT;
  return raw ? parseInt(raw, 10) : 4812;
}

async function bootstrap() {
  const port = resolvePort();

  await initOtel('eve-agent-runtime');

  const logger = createJsonLogger('agent-runtime') as LoggerService;

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
  logger.log(`Agent runtime listening on port ${port}`);
}

bootstrap();

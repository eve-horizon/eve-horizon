import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { LoggerService } from '@nestjs/common';
import {
  CORRELATION_HEADER,
  createJsonLogger,
  ensureCorrelationId,
  initOtel,
  runWithCorrelationContext,
} from '@eve/shared';
import { AppModule } from './app.module';
import { attachRegisteredSchemas } from './openapi.js';

async function bootstrap() {
  const port = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 4747;

  await initOtel('eve-api');

  const logger = createJsonLogger('api') as LoggerService;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  await app.init();

  // CORS — allow any origin by default; override with EVE_CORS_ORIGIN
  const corsOrigin = process.env.EVE_CORS_ORIGIN || '*';
  const corsOrigins = corsOrigin === 'true'
    ? []
    : corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  const corsOriginValue = corsOrigin === 'true'
    ? true
    : corsOrigins.length > 1
      ? corsOrigins
      : corsOrigins[0] ?? '*';
  app.enableCors({
    origin: corsOriginValue,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CORRELATION_HEADER, 'X-Cloud-FS-Path'],
    exposedHeaders: [CORRELATION_HEADER],
    credentials: corsOriginValue !== '*',
  });

  const fastify = app.getHttpAdapter().getInstance();
  try {
    fastify.removeContentTypeParser('application/json');
    fastify.removeContentTypeParser('application/*+json');
  } catch {
    // Ignore if parser wasn't registered yet.
  }
  const rawBodyParser = (req: any, body: string, done: (err: Error | null, value?: any) => void) => {
    req.rawBody = body;
    if (!body) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error);
    }
  };

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, rawBodyParser);
  fastify.addContentTypeParser('application/*+json', { parseAs: 'string' }, rawBodyParser);

  // Catch-all parser for non-JSON content types (binary uploads, etc.)
  // Only matches types without a more specific parser, so JSON handling is unaffected.
  fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 }, (req: any, body: Buffer, done: (err: Error | null, value?: any) => void) => {
    req.rawBody = body;
    done(null, body);
  });

  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const incoming = request.headers?.[CORRELATION_HEADER];
    const correlationId = ensureCorrelationId(incoming);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelationContext({ correlationId, traceId: correlationId }, done);
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Eve Horizon API')
    .setDescription('Job orchestration API')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  attachRegisteredSchemas(swaggerDocument);
  SwaggerModule.setup('docs', app, swaggerDocument, {
    jsonDocumentUrl: '/openapi.json',
    yamlDocumentUrl: '/openapi.yaml',
  });

  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on port ${port}`);
}

bootstrap();

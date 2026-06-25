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
import { AppModule } from './app.module.js';
import { GatewayProviderRegistry } from './providers/provider-registry.js';
import { getJson } from './api-client.js';

async function bootstrap() {
  const port = process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : 4820;

  await initOtel('eve-gateway');

  const logger = createJsonLogger('gateway') as LoggerService;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger },
  );

  await app.init();

  // Bootstrap provider registry from active integrations
  const registry = app.get(GatewayProviderRegistry);
  try {
    const integrations = await getJson<Array<{
      id: string; org_id: string; provider: string;
      account_id: string; tokens_json: Record<string, unknown> | null;
      settings_json: Record<string, unknown>; status: string;
    }>>('/internal/integrations/active');
    await registry.initializeAll(integrations);
    logger.log(`Initialized ${integrations.length} provider instance(s)`);
  } catch (err) {
    logger.warn(`Failed to load integrations at startup: ${err}`);
    // Non-fatal: gateway starts but webhooks will 404 until integrations are loaded
  }

  // Hot-load new integrations every 30s without requiring a restart
  const fetchIntegrations = () => getJson<Array<{
    id: string; org_id: string; provider: string;
    account_id: string; tokens_json: Record<string, unknown> | null;
    settings_json: Record<string, unknown>; status: string;
  }>>('/internal/integrations/active');
  registry.startSync(fetchIntegrations);

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

  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const incoming = request.headers?.[CORRELATION_HEADER];
    const correlationId = ensureCorrelationId(incoming);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelationContext({ correlationId, traceId: correlationId }, done);
  });

  await app.listen(port, '0.0.0.0');
  logger.log(`Gateway listening on port ${port}`);
}

bootstrap();

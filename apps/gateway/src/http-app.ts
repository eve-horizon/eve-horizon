import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LoggerService } from '@nestjs/common';
import { registerCorrelationIdHook, registerRawBodyJsonParser } from '@eve/shared';
import { AppModule } from './app.module.js';

/**
 * Create and initialise the gateway's HTTP app (not yet listening).
 *
 * Every body parser keeps the raw request body as `rawBody`, because Slack
 * signs the exact bytes it sends: JSON for events, form-encoded for
 * interactive actions and slash commands. The JSON parser stores a string,
 * Nest's form parser a Buffer.
 */
export async function createGatewayHttpApp(
  logger: LoggerService | false,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger, rawBody: true },
  );
  await app.init();

  const fastify = app.getHttpAdapter().getInstance();
  registerRawBodyJsonParser(fastify);
  registerCorrelationIdHook(fastify);
  return app;
}

import { createJsonLogger, type JsonLogger } from './logger.js';
import { CORRELATION_HEADER, ensureCorrelationId, runWithCorrelationContext } from './observability.js';
import { initOtel } from './otel.js';

/**
 * Shared bootstrap helpers for the NestJS/Fastify services (XAP-1).
 *
 * These are deliberately framework-free: @eve/shared has no @nestjs/* or
 * fastify dependency, so the helpers operate on structural types and each
 * service's main.ts keeps its own `NestFactory.create(...)` call. Every
 * helper is a verbatim extraction of a block that was byte-identical across
 * apps/{api,gateway,orchestrator,worker,agent-runtime}/src/main.ts — call
 * them at the exact position the inline block occupied so hook and parser
 * registration order is unchanged.
 *
 * Note on the global exception filter (XAP-4): it needs @nestjs/common at
 * runtime (@Catch, HttpException, Logger) so it cannot live here; it remains
 * opt-in at apps/worker/src/all-exceptions.filter.ts.
 */

/** Minimal structural view of the Fastify instance the helpers touch. */
export interface BootstrapFastifyInstance {
  addHook(
    name: 'onRequest',
    hook: (request: any, reply: any, done: () => void) => void,
  ): unknown;
  removeContentTypeParser(contentType: string): unknown;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    parser: (req: any, body: string, done: (err: Error | null, value?: any) => void) => void,
  ): unknown;
}

/**
 * Service preamble: initialize OTel as `eve-<serviceName>` and return the
 * service's JSON logger (cast to Nest's LoggerService at the call site).
 */
export async function initServiceTelemetry(serviceName: string): Promise<JsonLogger> {
  await initOtel(`eve-${serviceName}`);
  return createJsonLogger(serviceName);
}

/**
 * Warn (without failing) when core platform env vars are missing. Extracted
 * verbatim from the orchestrator/worker startup blocks; `serviceLabel` is the
 * uppercase prefix used in the original messages (e.g. 'WORKER').
 */
export function logStartupConfigWarnings(
  logger: { warn: (message: string) => void },
  serviceLabel: string,
): void {
  const warnings: string[] = [];
  if (!process.env.EVE_INTERNAL_API_KEY) {
    warnings.push('EVE_INTERNAL_API_KEY is not set — secret resolution will be unavailable');
  }
  if (!process.env.EVE_API_URL) {
    warnings.push('EVE_API_URL is not set — API callbacks will be unavailable');
  }
  if (warnings.length > 0) {
    logger.warn(`${serviceLabel} CONFIGURATION WARNINGS:`);
    warnings.forEach(w => logger.warn(`  - ${w}`));
  }
}

/**
 * Register the correlation-ID onRequest hook: reuse the incoming
 * x-correlation-id (or mint one), expose it on the request and response
 * header, and run the rest of the request in that correlation context.
 */
export function registerCorrelationIdHook(fastify: BootstrapFastifyInstance): void {
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const incoming = request.headers?.[CORRELATION_HEADER];
    const correlationId = ensureCorrelationId(incoming);
    request.correlationId = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelationContext({ correlationId, traceId: correlationId }, done);
  });
}

/**
 * Replace Fastify's JSON content-type parsers with ones that keep the raw
 * body string on `req.rawBody` (needed for webhook signature verification)
 * while still producing the parsed JSON body.
 */
export function registerRawBodyJsonParser(fastify: BootstrapFastifyInstance): void {
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
}

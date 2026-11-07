import { INTERNAL_TOKEN_HEADER, internalTokenMatches } from './api-client/internal-fetch.js';
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
 * Paths an internal-only service answers without the internal token: the
 * liveness and readiness probe. Matched exactly against the request path
 * (query string ignored), so any other spelling stays protected.
 */
export const INTERNAL_AUTH_OPEN_PATHS: readonly string[] = ['/health'];

export interface InternalAuthHookOptions {
  /** Expected token. Defaults to `EVE_INTERNAL_API_KEY`. */
  key?: string;
  /** Exact request paths served without the token. Defaults to `INTERNAL_AUTH_OPEN_PATHS`. */
  openPaths?: readonly string[];
}

/**
 * Require the internal token (`x-eve-internal-token` carrying
 * `EVE_INTERNAL_API_KEY`) on every request to an internal-only service except
 * the open probe paths.
 *
 * Registered as an `onRequest` hook rather than per-controller guards, so it
 * covers every route, including routes added later and unknown paths, and
 * refuses callers before the body is parsed. Fails closed: with no key
 * configured, every protected request is refused.
 */
export function registerInternalAuthHook(
  fastify: Pick<BootstrapFastifyInstance, 'addHook'>,
  options: InternalAuthHookOptions = {},
): void {
  const key = options.key ?? process.env.EVE_INTERNAL_API_KEY;
  const openPaths = new Set(options.openPaths ?? INTERNAL_AUTH_OPEN_PATHS);
  fastify.addHook('onRequest', (request: any, reply: any, done: () => void) => {
    const url: string = typeof request.url === 'string' ? request.url : '';
    const queryStart = url.indexOf('?');
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    if (openPaths.has(path) || internalTokenMatches(request.headers?.[INTERNAL_TOKEN_HEADER], key)) {
      done();
      return;
    }
    // Replying from onRequest without calling done() skips the route handler.
    reply.code(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: key ? 'Missing or invalid internal token' : 'Internal API key not configured',
    });
  });
}

/**
 * Startup check for a service whose HTTP endpoints require the internal key.
 *
 * With `NODE_ENV=production` a missing `EVE_INTERNAL_API_KEY` stops the
 * service from starting, so a misconfigured deployment fails loudly instead
 * of refusing every call. Elsewhere it logs a warning; the endpoints still
 * fail closed.
 */
export function assertInternalApiKeyConfigured(
  logger: { warn: (message: string) => void },
  serviceLabel: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.EVE_INTERNAL_API_KEY) return;
  const message =
    `${serviceLabel}: EVE_INTERNAL_API_KEY is not set, so every request except ` +
    `${INTERNAL_AUTH_OPEN_PATHS.join(', ')} will be refused`;
  if (env.NODE_ENV === 'production') {
    throw new Error(`${message}. Refusing to start with NODE_ENV=production.`);
  }
  logger.warn(message);
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

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/**
 * Global exception filter that preserves error messages in 500 envelopes
 * (Nest's default filter replaces plain-Error messages with a generic
 * "Internal server error").
 *
 * XAP-4 status: OPT-IN. Only the worker registers this filter (main.ts);
 * api/gateway/orchestrator/agent-runtime deliberately keep Nest's default
 * envelopes — registering it there would change their 500 response bodies.
 * It stays app-local rather than in @eve/shared because @eve/shared is
 * framework-free (no @nestjs/* dependency) and this file needs
 * @nestjs/common at runtime; a dedicated Nest-coupled workspace package for
 * one single-consumer file isn't justified. To adopt in another service:
 * copy this file (or extract it to a shared Nest-coupled package once there
 * are two consumers) and add `app.useGlobalFilters(new AllExceptionsFilter())`
 * after `NestFactory.create` in that service's main.ts.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse();

    // If it's an HttpException, NestJS has already formatted it correctly
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      this.logger.error(`HTTP ${status}: ${exception.message}`, exception.stack);

      reply.status(status).send(response);
      return;
    }

    // For plain Error objects, preserve the message
    const error = exception as Error;
    const message = error?.message || 'Internal server error';

    this.logger.error(`Unhandled exception: ${message}`, error?.stack);

    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: message,
      error: 'Internal Server Error',
    });
  }
}

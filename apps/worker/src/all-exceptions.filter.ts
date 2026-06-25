import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

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

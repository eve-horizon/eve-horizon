import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorator.js';
import { SesFeedbackError, SesFeedbackService, type SnsMessage } from './ses-feedback.service.js';

type RequestWithRawBody = {
  rawBody?: string | Buffer;
};

@ApiTags('webhooks')
@Controller('webhooks')
export class SesFeedbackController {
  private readonly logger = new Logger(SesFeedbackController.name);

  constructor(private readonly service: SesFeedbackService) {}

  @Public()
  @Post('ses-feedback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive AWS SNS bounce/complaint/delivery notifications from SES.',
  })
  async handle(
    @Req() req: RequestWithRawBody,
    @Body() body: unknown,
  ): Promise<{ status: string; persisted?: number }> {
    // SNS POSTs with Content-Type: text/plain; charset=UTF-8 even though the body is JSON.
    // The Fastify catch-all parser captures rawBody on req; only the JSON parser hydrates
    // @Body() into an object. Fall back to rawBody when @Body() isn't a plain object.
    const payload = this.resolvePayload(body, req.rawBody);
    try {
      return await this.service.handle(payload);
    } catch (err) {
      if (err instanceof SesFeedbackError) {
        this.logger.warn({
          event: 'sns.rejected',
          reason: err.message,
          topic_arn: payload?.TopicArn,
          sns_message_id: payload?.MessageId,
        });
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private resolvePayload(body: unknown, rawBody: string | Buffer | undefined): SnsMessage {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      return body as SnsMessage;
    }
    const text =
      typeof rawBody === 'string'
        ? rawBody
        : Buffer.isBuffer(rawBody)
          ? rawBody.toString('utf-8')
          : typeof body === 'string'
            ? body
            : Buffer.isBuffer(body)
              ? body.toString('utf-8')
              : '';
    if (!text.trim()) {
      throw new BadRequestException('SNS message body missing');
    }
    try {
      return JSON.parse(text) as SnsMessage;
    } catch (err) {
      throw new BadRequestException(
        `SNS message body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

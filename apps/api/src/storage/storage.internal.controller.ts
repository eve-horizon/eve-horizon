import { Controller, Post, Headers, HttpCode, HttpStatus, Body, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { loadConfig } from '@eve/shared';
import { z } from 'zod';
import { Public } from '../auth/auth.decorator.js';
import { StorageService } from './storage.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

const INTERNAL_HEADER = 'x-eve-internal-token';

const PresignRequestSchema = z.object({
  key: z.string().min(1),
  operation: z.enum(['upload', 'download']),
  content_type: z.string().optional(),
});

type PresignRequest = z.infer<typeof PresignRequestSchema>;

@ApiTags('internal')
@Controller('internal/storage/chat-attachments')
export class StorageInternalController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get presigned URL for chat attachment upload/download (internal only)' })
  async presign(
    @Headers(INTERNAL_HEADER) token: string | undefined,
    @Body(new ZodValidationPipe(PresignRequestSchema)) body: PresignRequest,
  ): Promise<{ url: string }> {
    const config = loadConfig();
    if (!config.EVE_INTERNAL_API_KEY || token !== config.EVE_INTERNAL_API_KEY) {
      throw new UnauthorizedException('Invalid internal token');
    }

    // Validate key prefix
    if (!body.key.startsWith('chat-attachments/')) {
      throw new BadRequestException('Key must start with chat-attachments/');
    }

    const bucket = this.storage.internalBucket;

    if (body.operation === 'upload') {
      const url = await this.storage.getPresignedUploadUrl(bucket, body.key, {
        contentType: body.content_type,
        expiresInSeconds: 300,
      });
      return { url };
    }

    const url = await this.storage.getPresignedDownloadUrl(bucket, body.key, 300);
    return { url };
  }
}

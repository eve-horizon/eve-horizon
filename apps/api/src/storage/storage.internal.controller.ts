import { Controller, Post, HttpCode, HttpStatus, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { StorageService } from './storage.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

const PresignRequestSchema = z.object({
  key: z.string().min(1),
  operation: z.enum(['upload', 'download']),
  content_type: z.string().optional(),
});

type PresignRequest = z.infer<typeof PresignRequestSchema>;

@ApiTags('internal')
@Controller('internal/storage/chat-attachments')
@UseGuards(InternalTokenGuard)
export class StorageInternalController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get presigned URL for chat attachment upload/download (internal only)' })
  async presign(
    @Body(new ZodValidationPipe(PresignRequestSchema)) body: PresignRequest,
  ): Promise<{ url: string }> {
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

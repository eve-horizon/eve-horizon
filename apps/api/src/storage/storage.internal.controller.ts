import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  Body,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import type { Db } from '@eve/db';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { StorageService } from './storage.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

const PresignRequestSchema = z.object({
  key: z.string().min(1),
  operation: z.enum(['upload', 'download']),
  content_type: z.string().optional(),
  /** Required for downloads: the job staging the attachment. */
  job_id: z.string().min(1).optional(),
});

type PresignRequest = z.infer<typeof PresignRequestSchema>;

@ApiTags('internal')
@Controller('internal/storage/chat-attachments')
@UseGuards(InternalTokenGuard)
export class StorageInternalController {
  constructor(
    private readonly storage: StorageService,
    @Inject('DB') private readonly db: Db,
  ) {}

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
    if (body.key.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new BadRequestException('Key must not contain dot segments');
    }

    // Download keys come from job hints (chat_files): presign only an
    // attachment under the org of the job that stages it.
    if (body.operation === 'download') {
      const orgId = body.job_id ? await this.jobOrgId(body.job_id) : null;
      if (!orgId || !body.key.startsWith(`chat-attachments/${orgId}/`)) {
        throw new ForbiddenException('Attachment is not in the job\'s org');
      }
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

  private async jobOrgId(jobId: string): Promise<string | null> {
    const [row] = await this.db<Array<{ org_id: string }>>`
      SELECT p.org_id FROM jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = ${jobId} LIMIT 1
    `;
    return row?.org_id ?? null;
  }
}

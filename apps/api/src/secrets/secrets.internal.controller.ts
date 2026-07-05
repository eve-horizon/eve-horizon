import { Controller, Post, Patch, Param, HttpCode, HttpStatus, Body, UseGuards, NotFoundException, BadRequestException } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SecretResolveRequestSchema, SecretResolveResponseSchema, type SecretResolveRequest, type SecretResolveResponse } from '@eve/shared';
import { z } from 'zod';
import { zodSchemaToOpenApi } from '../openapi.js';
import { Public } from '../auth/auth.decorator.js';
import { InternalTokenGuard } from '../common/internal-token.guard.js';
import { SecretsService } from './secrets.service.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

const InternalSecretUpdateSchema = z.object({ value: z.string().min(1) });
type InternalSecretUpdate = z.infer<typeof InternalSecretUpdateSchema>;

@ApiTags('internal')
@Controller('internal/projects/:project_id/secrets')
@UseGuards(InternalTokenGuard)
export class SecretsInternalController {
  constructor(private readonly secretsService: SecretsService) {}

  @Public()
  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve secrets for a project (internal only)' })
  @ApiBody({ schema: zodSchemaToOpenApi(SecretResolveRequestSchema, 'SecretResolveRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretResolveResponseSchema, 'SecretResolveResponse') })
  async resolve(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SecretResolveRequestSchema)) body: SecretResolveRequest,
  ): Promise<SecretResolveResponse> {
    if (body.project_id !== projectId) {
      throw new BadRequestException('project_id mismatch');
    }

    const resolved = await this.secretsService.resolveForProject(projectId, body.user_id);
    return { data: resolved };
  }
}

@ApiTags('internal')
@Controller('internal/secrets')
@UseGuards(InternalTokenGuard)
export class SecretsWriteBackController {
  constructor(private readonly secretsService: SecretsService) {}

  @Public()
  @Patch(':scope_type/:scope_id/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update a secret value by scope (internal only, update-only, no create)' })
  @ApiBody({ schema: zodSchemaToOpenApi(InternalSecretUpdateSchema, 'InternalSecretUpdate') })
  @ApiOkResponse({ description: 'No content on success' })
  async updateSecret(
    @Param('scope_type') scopeType: string,
    @Param('scope_id') scopeId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(InternalSecretUpdateSchema)) body: InternalSecretUpdate,
  ): Promise<void> {
    if (!['user', 'org', 'project'].includes(scopeType)) {
      throw new NotFoundException('Unknown scope type');
    }

    const updated = await this.secretsService.updateIfExists(scopeType as 'user' | 'org' | 'project', scopeId, key, body.value);
    if (!updated) {
      throw new NotFoundException(`Secret ${key} not found`);
    }
  }
}

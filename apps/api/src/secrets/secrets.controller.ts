import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UsePipes,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CreateSecretRequestSchema,
  UpdateSecretRequestSchema,
  SecretResponseSchema,
  SecretMaskedResponseSchema,
  SecretListResponseSchema,
  SecretValidationResultSchema,
  SecretValidateRequestSchema,
  SecretEnsureRequestSchema,
  SecretEnsureResponseSchema,
  SecretExportRequestSchema,
  SecretExportResponseSchema,
  type CreateSecretRequest,
  type UpdateSecretRequest,
  type SecretListResponse,
  type SecretMaskedResponse,
  type SecretResponse,
  type SecretValidationResult,
  type SecretValidateRequest,
  type SecretEnsureRequest,
  type SecretEnsureResponse,
  type SecretExportRequest,
  type SecretExportResponse,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { SecretsService } from './secrets.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('projects/:project_id/secrets')
export class ProjectSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @RequirePermission('secrets:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create project secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateSecretRequestSchema, 'CreateSecretRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async create(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('project', projectId, body);
  }

  @RequirePermission('secrets:read')
  @Get()
  @ApiOperation({ summary: 'List project secrets (metadata only)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretListResponseSchema, 'SecretListResponse') })
  async list(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('project', projectId, { limit, offset });
  }

  @RequirePermission('secrets:read')
  @Get(':key')
  @ApiOperation({ summary: 'Show project secret (masked)' })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretMaskedResponseSchema, 'SecretMaskedResponse') })
  async show(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('project', projectId, key);
  }

  @RequirePermission('secrets:write')
  @Patch(':key')
  @ApiOperation({ summary: 'Update project secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateSecretRequestSchema, 'UpdateSecretRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async update(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('project', projectId, key, body);
  }

  @RequirePermission('secrets:admin')
  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete project secret' })
  async remove(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.secretsService.delete('project', projectId, key);
  }

  @RequirePermission('secrets:read')
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate required secrets for latest manifest' })
  @ApiBody({ schema: zodSchemaToOpenApi(SecretValidateRequestSchema, 'SecretValidateRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretValidationResultSchema, 'SecretValidationResult') })
  async validate(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SecretValidateRequestSchema)) body: SecretValidateRequest,
  ): Promise<SecretValidationResult> {
    if (body.manifest_yaml) {
      return this.secretsService.validateManifestSecrets(projectId, body.manifest_yaml);
    }
    if (body.keys && body.keys.length > 0) {
      return this.secretsService.validateRequiredSecrets(projectId, body.keys);
    }
    return this.secretsService.validateLatestManifestSecrets(projectId);
  }

  @RequirePermission('secrets:write')
  @Post('ensure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ensure safe secrets exist for a project' })
  @ApiBody({ schema: zodSchemaToOpenApi(SecretEnsureRequestSchema, 'SecretEnsureRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretEnsureResponseSchema, 'SecretEnsureResponse') })
  async ensure(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SecretEnsureRequestSchema)) body: SecretEnsureRequest,
  ): Promise<SecretEnsureResponse> {
    return this.secretsService.ensureSafeSecrets(projectId, body.keys);
  }

  @RequirePermission('secrets:read')
  @Post('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Export safe secrets for external configuration' })
  @ApiBody({ schema: zodSchemaToOpenApi(SecretExportRequestSchema, 'SecretExportRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretExportResponseSchema, 'SecretExportResponse') })
  async exportSecrets(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SecretExportRequestSchema)) body: SecretExportRequest,
  ): Promise<SecretExportResponse> {
    const data = await this.secretsService.exportSafeSecrets(projectId, body.keys);
    return { data };
  }

}

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('orgs/:org_id/secrets')
export class OrgSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @RequirePermission('secrets:write')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create org secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateSecretRequestSchema, 'CreateSecretRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('org', orgId, body);
  }

  @RequirePermission('secrets:read')
  @Get()
  @ApiOperation({ summary: 'List org secrets (metadata only)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretListResponseSchema, 'SecretListResponse') })
  async list(
    @Param('org_id') orgId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('org', orgId, { limit, offset });
  }

  @RequirePermission('secrets:read')
  @Get(':key')
  @ApiOperation({ summary: 'Show org secret (masked)' })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretMaskedResponseSchema, 'SecretMaskedResponse') })
  async show(
    @Param('org_id') orgId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('org', orgId, key);
  }

  @RequirePermission('secrets:write')
  @Patch(':key')
  @ApiOperation({ summary: 'Update org secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateSecretRequestSchema, 'UpdateSecretRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async update(
    @Param('org_id') orgId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('org', orgId, key, body);
  }

  @RequirePermission('secrets:admin')
  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete org secret' })
  async remove(
    @Param('org_id') orgId: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.secretsService.delete('org', orgId, key);
  }
}

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('system/secrets')
export class SystemSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @RequirePermission('system:admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create system secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateSecretRequestSchema, 'CreateSecretRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async create(
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('system', 'system', body);
  }

  @RequirePermission('system:admin')
  @Get()
  @ApiOperation({ summary: 'List system secrets (metadata only)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretListResponseSchema, 'SecretListResponse') })
  async list(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('system', 'system', { limit, offset });
  }

  @RequirePermission('system:admin')
  @Get(':key')
  @ApiOperation({ summary: 'Show system secret (masked)' })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretMaskedResponseSchema, 'SecretMaskedResponse') })
  async show(
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('system', 'system', key);
  }

  @RequirePermission('system:admin')
  @Patch(':key')
  @ApiOperation({ summary: 'Update system secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateSecretRequestSchema, 'UpdateSecretRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async update(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('system', 'system', key, body);
  }

  @RequirePermission('system:admin')
  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete system secret' })
  async remove(
    @Param('key') key: string,
  ): Promise<void> {
    await this.secretsService.delete('system', 'system', key);
  }
}

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('users/:user_id/secrets')
export class UserSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create user secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(CreateSecretRequestSchema, 'CreateSecretRequest') })
  @ApiCreatedResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async create(
    @Param('user_id') userId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('user', userId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List user secrets (metadata only)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretListResponseSchema, 'SecretListResponse') })
  async list(
    @Param('user_id') userId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('user', userId, { limit, offset });
  }

  @Get(':key')
  @ApiOperation({ summary: 'Show user secret (masked)' })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretMaskedResponseSchema, 'SecretMaskedResponse') })
  async show(
    @Param('user_id') userId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('user', userId, key);
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Update user secret' })
  @ApiBody({ schema: zodSchemaToOpenApi(UpdateSecretRequestSchema, 'UpdateSecretRequest') })
  @ApiOkResponse({ schema: zodSchemaToOpenApi(SecretResponseSchema, 'SecretResponse') })
  async update(
    @Param('user_id') userId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('user', userId, key, body);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete user secret' })
  async remove(
    @Param('user_id') userId: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.secretsService.delete('user', userId, key);
  }
}

import {
  Controller,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
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
import { Endpoint } from '../common/endpoint.decorator.js';
import { SecretsService } from './secrets.service.js';
import { CurrentUser } from '../common/request-decorators.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('secrets')
@ApiBearerAuth()
@Controller('projects/:project_id/secrets')
export class ProjectSecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Endpoint({
    method: 'POST',
    permission: 'secrets:write',
    status: HttpStatus.CREATED,
    summary: 'Create project secret',
    body: CreateSecretRequestSchema,
    bodyName: 'CreateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async create(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('project', projectId, body);
  }

  @Endpoint({
    method: 'GET',
    permission: 'secrets:read',
    summary: 'List project secrets (metadata only)',
    extraDecorators: [
      ApiQuery({ name: 'limit', required: false }),
      ApiQuery({ name: 'offset', required: false }),
    ],
    response: SecretListResponseSchema,
    responseName: 'SecretListResponse',
  })
  async list(
    @Param('project_id') projectId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('project', projectId, { limit, offset });
  }

  @Endpoint({
    method: 'GET',
    path: ':key',
    permission: 'secrets:read',
    summary: 'Show project secret (masked)',
    response: SecretMaskedResponseSchema,
    responseName: 'SecretMaskedResponse',
  })
  async show(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('project', projectId, key);
  }

  @Endpoint({
    method: 'PATCH',
    path: ':key',
    permission: 'secrets:write',
    summary: 'Update project secret',
    body: UpdateSecretRequestSchema,
    bodyName: 'UpdateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async update(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('project', projectId, key, body);
  }

  @Endpoint({
    method: 'DELETE',
    path: ':key',
    permission: 'secrets:admin',
    status: HttpStatus.NO_CONTENT,
    summary: 'Delete project secret',
  })
  async remove(
    @Param('project_id') projectId: string,
    @Param('key') key: string,
  ): Promise<void> {
    await this.secretsService.delete('project', projectId, key);
  }

  @Endpoint({
    method: 'POST',
    path: 'validate',
    permission: 'secrets:read',
    status: HttpStatus.OK,
    summary: 'Validate required secrets for latest manifest',
    body: SecretValidateRequestSchema,
    bodyName: 'SecretValidateRequest',
    response: SecretValidationResultSchema,
    responseName: 'SecretValidationResult',
  })
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

  @Endpoint({
    method: 'POST',
    path: 'ensure',
    permission: 'secrets:write',
    status: HttpStatus.OK,
    summary: 'Ensure safe secrets exist for a project',
    body: SecretEnsureRequestSchema,
    bodyName: 'SecretEnsureRequest',
    response: SecretEnsureResponseSchema,
    responseName: 'SecretEnsureResponse',
  })
  async ensure(
    @Param('project_id') projectId: string,
    @Body(new ZodValidationPipe(SecretEnsureRequestSchema)) body: SecretEnsureRequest,
  ): Promise<SecretEnsureResponse> {
    return this.secretsService.ensureSafeSecrets(projectId, body.keys);
  }

  @Endpoint({
    method: 'POST',
    path: 'export',
    permission: 'secrets:read',
    status: HttpStatus.OK,
    summary: 'Export safe secrets for external configuration',
    body: SecretExportRequestSchema,
    bodyName: 'SecretExportRequest',
    response: SecretExportResponseSchema,
    responseName: 'SecretExportResponse',
  })
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

  @Endpoint({
    method: 'POST',
    permission: 'secrets:write',
    status: HttpStatus.CREATED,
    summary: 'Create org secret',
    body: CreateSecretRequestSchema,
    bodyName: 'CreateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('org', orgId, body);
  }

  @Endpoint({
    method: 'GET',
    permission: 'secrets:read',
    summary: 'List org secrets (metadata only)',
    extraDecorators: [
      ApiQuery({ name: 'limit', required: false }),
      ApiQuery({ name: 'offset', required: false }),
    ],
    response: SecretListResponseSchema,
    responseName: 'SecretListResponse',
  })
  async list(
    @Param('org_id') orgId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('org', orgId, { limit, offset });
  }

  @Endpoint({
    method: 'GET',
    path: ':key',
    permission: 'secrets:read',
    summary: 'Show org secret (masked)',
    response: SecretMaskedResponseSchema,
    responseName: 'SecretMaskedResponse',
  })
  async show(
    @Param('org_id') orgId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('org', orgId, key);
  }

  @Endpoint({
    method: 'PATCH',
    path: ':key',
    permission: 'secrets:write',
    summary: 'Update org secret',
    body: UpdateSecretRequestSchema,
    bodyName: 'UpdateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async update(
    @Param('org_id') orgId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('org', orgId, key, body);
  }

  @Endpoint({
    method: 'DELETE',
    path: ':key',
    permission: 'secrets:admin',
    status: HttpStatus.NO_CONTENT,
    summary: 'Delete org secret',
  })
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

  @Endpoint({
    method: 'POST',
    permission: 'system:admin',
    status: HttpStatus.CREATED,
    summary: 'Create system secret',
    body: CreateSecretRequestSchema,
    bodyName: 'CreateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async create(
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.create('system', 'system', body);
  }

  @Endpoint({
    method: 'GET',
    permission: 'system:admin',
    summary: 'List system secrets (metadata only)',
    extraDecorators: [
      ApiQuery({ name: 'limit', required: false }),
      ApiQuery({ name: 'offset', required: false }),
    ],
    response: SecretListResponseSchema,
    responseName: 'SecretListResponse',
  })
  async list(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    return this.secretsService.list('system', 'system', { limit, offset });
  }

  @Endpoint({
    method: 'GET',
    path: ':key',
    permission: 'system:admin',
    summary: 'Show system secret (masked)',
    response: SecretMaskedResponseSchema,
    responseName: 'SecretMaskedResponse',
  })
  async show(
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    return this.secretsService.showMasked('system', 'system', key);
  }

  @Endpoint({
    method: 'PATCH',
    path: ':key',
    permission: 'system:admin',
    summary: 'Update system secret',
    body: UpdateSecretRequestSchema,
    bodyName: 'UpdateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async update(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    return this.secretsService.update('system', 'system', key, body);
  }

  @Endpoint({
    method: 'DELETE',
    path: ':key',
    permission: 'system:admin',
    status: HttpStatus.NO_CONTENT,
    summary: 'Delete system secret',
  })
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

  /**
   * User secrets are private to the owning user. A caller may only address their own
   * user_id unless they are a system admin. Without this check any authenticated user
   * could read/write/delete another user's secrets via the :user_id path param.
   */
  private assertSelfOrAdmin(
    caller: AuthUser | undefined,
    userId: string,
  ): void {
    if (!caller?.user_id) {
      throw new ForbiddenException('Authentication required');
    }
    if (caller.is_admin || caller.user_id === userId) {
      return;
    }
    throw new ForbiddenException('Cannot access another user\'s secrets');
  }

  @Endpoint({
    method: 'POST',
    status: HttpStatus.CREATED,
    summary: 'Create user secret',
    body: CreateSecretRequestSchema,
    bodyName: 'CreateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async create(
    @CurrentUser() caller: AuthUser | undefined,
    @Param('user_id') userId: string,
    @Body(new ZodValidationPipe(CreateSecretRequestSchema)) body: CreateSecretRequest,
  ): Promise<SecretResponse> {
    this.assertSelfOrAdmin(caller, userId);
    return this.secretsService.create('user', userId, body);
  }

  @Endpoint({
    method: 'GET',
    summary: 'List user secrets (metadata only)',
    extraDecorators: [
      ApiQuery({ name: 'limit', required: false }),
      ApiQuery({ name: 'offset', required: false }),
    ],
    response: SecretListResponseSchema,
    responseName: 'SecretListResponse',
  })
  async list(
    @CurrentUser() caller: AuthUser | undefined,
    @Param('user_id') userId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ): Promise<SecretListResponse> {
    this.assertSelfOrAdmin(caller, userId);
    return this.secretsService.list('user', userId, { limit, offset });
  }

  @Endpoint({
    method: 'GET',
    path: ':key',
    summary: 'Show user secret (masked)',
    response: SecretMaskedResponseSchema,
    responseName: 'SecretMaskedResponse',
  })
  async show(
    @CurrentUser() caller: AuthUser | undefined,
    @Param('user_id') userId: string,
    @Param('key') key: string,
  ): Promise<SecretMaskedResponse> {
    this.assertSelfOrAdmin(caller, userId);
    return this.secretsService.showMasked('user', userId, key);
  }

  @Endpoint({
    method: 'PATCH',
    path: ':key',
    summary: 'Update user secret',
    body: UpdateSecretRequestSchema,
    bodyName: 'UpdateSecretRequest',
    response: SecretResponseSchema,
    responseName: 'SecretResponse',
  })
  async update(
    @CurrentUser() caller: AuthUser | undefined,
    @Param('user_id') userId: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSecretRequestSchema)) body: UpdateSecretRequest,
  ): Promise<SecretResponse> {
    this.assertSelfOrAdmin(caller, userId);
    return this.secretsService.update('user', userId, key, body);
  }

  @Endpoint({
    method: 'DELETE',
    path: ':key',
    status: HttpStatus.NO_CONTENT,
    summary: 'Delete user secret',
  })
  async remove(
    @CurrentUser() caller: AuthUser | undefined,
    @Param('user_id') userId: string,
    @Param('key') key: string,
  ): Promise<void> {
    this.assertSelfOrAdmin(caller, userId);
    await this.secretsService.delete('user', userId, key);
  }
}

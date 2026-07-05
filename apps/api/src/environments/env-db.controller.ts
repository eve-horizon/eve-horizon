import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Headers,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  DbSchemaResponseSchema,
  DbRlsResponseSchema,
  DbExtensionsResponseSchema,
  DbSqlRequestSchema,
  DbSqlResponseSchema,
  DbMigrateRequestSchema,
  DbMigrateResponseSchema,
  DbMigrationsResponseSchema,
  DbResetRequestSchema,
  DbResetResponseSchema,
  type DbSchemaResponse,
  type DbRlsResponse,
  type DbExtensionsResponse,
  type DbSqlRequest,
  type DbSqlResponse,
  type DbMigrateRequest,
  type DbMigrateResponse,
  type DbMigrationsResponse,
  type DbResetRequest,
  type DbResetResponse,
} from '@eve/shared';
import { zodSchemaToOpenApi } from '../openapi.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { EnvDbService } from './env-db.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { RequirePermission } from '../auth/permission.decorator.js';
import { ScopedAccessService } from '../auth/scoped-access.service.js';
import { CorrelationId, CurrentUser } from '../common/request-decorators.js';

@ApiTags('env-db')
@ApiBearerAuth()
@Controller('projects/:id/envs/:name')
export class EnvDbController {
  constructor(
    private readonly envDbService: EnvDbService,
    private readonly authService: AuthService,
    private readonly scopedAccess: ScopedAccessService,
  ) {}

  private parseJobToken(jobToken?: string): { permissions?: string[]; tokenProvided: boolean } {
    if (!jobToken) {
      return { permissions: undefined, tokenProvided: false };
    }

    const payload = this.authService.verifyJobToken(jobToken);
    return { permissions: payload.permissions, tokenProvided: true };
  }

  private resolveEffectivePermissions(user: AuthUser | undefined, jobToken?: string): {
    permissions?: string[];
    tokenProvided: boolean;
  } {
    const parsed = this.parseJobToken(jobToken);
    if (parsed.permissions && parsed.permissions.length > 0) {
      return parsed;
    }
    return {
      permissions: user?.permissions,
      tokenProvided: parsed.tokenProvided,
    };
  }

  private ensureWriteAllowed(options: {
    allowWrite: boolean;
    tokenProvided: boolean;
    permissions?: string[];
    user?: { is_admin?: boolean; role?: string };
  }): void {
    if (!options.allowWrite || !this.authService.isEnabled()) {
      return;
    }

    if (options.tokenProvided) {
      // Accept both new permission name and legacy scope name
      if (!options.permissions?.includes('envdb:write') && !options.permissions?.includes('db.write')) {
        throw new ForbiddenException('Job token missing envdb:write permission');
      }
      return;
    }

    const role = options.user?.role;
    if (options.user?.is_admin || role === 'owner' || role === 'admin' || role === 'system_admin') {
      return;
    }

    if (options.permissions?.includes('envdb:write') || options.permissions?.includes('db.write')) {
      return;
    }

    throw new ForbiddenException('Write access requires admin role or job token with envdb:write permission');
  }

  @RequirePermission('envdb:read')
  @Get('db/schema')
  @ApiOperation({ summary: 'Get environment DB schema' })
  @ApiOkResponse({
    description: 'DB schema',
    schema: zodSchemaToOpenApi(DbSchemaResponseSchema, 'DbSchemaResponse'),
  })
  async schema(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbSchemaResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:read',
      user: caller,
      request_id: correlationId,
    });

    const { permissions } = this.resolveEffectivePermissions(caller, jobToken);
    return this.envDbService.getSchema(projectId, envName, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }

  @RequirePermission('envdb:read')
  @Get('db/rls')
  @ApiOperation({ summary: 'Get environment DB RLS policies' })
  @ApiOkResponse({
    description: 'DB RLS policies',
    schema: zodSchemaToOpenApi(DbRlsResponseSchema, 'DbRlsResponse'),
  })
  async rls(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbRlsResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:read',
      user: caller,
      request_id: correlationId,
    });

    const { permissions } = this.resolveEffectivePermissions(caller, jobToken);
    return this.envDbService.getRls(projectId, envName, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }

  @RequirePermission('envdb:read')
  @Get('db/extensions')
  @ApiOperation({ summary: 'List environment DB extensions' })
  @ApiOkResponse({
    description: 'DB extensions',
    schema: zodSchemaToOpenApi(DbExtensionsResponseSchema, 'DbExtensionsResponse'),
  })
  async extensions(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbExtensionsResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:read',
      user: caller,
      request_id: correlationId,
    });

    const { permissions } = this.resolveEffectivePermissions(caller, jobToken);
    return this.envDbService.getExtensions(projectId, envName, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }

  @RequirePermission('envdb:write')
  @Post('db/sql')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute SQL against environment DB' })
  @ApiBody({
    schema: zodSchemaToOpenApi(DbSqlRequestSchema, 'DbSqlRequest'),
  })
  @ApiOkResponse({
    description: 'SQL result',
    schema: zodSchemaToOpenApi(DbSqlResponseSchema, 'DbSqlResponse'),
  })
  async sql(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(DbSqlRequestSchema)) body: DbSqlRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbSqlResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:write',
      user: caller,
      request_id: correlationId,
    });

    const allowWrite = body.allow_write ?? false;
    const { permissions, tokenProvided } = this.resolveEffectivePermissions(caller, jobToken);

    this.ensureWriteAllowed({
      allowWrite,
      tokenProvided,
      permissions,
      user: caller,
    });

    return this.envDbService.executeSql(
      projectId,
      envName,
      body.sql,
      body.params,
      allowWrite,
      {
        user_id: caller?.user_id,
        project_id: projectId,
        env_name: envName,
        principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
        permissions,
      },
    );
  }

  @RequirePermission('envdb:write')
  @Post(['db/migrate', 'migrate'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply migrations to environment DB' })
  @ApiBody({
    schema: zodSchemaToOpenApi(DbMigrateRequestSchema, 'DbMigrateRequest'),
  })
  @ApiOkResponse({
    description: 'Applied migrations',
    schema: zodSchemaToOpenApi(DbMigrateResponseSchema, 'DbMigrateResponse'),
  })
  async migrate(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(DbMigrateRequestSchema)) body: DbMigrateRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbMigrateResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:write',
      user: caller,
      request_id: correlationId,
    });

    const { permissions, tokenProvided } = this.resolveEffectivePermissions(caller, jobToken);
    this.ensureWriteAllowed({
      allowWrite: true,
      tokenProvided,
      permissions,
      user: caller,
    });

    return this.envDbService.migrate(projectId, envName, body.migrations, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }

  @RequirePermission('envdb:read')
  @Get(['db/migrations', 'migrations'])
  @ApiOperation({ summary: 'List applied migrations for environment DB' })
  @ApiOkResponse({
    description: 'Applied migrations',
    schema: zodSchemaToOpenApi(DbMigrationsResponseSchema, 'DbMigrationsResponse'),
  })
  async listMigrations(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbMigrationsResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:read',
      user: caller,
      request_id: correlationId,
    });

    const { permissions } = this.resolveEffectivePermissions(caller, jobToken);
    return this.envDbService.listMigrations(projectId, envName, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }

  @RequirePermission('envdb:write')
  @Post('db/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset environment DB schema and optionally re-apply migrations' })
  @ApiBody({
    schema: zodSchemaToOpenApi(DbResetRequestSchema, 'DbResetRequest'),
  })
  @ApiOkResponse({
    description: 'Reset completed',
    schema: zodSchemaToOpenApi(DbResetResponseSchema, 'DbResetResponse'),
  })
  async reset(
    @Param('id') projectId: string,
    @Param('name') envName: string,
    @Body(new ZodValidationPipe(DbResetRequestSchema)) body: DbResetRequest,
    @CurrentUser() caller: AuthUser | undefined,
    @CorrelationId() correlationId: string | undefined,
    @Headers('eve-job-token') jobToken?: string,
  ): Promise<DbResetResponse> {
    const orgId = await this.envDbService.resolveOrgIdForProject(projectId);
    await this.scopedAccess.assert({
      org_id: orgId,
      project_id: projectId,
      permission: 'envdb:write',
      user: caller,
      request_id: correlationId,
    });

    const { permissions, tokenProvided } = this.resolveEffectivePermissions(caller, jobToken);
    this.ensureWriteAllowed({
      allowWrite: true,
      tokenProvided,
      permissions,
      user: caller,
    });

    return this.envDbService.reset(projectId, envName, body, {
      user_id: caller?.user_id,
      project_id: projectId,
      env_name: envName,
      principal_type: caller?.is_service_principal ? 'service_principal' : 'user',
      permissions,
    });
  }
}

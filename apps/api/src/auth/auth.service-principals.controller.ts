import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { createHash } from 'crypto';
import {
  type Db,
  servicePrincipalQueries,
  type ServicePrincipal,
} from '@eve/db';
import {
  generateServicePrincipalId,
  CreateServicePrincipalRequestSchema,
  MintServicePrincipalTokenRequestSchema,
  type CreateServicePrincipalRequest,
  type MintServicePrincipalTokenRequest,
  type ServicePrincipalResponse,
  type ServicePrincipalListResponse,
  type ServicePrincipalTokenListResponse,
  type MintServicePrincipalTokenResponse,
  ServicePrincipalListResponseSchema,
  ServicePrincipalTokenListResponseSchema,
} from '@eve/shared';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { RequirePermission } from './permission.decorator.js';
import { RbacService } from './rbac.service.js';
import { AuthService, type AuthUser } from './auth.service.js';
import { allPermissions } from './permissions.js';
import { zodSchemaToOpenApi } from '../openapi.js';
import { CurrentUser } from '../common/request-decorators.js';

function toServicePrincipalResponse(sp: ServicePrincipal): ServicePrincipalResponse {
  return {
    id: sp.id,
    org_id: sp.org_id,
    name: sp.name,
    description: sp.description,
    created_by: sp.created_by,
    created_at: sp.created_at.toISOString(),
    updated_at: sp.updated_at.toISOString(),
  };
}

@ApiTags('service-principals')
@ApiBearerAuth()
@Controller('orgs/:org_id/service-principals')
export class ServicePrincipalsController {
  private readonly spQueries: ReturnType<typeof servicePrincipalQueries>;

  constructor(
    @Inject('DB') private readonly db: Db,
    private readonly authService: AuthService,
    private readonly rbacService: RbacService,
  ) {
    this.spQueries = servicePrincipalQueries(db);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Create a service principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  async create(
    @Param('org_id') orgId: string,
    @Body(new ZodValidationPipe(CreateServicePrincipalRequestSchema)) body: CreateServicePrincipalRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<ServicePrincipalResponse> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const id = generateServicePrincipalId();
    const sp = await this.spQueries.createServicePrincipal(
      id,
      orgId,
      body.name,
      body.description ?? null,
      user.is_service_principal ? null : user.user_id,
    );

    return toServicePrincipalResponse(sp);
  }

  @Get()
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List service principals for an org' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiOkResponse({
    description: 'Service principal list',
    schema: zodSchemaToOpenApi(ServicePrincipalListResponseSchema, 'ServicePrincipalListResponse'),
  })
  async list(
    @Param('org_id') orgId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<ServicePrincipalListResponse> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const principals = await this.spQueries.listServicePrincipals(orgId);
    return { data: principals.map(toServicePrincipalResponse) };
  }

  @Get(':sp_id')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'Get a service principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'sp_id', description: 'Service principal ID' })
  async get(
    @Param('org_id') orgId: string,
    @Param('sp_id') spId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<ServicePrincipalResponse> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    const sp = await this.spQueries.getServicePrincipal(orgId, spId);
    if (!sp) {
      throw new NotFoundException('Service principal not found');
    }

    return toServicePrincipalResponse(sp);
  }

  @Delete(':sp_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Delete a service principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'sp_id', description: 'Service principal ID' })
  async delete(
    @Param('org_id') orgId: string,
    @Param('sp_id') spId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<void> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    const deleted = await this.spQueries.deleteServicePrincipal(orgId, spId);
    if (!deleted) {
      throw new NotFoundException('Service principal not found');
    }
  }

  @Post(':sp_id/tokens')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Mint a token for a service principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'sp_id', description: 'Service principal ID' })
  async mintToken(
    @Param('org_id') orgId: string,
    @Param('sp_id') spId: string,
    @Body(new ZodValidationPipe(MintServicePrincipalTokenRequestSchema)) body: MintServicePrincipalTokenRequest,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<MintServicePrincipalTokenResponse> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    // Verify the service principal exists and belongs to this org
    const sp = await this.spQueries.getServicePrincipal(orgId, spId);
    if (!sp) {
      throw new NotFoundException('Service principal not found');
    }

    // Validate that requested scopes are from the known permission catalog
    const knownPermissions = new Set(allPermissions());
    const invalidScopes = body.scopes.filter((s) => !knownPermissions.has(s as any));
    if (invalidScopes.length > 0) {
      throw new BadRequestException(`Unknown scopes: ${invalidScopes.join(', ')}`);
    }

    // Block system:* permissions unless caller is a system admin
    const systemScopes = body.scopes.filter((s) => s.startsWith('system:'));
    if (systemScopes.length > 0 && !user.is_admin) {
      throw new BadRequestException('Only system admins can grant system:* scopes');
    }

    // Mint the JWT
    const { tokenId, accessToken, expiresAt } = this.authService.mintServicePrincipalToken({
      principalId: sp.id,
      orgId,
      scopes: body.scopes,
      ttlHours: body.ttl_hours,
    });

    // Store the token hash in DB
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    await this.spQueries.createToken(
      tokenId,
      sp.id,
      tokenHash,
      body.scopes,
      expiresAt,
    );

    return {
      token_id: tokenId,
      access_token: accessToken,
      scopes: body.scopes,
      expires_at: expiresAt.toISOString(),
    };
  }

  @Get(':sp_id/tokens')
  @RequirePermission('orgs:read')
  @ApiOperation({ summary: 'List tokens for a service principal' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'sp_id', description: 'Service principal ID' })
  @ApiOkResponse({
    description: 'Service principal token list',
    schema: zodSchemaToOpenApi(ServicePrincipalTokenListResponseSchema, 'ServicePrincipalTokenListResponse'),
  })
  async listTokens(
    @Param('org_id') orgId: string,
    @Param('sp_id') spId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<ServicePrincipalTokenListResponse> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin && !user.is_service_principal) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'member');
    }

    // Verify the service principal exists and belongs to this org
    const sp = await this.spQueries.getServicePrincipal(orgId, spId);
    if (!sp) {
      throw new NotFoundException('Service principal not found');
    }

    const tokens = await this.spQueries.listTokens(sp.id);
    return {
      data: tokens.map((t) => ({
        id: t.id,
        principal_id: t.principal_id,
        scopes: t.scopes,
        expires_at: t.expires_at.toISOString(),
        last_used_at: t.last_used_at?.toISOString() ?? null,
        created_at: t.created_at.toISOString(),
      })),
    };
  }

  @Delete(':sp_id/tokens/:token_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orgs:admin')
  @ApiOperation({ summary: 'Revoke a service principal token' })
  @ApiParam({ name: 'org_id', description: 'Org ID' })
  @ApiParam({ name: 'sp_id', description: 'Service principal ID' })
  @ApiParam({ name: 'token_id', description: 'Token ID' })
  async revokeToken(
    @Param('org_id') orgId: string,
    @Param('sp_id') spId: string,
    @Param('token_id') tokenId: string,
    @CurrentUser() caller: AuthUser | undefined,
  ): Promise<void> {
    const user = caller;
    if (!user?.user_id) {
      throw new UnauthorizedException('Authorization required');
    }

    if (!user.is_admin) {
      await this.rbacService.requireOrgRole(user.user_id, orgId, 'admin');
    }

    // Verify the service principal exists and belongs to this org
    const sp = await this.spQueries.getServicePrincipal(orgId, spId);
    if (!sp) {
      throw new NotFoundException('Service principal not found');
    }

    const revoked = await this.spQueries.revokeToken(sp.id, tokenId);
    if (!revoked) {
      throw new NotFoundException('Token not found');
    }
  }
}
